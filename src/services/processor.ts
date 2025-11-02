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

      // Create video using RunwayML
      const generationId = await this.runwayService.createVideoFromImage(
        order.original_file_path,
        orderId,
        order.custom_prompt
      );

      // Update order with generation ID
      await this.orderService.updateOrderResult(orderId, generationId);

      // Start monitoring the job
      this.monitorJob(generationId, user.telegram_id, orderId);

    } catch (error: any) {
      console.error(`Error processing order ${orderId}:`, error);
      
      // Update order status to failed
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);
      
      // Notify user about error with translated message
      const order = await this.orderService.getOrder(orderId);
      if (order) {
        const user = await this.userService.getUserById(order.user_id);
        if (user) {
          // Проверяем, был ли заказ оплачен генерациями - возвращаем их
          if (order.price === 0) {
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
          // Job failed - используем failure, error или fallback
          const errorMessage = jobStatus.failure || jobStatus.error || 'Job failed';
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

  private async handleJobSuccess(generationId: string, telegramId: number, orderId: string, videoUrl: string): Promise<void> {
    try {
      // Получаем заказ для проверки способа оплаты
      const order = await this.orderService.getOrder(orderId);
      
      // Update order with result (videoUrl already contains the S3 link, no need to save locally)
      await this.orderService.updateOrderResult(orderId, generationId);
      await this.orderService.updateOrderStatus(orderId, 'completed' as any);

      // Update job status
      await this.runwayService.updateJobStatus(generationId, 'completed' as any, videoUrl);

      // Проверяем, был ли заказ оплачен генерациями (price = 0 означает оплату генерациями)
      // Списываем генерации только после успешной генерации
      if (order && order.price === 0) {
        const deducted = await this.userService.deductGenerations(telegramId, 1);
        if (deducted) {
          const remainingGenerations = await this.userService.getUserGenerations(telegramId);
          await this.notifyUser(telegramId, `✅ Генерация использована! Осталось: ${remainingGenerations}`);
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

      // Проверяем, был ли заказ оплачен генерациями (price = 0 означает оплату генерациями)
      const order = await this.orderService.getOrder(orderId);
      if (order && order.price === 0) {
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
