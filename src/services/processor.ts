import { RunwayService } from './runway';
import { OrderService } from './order';
import { FileService } from './file';
import { UserService } from './user';
import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import pool from '../config/database';

config();

export class ProcessorService {
  private runwayService: RunwayService;
  private orderService: OrderService;
  private fileService: FileService;
  private userService: UserService;
  private bot: Telegraf;

  constructor() {
    this.runwayService = new RunwayService();
    this.orderService = new OrderService();
    this.fileService = new FileService();
    this.userService = new UserService();
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
  }

  async processOrder(orderId: string): Promise<void> {
    try {
      console.log(`Processing order: ${orderId}`);
      
      // Get order details
      const order = await this.orderService.getOrder(orderId);
      if (!order) {
        throw new Error('Order not found');
      }

      // Get user details
      const user = await this.userService.getUserById(order.user_id);
      if (!user) {
        throw new Error('User not found');
      }

      // Update order status to processing
      await this.orderService.updateOrderStatus(orderId, 'processing' as any);

      // Create videos using RunwayML with all available models - check if it's a merge order
      let generationIds: string[];
      try {
        if (order.order_type === 'merge' && order.second_file_path) {
          // Merge order - use second image as reference for transition
          generationIds = await this.runwayService.createMultipleVideosFromTwoImages(
            order.original_file_path,
            order.second_file_path,
            orderId,
            order.custom_prompt
          );
        } else {
          // Single image order - создаем генерации для всех доступных моделей
          generationIds = await this.runwayService.createMultipleVideosFromImage(
            order.original_file_path,
            orderId,
            order.custom_prompt
          );
        }

        console.log(`📊 Получено ${generationIds.length} generation IDs для заказа ${orderId}:`, generationIds);

        if (generationIds.length === 0) {
          throw new Error('Не удалось создать ни одной генерации');
        }

        // Update order with first generation ID (для обратной совместимости)
        await this.orderService.updateOrderResult(orderId, generationIds[0]);

        console.log(`👀 Начинаю мониторинг ${generationIds.length} джобов для заказа ${orderId}`);
        // Start monitoring all jobs
        this.monitorMultipleJobs(generationIds, user.telegram_id, orderId);
      } catch (error: any) {
        // Если хотя бы одна генерация создана, продолжаем мониторинг
        const jobs = await this.runwayService.getJobsByOrderId(orderId);
        if (jobs.length > 0) {
          generationIds = jobs.map(job => job.did_job_id);
          await this.orderService.updateOrderResult(orderId, generationIds[0]);
          this.monitorMultipleJobs(generationIds, user.telegram_id, orderId);
        } else {
          throw error; // Если не создано ни одной генерации, пробрасываем ошибку
        }
      }

    } catch (error: any) {
      console.error(`Error processing order ${orderId}:`, error);
      
      // Update order status to failed
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);
      
      // Notify user about error with translated message
      const order = await this.orderService.getOrder(orderId);
      if (order) {
        const user = await this.userService.getUserById(order.user_id);
        if (user) {
          // Проверяем, был ли заказ оплачен генерациями (отсутствие платежа означает оплату генерациями)
          const hasPayment = await this.orderService.hasPayment(orderId);
          if (!hasPayment) {
            await this.userService.returnGenerations(user.telegram_id, 1);
            const newBalance = await this.userService.getUserGenerations(user.telegram_id);
            await this.notifyUser(user.telegram_id, `💼 Генерация возвращена на ваш баланс.\n\nБаланс: ${newBalance} генераций`);
          }
          
          // Используем переведённое сообщение об ошибке, если оно есть
          const errorMessage = error?.message || 'Произошла ошибка при обработке. Попробуйте позже.';
          await this.notifyUser(user.telegram_id, `❌ ${errorMessage}`);
        }
      }
    }
  }

  private async monitorMultipleJobs(generationIds: string[], telegramId: number, orderId: string): Promise<void> {
    console.log(`🔍 Мониторинг ${generationIds.length} джобов для заказа ${orderId}:`, generationIds);
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    const jobStatuses: Map<string, { status?: string; videoUrl?: string; error?: string }> = new Map();
    let attempts = 0;
    let progressMessageId: number | null = null;
    let hasNotifiedUser = false;

    const checkStatus = async () => {
      try {
        attempts++;

        // Проверяем статус всех джобов
        const statusPromises = generationIds.map(async (generationId) => {
          try {
            const jobStatus = await this.runwayService.checkJobStatus(generationId);
            return { generationId, jobStatus };
          } catch (error) {
            console.error(`Error checking status for ${generationId}:`, error);
            return { generationId, jobStatus: null };
          }
        });

        const statusResults = await Promise.all(statusPromises);

        let completedCount = 0;
        let failedCount = 0;
        let processingCount = 0;
        let totalProgress = 0;

        for (const { generationId, jobStatus } of statusResults) {
          if (!jobStatus) continue;

          const status = jobStatus.status;
          jobStatuses.set(generationId, {
            status,
            videoUrl: status === 'SUCCEEDED' ? jobStatus.output?.[0] : undefined,
            error: status === 'FAILED' ? (jobStatus.failure || jobStatus.error || 'Job failed') : undefined
          });

          if (status === 'SUCCEEDED') {
            completedCount++;
            // Обновляем статус джоба в БД
            await this.runwayService.updateJobStatus(generationId, 'completed' as any, jobStatus.output?.[0]);
          } else if (status === 'FAILED') {
            failedCount++;
            let errorMessage = jobStatus.failure || jobStatus.error || 'Job failed';
            if ((jobStatus as any).failureCode) {
              errorMessage = `${errorMessage}|failureCode:${(jobStatus as any).failureCode}`;
            }
            await this.runwayService.updateJobStatus(generationId, 'failed' as any, undefined, errorMessage);
          } else {
            processingCount++;
            if (jobStatus.progress !== undefined) {
              totalProgress += jobStatus.progress;
            }
          }
        }

        // Проверяем, завершены ли все джобы (успешно или с ошибкой)
        const allFinished = completedCount + failedCount === generationIds.length;

        if (allFinished && !hasNotifiedUser) {
          hasNotifiedUser = true;
          
          // Собираем все успешные результаты
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            if (jobInfo?.videoUrl) {
              const job = await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            // Все джобы провалились
            await this.handleAllJobsFailed(telegramId, orderId);
          }
        } else if (!allFinished && attempts < maxAttempts) {
          // Обновляем прогресс
          const avgProgress = processingCount > 0 ? Math.round((totalProgress / processingCount) * 100) : 0;
          const progressBar = this.createProgressBar(avgProgress);
          const progressMessage = `🔄 Обработка видео...\n\n${progressBar} ${avgProgress}%`;

          if (progressMessageId) {
            try {
              await this.bot.telegram.editMessageText(
                telegramId,
                progressMessageId,
                undefined,
                progressMessage
              );
            } catch (error) {
              const message = await this.bot.telegram.sendMessage(telegramId, progressMessage);
              if (message && 'message_id' in message) {
                progressMessageId = (message as any).message_id;
              }
            }
          } else {
            const message = await this.bot.telegram.sendMessage(telegramId, progressMessage);
            if (message && 'message_id' in message) {
              progressMessageId = (message as any).message_id;
            }
          }

          setTimeout(checkStatus, 5000);
        } else if (attempts >= maxAttempts && !hasNotifiedUser) {
          hasNotifiedUser = true;
          // Таймаут - отправляем то, что готово
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            if (jobInfo?.videoUrl) {
              const job = await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            await this.handleJobTimeout(generationIds[0], telegramId, orderId);
          }
        }
      } catch (error) {
        console.error(`Error monitoring multiple jobs for order ${orderId}:`, error);
        
        if (attempts >= maxAttempts && !hasNotifiedUser) {
          hasNotifiedUser = true;
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            if (jobInfo?.videoUrl) {
              const job = await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            await this.handleAllJobsFailed(telegramId, orderId);
          }
        } else if (!hasNotifiedUser) {
          setTimeout(checkStatus, 5000);
        }
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 5000);
  }

  private async monitorJob(generationId: string, telegramId: number, orderId: string): Promise<void> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;
    let progressMessageId: number | null = null; // Сохраняем ID сообщения для редактирования

    const checkStatus = async () => {
      try {
        attempts++;
        
        const jobStatus = await this.runwayService.checkJobStatus(generationId);
        
        if (jobStatus.status === 'SUCCEEDED') {
          // Job completed successfully
          await this.handleJobSuccess(generationId, telegramId, orderId, jobStatus.output[0]);
        } else if (jobStatus.status === 'FAILED') {
          // Job failed - учитываем failureCode для специфичных ошибок
          let errorMessage = jobStatus.failure || jobStatus.error || 'Job failed';
          
          // Если есть failureCode, добавляем его к сообщению об ошибке для лучшей обработки
          if ((jobStatus as any).failureCode) {
            errorMessage = `${errorMessage}|failureCode:${(jobStatus as any).failureCode}`;
          }
          
          await this.handleJobFailure(generationId, telegramId, orderId, errorMessage);
        } else if (attempts >= maxAttempts) {
          // Timeout
          await this.handleJobTimeout(generationId, telegramId, orderId);
        } else {
          // Still processing, update progress message
          if (jobStatus.progress !== undefined) {
            const progressPercent = Math.round(jobStatus.progress * 100);
            const progressBar = this.createProgressBar(progressPercent);
            const progressMessage = `🔄 Обработка видео...\n\n${progressBar} ${progressPercent}%`;
            
            if (progressMessageId) {
              // Редактируем существующее сообщение
              try {
                await this.bot.telegram.editMessageText(
                  telegramId,
                  progressMessageId,
                  undefined,
                  progressMessage
                );
              } catch (error) {
                // Если не можем отредактировать (например, сообщение удалено), создаем новое
                const message = await this.bot.telegram.sendMessage(telegramId, progressMessage);
                if (message && 'message_id' in message) {
                  progressMessageId = (message as any).message_id;
                }
              }
            } else {
              // Создаем первое сообщение о прогрессе
              const message = await this.bot.telegram.sendMessage(telegramId, progressMessage);
              if (message && 'message_id' in message) {
                progressMessageId = (message as any).message_id;
              }
            }
          }
          
          // Check again in 5 seconds
          setTimeout(checkStatus, 5000);
        }
      } catch (error) {
        console.error(`Error monitoring job ${generationId}:`, error);
        
        if (attempts >= maxAttempts) {
          await this.handleJobTimeout(generationId, telegramId, orderId);
        } else {
          setTimeout(checkStatus, 5000);
        }
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 5000);
  }

  private async handleMultipleJobsSuccess(generationIds: string[], telegramId: number, orderId: string, videos: Array<{ url: string; model?: string }>): Promise<void> {
    try {
      // Получаем заказ для проверки способа оплаты
      const order = await this.orderService.getOrder(orderId);
      
      // Update order status
      await this.orderService.updateOrderStatus(orderId, 'completed' as any);

      // Проверяем, был ли заказ оплачен генерациями (отсутствие платежа означает оплату генерациями)
      // Списываем генерации только после успешной генерации
      if (order) {
        const hasPayment = await this.orderService.hasPayment(order.id);
        if (!hasPayment) {
          await this.userService.deductGenerations(telegramId, 1);
        }
      }

      // Update campaign statistics
      try {
        const { AnalyticsService } = await import('./analytics');
        const analyticsService = new AnalyticsService();
        
        // Get user's start_param to update campaign stats
        const client = await pool.connect();
        try {
          const result = await client.query(`
            SELECT u.start_param 
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.id = $1 AND u.start_param IS NOT NULL
          `, [orderId]);
          
          if (result.rows[0]?.start_param) {
            await analyticsService.updateCampaignStats(result.rows[0].start_param);
          }
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error updating campaign stats:', error);
      }

      // Notify user
      await this.notifyUser(telegramId, '✅ Ваше видео готово! Отправляю...');
      
      // Send all videos to user
      await this.sendMultipleVideosToUser(telegramId, videos);

    } catch (error) {
      console.error(`Error handling multiple jobs success for order ${orderId}:`, error);
      await this.handleAllJobsFailed(telegramId, orderId);
    }
  }

  private async handleAllJobsFailed(telegramId: number, orderId: string): Promise<void> {
    try {
      const order = await this.orderService.getOrder(orderId);
      if (!order) return;

      await this.orderService.updateOrderStatus(orderId, 'failed' as any);

      const hasPayment = await this.orderService.hasPayment(orderId);
      if (!hasPayment) {
        await this.userService.returnGenerations(telegramId, 1);
        const newBalance = await this.userService.getUserGenerations(telegramId);
        await this.notifyUser(telegramId, `💼 Генерация возвращена на ваш баланс.\n\nБаланс: ${newBalance} генераций`);
      }

      await this.notifyUser(telegramId, '❌ Не удалось создать видео. Попробуйте другое изображение.');
    } catch (error) {
      console.error(`Error handling all jobs failed for order ${orderId}:`, error);
    }
  }

  private async handleJobSuccess(generationId: string, telegramId: number, orderId: string, videoUrl: string): Promise<void> {
    try {
      // Получаем заказ для проверки способа оплаты
      const order = await this.orderService.getOrder(orderId);
      
      // Update order with result (videoUrl already contains the S3 link, no need to save locally)
      await this.orderService.updateOrderResult(orderId, generationId);
      await this.orderService.updateOrderStatus(orderId, 'completed' as any);

      // Update job status
      await this.runwayService.updateJobStatus(generationId, 'completed' as any, videoUrl);

      // Проверяем, был ли заказ оплачен генерациями (отсутствие платежа означает оплату генерациями)
      // Списываем генерации только после успешной генерации
      if (order) {
        const hasPayment = await this.orderService.hasPayment(order.id);
        if (!hasPayment) {
          await this.userService.deductGenerations(telegramId, 1);
        }
      }

      // Update campaign statistics
      try {
        const { AnalyticsService } = await import('./analytics');
        const analyticsService = new AnalyticsService();
        
        // Get user's start_param to update campaign stats
        const client = await pool.connect();
        try {
          const result = await client.query(`
            SELECT u.start_param 
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.id = $1 AND u.start_param IS NOT NULL
          `, [orderId]);
          
          if (result.rows[0]?.start_param) {
            await analyticsService.updateCampaignStats(result.rows[0].start_param);
          }
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error updating campaign stats:', error);
      }

      // Notify user
      await this.notifyUser(telegramId, '✅ Ваше видео готово! Отправляю...');
      
      // Send video to user
      await this.sendVideoToUser(telegramId, videoUrl);

    } catch (error) {
      console.error(`Error handling job success ${generationId}:`, error);
      await this.handleJobFailure(generationId, telegramId, orderId, 'Failed to process video');
    }
  }

  private async handleJobFailure(generationId: string, telegramId: number, orderId: string, error: string): Promise<void> {
    try {
      // Update order status
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);

      // Update job status
      await this.runwayService.updateJobStatus(generationId, 'failed' as any, undefined, error);

      // Проверяем, был ли заказ оплачен генерациями (отсутствие платежа означает оплату генерациями)
      const order = await this.orderService.getOrder(orderId);
      const hasPayment = await this.orderService.hasPayment(orderId);
      if (order && !hasPayment) {
        // Заказ был оплачен генерациями - возвращаем их
        await this.userService.returnGenerations(telegramId, 1);
        const newBalance = await this.userService.getUserGenerations(telegramId);
        await this.notifyUser(telegramId, `💼 Генерация возвращена на ваш баланс.\n\nБаланс: ${newBalance} генераций`);
      }

      // Translate error message for user
      const translatedError = this.translateRunwayError(error);
      
      // Notify user with translated error
      await this.notifyUser(telegramId, `❌ ${translatedError}`);

    } catch (error) {
      console.error(`Error handling job failure ${generationId}:`, error);
    }
  }

  private translateRunwayError(errorMessage: string | undefined | null): string {
    // Если ошибка не передана, возвращаем общее сообщение
    if (!errorMessage || typeof errorMessage !== 'string') {
      return 'Ошибка при обработке видео. Попробуйте позже.';
    }
    
    // Проверяем наличие failureCode в сообщении
    const failureCodeMatch = errorMessage.match(/failureCode:([^\|]+)/);
    if (failureCodeMatch) {
      const failureCode = failureCodeMatch[1];
      // Убираем failureCode из сообщения для дальнейшей обработки
      errorMessage = errorMessage.replace(/\|failureCode:[^\|]+/, '');
      
      // Обрабатываем специфичные коды ошибок
      if (failureCode === 'INTERNAL.BAD_OUTPUT.CODE01') {
        return 'Ошибка при генерации видео. Попробуйте другое изображение или измените промпт.';
      }
    }
    
    const errorLower = errorMessage.toLowerCase();
    
    // Соотношение сторон
    if (errorLower.includes('invalid asset aspect ratio') || errorLower.includes('aspect ratio')) {
      return 'Неподдерживаемое соотношение сторон изображения. Соотношение ширины к высоте должно быть от 0.5 до 2.';
    }
    
    // Модерация контента (включая public figure)
    if (errorLower.includes('content moderation') || 
        errorLower.includes('moderation') || 
        errorLower.includes('not passed moderation') ||
        errorLower.includes('public figure') ||
        errorLower.includes('did not pass')) {
      return 'Картинка или промпт (текстовый запрос) не прошли модерацию.';
    }
    
    // Неподдерживаемый формат
    if (errorLower.includes('invalid format') || errorLower.includes('unsupported format')) {
      return 'Неподдерживаемый формат изображения. Пожалуйста, отправьте фото в формате JPG или PNG.';
    }
    
    // Размер файла
    if (errorLower.includes('file size') || errorLower.includes('too large') || errorLower.includes('too small')) {
      return 'Неподходящий размер изображения. Пожалуйста, отправьте фото другого размера.';
    }
    
    // Общая ошибка валидации
    if (errorLower.includes('validation') || errorLower.includes('invalid')) {
      return 'Ошибка валидации изображения. Пожалуйста, отправьте другое фото.';
    }
    
    // Если не удалось перевести, возвращаем оригинальную ошибку от RunwayML
    return errorMessage;
  }

  private async handleJobTimeout(generationId: string, telegramId: number, orderId: string): Promise<void> {
    try {
      // Update order status
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);

      // Update job status
      await this.runwayService.updateJobStatus(generationId, 'failed' as any, undefined, 'Processing timeout');

      // Notify user
      await this.notifyUser(telegramId, '⏰ Время обработки истекло. Попробуйте позже.');

    } catch (error) {
      console.error(`Error handling job timeout ${generationId}:`, error);
    }
  }

  private async notifyUser(telegramId: number, message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(telegramId, message);
    } catch (error) {
      console.error(`Error notifying user ${telegramId}:`, error);
    }
  }

  private async sendMultipleVideosToUser(telegramId: number, videos: Array<{ url: string; model?: string }>): Promise<void> {
    try {
      // Если только одно видео, используем простой формат
      if (videos.length === 1) {
        await this.bot.telegram.sendMessage(
          telegramId,
          `🎬 Ваше видео готово!\n\n📹 Результат: <a href="${videos[0].url}">Скачать</a>\n\nСпасибо за использование Vividus Bot!`,
          { parse_mode: 'HTML' }
        );
      } else {
        // Если несколько видео (для будущего использования)
        let message = `🎬 Готово ${videos.length} варианта(ов) видео:\n\n`;
        
        videos.forEach((video, index) => {
          const modelName = video.model || `Вариант ${index + 1}`;
          message += `${index + 1}. ${modelName}: <a href="${video.url}">Скачать</a>\n`;
        });
        
        message += '\nСпасибо за использование Vividus Bot!';
        
        await this.bot.telegram.sendMessage(
          telegramId,
          message,
          { parse_mode: 'HTML' }
        );
      }

      // Сообщение о возможности отправить следующее фото (через 2 секунды)
      setTimeout(async () => {
        try {
          await this.bot.telegram.sendMessage(
            telegramId,
            '📸 Вы можете сразу отправить следующее фото для создания нового видео!'
          );
        } catch (error) {
          console.error(`Error sending next photo message to user ${telegramId}:`, error);
        }
      }, 2000);

    } catch (error) {
      console.error(`Error sending videos to user ${telegramId}:`, error);
      await this.notifyUser(telegramId, '❌ Ошибка при отправке видео. Попробуйте позже.');
    }
  }

  private async sendVideoToUser(telegramId: number, videoUrl: string): Promise<void> {
    try {
      // Send video URL directly instead of downloading, wrap link in HTML
      await this.bot.telegram.sendMessage(
        telegramId,
        `🎬 Ваше видео готово!\n\n📹 Результат: <a href="${videoUrl}">Ссылка</a>\n\nСпасибо за использование Vividus Bot!`,
        { parse_mode: 'HTML' }
      );

      // Сообщение о возможности отправить следующее фото (через 2 секунды)
      setTimeout(async () => {
        try {
          await this.bot.telegram.sendMessage(
            telegramId,
            '📸 Вы можете сразу отправить следующее фото для создания нового видео!'
          );
        } catch (error) {
          console.error(`Error sending next photo message to user ${telegramId}:`, error);
        }
      }, 2000);

    } catch (error) {
      console.error(`Error sending video to user ${telegramId}:`, error);
      await this.notifyUser(telegramId, '❌ Ошибка при отправке видео. Попробуйте позже.');
    }
  }

  private createProgressBar(percent: number): string {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percent / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    
    const filled = '█'.repeat(filledBlocks);
    const empty = '░'.repeat(emptyBlocks);
    
    return `[${filled}${empty}]`;
  }

  async processPendingOrders(): Promise<void> {
    try {
      const pendingOrders = await this.orderService.getOrdersByStatus('processing' as any);
      
      for (const order of pendingOrders) {
        // Check if order has been processing for too long (30 minutes)
        const processingTime = Date.now() - new Date(order.updated_at).getTime();
        const maxProcessingTime = 30 * 60 * 1000; // 30 minutes
        
        if (processingTime > maxProcessingTime) {
          await this.orderService.updateOrderStatus(order.id, 'failed' as any);
          
          const user = await this.userService.getUserById(order.user_id);
          if (user) {
            await this.notifyUser(user.telegram_id, '⏰ Время обработки истекло. Попробуйте позже.');
          }
        }
      }
    } catch (error) {
      console.error('Error processing pending orders:', error);
    }
  }
}
