import { RunwayService } from './runway';
import { FalService } from './fal';
import { OrderService } from './order';
import { FileService } from './file';
import { UserService } from './user';
import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import pool from '../config/database';

config();

export class ProcessorService {
  private runwayService: RunwayService;
  private falService: FalService;
  private orderService: OrderService;
  private fileService: FileService;
  private userService: UserService;
  private bot: Telegraf;
  private readonly MAX_CONCURRENT_ORDERS: number;

  constructor() {
    this.runwayService = new RunwayService();
    this.falService = new FalService();
    this.orderService = new OrderService();
    this.fileService = new FileService();
    this.userService = new UserService();
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    // Максимальное количество одновременно обрабатываемых заказов
    this.MAX_CONCURRENT_ORDERS = parseInt(process.env.MAX_CONCURRENT_ORDERS || '10', 10);
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

      // Проверяем количество активных заказов в обработке
      const activeOrders = await this.orderService.getOrdersByStatus('processing' as any);
      const activeOrdersCount = activeOrders.length;

      if (activeOrdersCount >= this.MAX_CONCURRENT_ORDERS) {
        // Очередь полная - ставим заказ в очередь
        console.log(`⏸ Очередь полная (${activeOrdersCount}/${this.MAX_CONCURRENT_ORDERS}), ставим заказ ${orderId} в очередь`);
        await this.orderService.updateOrderStatus(orderId, 'throttled' as any);
        
        // Уведомляем пользователя о постановке в очередь
        await this.notifyUser(
          user.telegram_id,
          `⏸ Ваш заказ поставлен в очередь.\n\n📊 Сейчас обрабатывается: ${activeOrdersCount} заказов\n\n⏳ Мы начнем обработку вашего заказа, как только освободится место. Вы получите уведомление.`
        );
        return;
      }

      // Update order status to processing
      await this.orderService.updateOrderStatus(orderId, 'processing' as any);

      // Create videos using RunwayML with all available models - check order type
      let generationIds: string[];
      try {
        console.log(`🔍 Processing order ${orderId}, order_type: ${order.order_type}, original_file_path: ${order.original_file_path?.substring(0, 50)}...`);
        
        if (order.order_type === 'combine_and_animate') {
          // Combine and animate order - two-step process
          console.log(`   → Обработка как combine_and_animate`);
          await this.processCombineAndAnimateOrder(orderId, order, user.telegram_id);
          return; // Exit early, processing continues in processCombineAndAnimateOrder
        } else if (order.order_type === 'animate_v2') {
          // Animate v2 order - используем fal.ai
          console.log(`   → Обработка как animate_v2 (fal.ai)`);
          const requestId = await this.falService.createVideoFromImage(
            order.original_file_path,
            orderId,
            order.custom_prompt
          );
          generationIds = [requestId];
          console.log(`   ✅ Создан fal.ai запрос: ${requestId}`);
        } else if (order.order_type === 'merge' && order.second_file_path) {
          // Merge order - use second image as reference for transition
          console.log(`   → Обработка как merge (RunwayML)`);
          generationIds = await this.runwayService.createMultipleVideosFromTwoImages(
            order.original_file_path,
            order.second_file_path,
            orderId,
            order.custom_prompt
          );
        } else {
          // Single image order - создаем генерации для всех доступных моделей
          console.log(`   → Обработка как single (RunwayML), order_type: ${order.order_type || 'not set'}`);
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
        const runwayJobs = await this.runwayService.getJobsByOrderId(orderId);
        const falJobs = await this.falService.getJobsByOrderId(orderId);
        const allJobs = [...runwayJobs, ...falJobs];
        if (allJobs.length > 0) {
          generationIds = allJobs.map(job => job.did_job_id);
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
          // Для заказов animate_v2 (из broadcast-bot) не отправляем уведомления в основной бот
          if (order.order_type === 'animate_v2') {
            console.log(`⚠️ Заказ ${orderId} (animate_v2) завершился с ошибкой. Уведомления не отправляются в основной бот.`);
            return;
          }
          
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
    
    // Определяем, является ли заказ animate_v2 (для отправки в broadcast-bot)
    const order = await this.orderService.getOrder(orderId);
    const isAnimateV2 = order?.order_type === 'animate_v2';
    const broadcastBotToken = isAnimateV2 ? process.env.BROADCAST_BOT_TOKEN : null;
    let broadcastBot: Telegraf | null = null;
    
    if (isAnimateV2 && broadcastBotToken) {
      const { Telegraf } = await import('telegraf');
      broadcastBot = new Telegraf(broadcastBotToken);
    }
    
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    const jobStatuses: Map<string, { status?: string; videoUrl?: string; error?: string }> = new Map();
    let attempts = 0;
    let progressMessageId: number | null = null;
    let hasNotifiedUser = false;
    let lastProgressPercent: number | null = null;

    // Отправляем начальное сообщение с прогресс-баром сразу при старте
    // Для animate_v2 прогресс-бар уже отправлен в createAnimateV2Order, нужно получить его message_id
    const sendInitialProgress = async () => {
      if (isAnimateV2) {
        // Для animate_v2 пытаемся получить message_id из custom_prompt (где мы его сохранили)
        try {
          const orderData = await this.orderService.getOrder(orderId);
          if (orderData?.custom_prompt) {
            try {
              const parsed = JSON.parse(orderData.custom_prompt);
              if (parsed.progressMessageId) {
                progressMessageId = parsed.progressMessageId;
                // Восстанавливаем промпт пользователя из метаданных, если он там есть
                if (parsed.prompt && orderData.custom_prompt !== parsed.prompt) {
                  // Обновляем custom_prompt, оставляя только промпт (message_id больше не нужен после получения)
                  const client = await (await import('../config/database')).default.connect();
                  try {
                    await client.query(
                      `UPDATE orders SET custom_prompt = $1 WHERE id = $2`,
                      [parsed.prompt || null, orderId]
                    );
                  } finally {
                    client.release();
                  }
                }
                return; // Прогресс-бар уже отправлен, просто используем его message_id
              }
            } catch (e) {
              // custom_prompt не JSON, игнорируем
            }
          }
        } catch (error) {
          console.error('Error getting progress message_id from order:', error);
        }
        
        // Если не удалось получить message_id, отправляем новое сообщение
        const botToUse = broadcastBot || this.bot;
        const progressBar = this.createProgressBar(0);
        const progressMessage = `🔄 Генерация видео...\n\n${progressBar} 0%`;
        
        try {
          const message = await botToUse.telegram.sendMessage(telegramId, progressMessage);
          if (message && 'message_id' in message) {
            progressMessageId = (message as any).message_id;
          }
        } catch (error) {
          console.error('Error sending initial progress message for animate_v2:', error);
        }
        return;
      }
      
      // Для не-animate_v2 отправляем как обычно
      const botToUse = this.bot;
      const progressBar = this.createProgressBar(0);
      const progressMessage = `🔄 Генерация видео...\n\n${progressBar} 0%`;
      
      try {
        const message = await botToUse.telegram.sendMessage(telegramId, progressMessage);
        if (message && 'message_id' in message) {
          progressMessageId = (message as any).message_id;
          console.log(`📊 Отправлено начальное сообщение с прогресс-баром. message_id: ${progressMessageId}`);
        }
      } catch (error) {
        console.error('Error sending initial progress message:', error);
      }
    };

    // Отправляем начальное сообщение сразу
    await sendInitialProgress();

    // Фейковая имитация прогресса только для animate_v2 (broadcast-bot управляет сам)
    // Для основного бота используем только реальный прогресс от RunwayML
    let fakeProgress = 0;
    const startTime = Date.now();
    const fakeProgressDuration = 120000; // 2 минуты для плавного роста
    let lastFakeProgressUpdate = 0;

    const checkStatus = async () => {
      try {
        attempts++;

        // Проверяем статус всех джобов
        const statusPromises = generationIds.map(async (generationId) => {
          try {
            // Определяем, какой сервис использовать по префиксу
            const isFalJob = generationId.startsWith('fal_');
            const jobStatus = isFalJob 
              ? await this.falService.checkJobStatus(generationId)
              : await this.runwayService.checkJobStatus(generationId);
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
          
          // Для синхронных fal.ai запросов (fal_sync_) сразу помечаем как завершенные
          if (generationId.startsWith('fal_sync_') && status === 'COMPLETED') {
            completedCount++;
            const videoUrl = jobStatus.output?.[0] || jobStatus.video?.url;
            jobStatuses.set(generationId, {
              status: 'COMPLETED',
              videoUrl,
              error: undefined
            });
            continue;
          }
          
          // Формируем полное сообщение об ошибке с failureCode, если есть
          let errorMessage: string | undefined;
          if (status === 'FAILED') {
            errorMessage = jobStatus.failure || jobStatus.error || 'Job failed';
            if ((jobStatus as any).failureCode) {
              errorMessage = `${errorMessage}|failureCode:${(jobStatus as any).failureCode}`;
            }
          }
          
          // Определяем URL видео в зависимости от формата ответа (Runway или fal.ai)
          const videoUrl = status === 'SUCCEEDED' || status === 'COMPLETED' 
            ? (jobStatus.output?.[0] || jobStatus.video?.url)
            : undefined;
          
          jobStatuses.set(generationId, {
            status,
            videoUrl,
            error: errorMessage
          });

          if (status === 'SUCCEEDED' || status === 'COMPLETED') {
            completedCount++;
            // Определяем URL видео в зависимости от формата ответа
            const videoUrl = jobStatus.output?.[0] || jobStatus.video?.url;
            // Определяем, какой сервис использовать
            const isFalJob = generationId.startsWith('fal_');
            if (isFalJob) {
              await this.falService.updateJobStatus(generationId, 'completed' as any, videoUrl);
            } else {
              await this.runwayService.updateJobStatus(generationId, 'completed' as any, videoUrl);
            }
          } else if (status === 'FAILED') {
            failedCount++;
            // Определяем, какой сервис использовать
            const isFalJob = generationId.startsWith('fal_');
            if (isFalJob) {
              await this.falService.updateJobStatus(generationId, 'failed' as any, undefined, errorMessage);
            } else {
              await this.runwayService.updateJobStatus(generationId, 'failed' as any, undefined, errorMessage);
            }
          } else {
            processingCount++;
            if (jobStatus.progress !== undefined) {
              totalProgress += jobStatus.progress;
            } else {
              // Для fal.ai без прогресса симулируем прогресс на основе времени
              // Примерно 2-3 минуты на генерацию (используем десятичный формат 0-1, как RunwayML)
              const estimatedProgress = Math.min(0.95, (attempts / 30));
              totalProgress += estimatedProgress;
            }
          }
        }

        // Вычисляем фейковый прогресс только для animate_v2
        // Для основного бота не используем фейковый прогресс
        if (isAnimateV2) {
          const elapsed = Date.now() - startTime;
          
          if (elapsed < fakeProgressDuration) {
            // Первые 2 минуты - плавный рост от 0 до 70%
            fakeProgress = Math.min(70, Math.round((elapsed / fakeProgressDuration) * 70));
          } else if (elapsed < fakeProgressDuration + 30000) {
            // Следующие 30 секунд - рваный рост от 70% до 85%
            const extraTime = elapsed - fakeProgressDuration;
            fakeProgress = 70 + Math.round((extraTime / 30000) * 15);
          } else if (elapsed < fakeProgressDuration + 60000) {
            // Следующие 30 секунд - медленный рост от 85% до 95%
            const extraTime = elapsed - fakeProgressDuration - 30000;
            fakeProgress = 85 + Math.round((extraTime / 30000) * 10);
          } else {
            // После 3 минут - резкое завершение до 100%
            fakeProgress = 100;
          }
        } else {
          // Для основного бота fakeProgress остается 0, используем только реальный прогресс
          fakeProgress = 0;
        }

        // Проверяем, завершены ли все джобы (успешно или с ошибкой)
        const allFinished = completedCount + failedCount === generationIds.length;

        // Для animate_v2: если видео готово, отправляем сразу, не ждем фейкового прогресса
        if (isAnimateV2 && allFinished && !hasNotifiedUser) {
          console.log(`✅ Animate_v2 заказ ${orderId} завершен. Отправляю результат...`);
          console.log(`   completedCount: ${completedCount}, failedCount: ${failedCount}, allFinished: ${allFinished}`);
          hasNotifiedUser = true;
          
          // Обновляем прогресс-бар до 100% перед отправкой результата
          if (progressMessageId && broadcastBot) {
            try {
              const progressBar = this.createProgressBar(100);
              await broadcastBot.telegram.editMessageText(
                telegramId,
                progressMessageId,
                undefined,
                `🔄 Генерация видео...\n\n${progressBar} 100%`
              );
            } catch (error) {
              console.error('Error updating progress to 100%:', error);
            }
          }
          
          // Собираем все успешные результаты
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            console.log(`   Проверяю generationId: ${generationId}, status: ${jobInfo?.status}, videoUrl: ${jobInfo?.videoUrl ? 'есть' : 'нет'}`);
            if (jobInfo?.videoUrl) {
              const isFalJob = generationId.startsWith('fal_');
              const job = isFalJob 
                ? await this.falService.getJobByRequestId(generationId)
                : await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }
          console.log(`   successfulVideos.length: ${successfulVideos.length}`);

          if (successfulVideos.length > 0) {
            console.log(`   Вызываю handleMultipleJobsSuccess для заказа ${orderId}`);
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            // Все джобы провалились - собираем все ошибки
            const failedErrors: string[] = [];
            for (const generationId of generationIds) {
              const jobInfo = jobStatuses.get(generationId);
              if (jobInfo?.error) {
                failedErrors.push(jobInfo.error);
              } else {
                const isFalJob = generationId.startsWith('fal_');
                const job = isFalJob
                  ? await this.falService.getJobByRequestId(generationId)
                  : await this.runwayService.getJobByGenerationId(generationId);
                if (job?.error_message) {
                  failedErrors.push(job.error_message);
                }
              }
            }
            await this.handleAllJobsFailed(telegramId, orderId, failedErrors);
          }
          return; // Завершаем мониторинг
        }

        // Для основного бота показываем прогресс, пока джобы не завершены
        // Для animate_v2 не обновляем прогресс-бар здесь (управляется фейковым таймером в broadcast-bot)
        if (!allFinished && attempts < maxAttempts) {
          if (!isAnimateV2) {
            // Только для не-animate_v2 заказов обновляем прогресс (используем ТОЛЬКО реальный прогресс от RunwayML)
            const realProgress = processingCount > 0 ? Math.round((totalProgress / processingCount) * 100) : 0;
            const displayProgress = realProgress;
            
            console.log(`📊 Попытка ${attempts}: processingCount=${processingCount}, realProgress=${realProgress}%, lastProgress=${lastProgressPercent}%, progressMessageId=${progressMessageId}`);
            
            // Обновляем сообщение только если процент изменился
            if (lastProgressPercent !== displayProgress) {
              console.log(`   Обновляю прогресс с ${lastProgressPercent}% на ${displayProgress}%`);
              lastProgressPercent = displayProgress;
              const progressBar = this.createProgressBar(displayProgress);
              const progressMessage = `🔄 Генерация видео...\n\n${progressBar} ${displayProgress}%`;

              if (progressMessageId) {
                try {
                  await this.bot.telegram.editMessageText(
                    telegramId,
                    progressMessageId,
                    undefined,
                    progressMessage
                  );
                  console.log(`   ✅ Прогресс обновлен до ${displayProgress}%`);
                } catch (error: any) {
                  console.error(`   ❌ Ошибка редактирования сообщения:`, error?.message);
                  // Если не удалось отредактировать, НЕ отправляем новое сообщение (избегаем дублирования)
                }
              } else {
                console.log(`   ⚠️ progressMessageId не установлен, пропускаю обновление`);
              }
            }
          }

          setTimeout(checkStatus, 5000);
        } else if (!isAnimateV2 && allFinished && !hasNotifiedUser) {
          // Для основного бота: все джобы завершены - отправляем результат
          hasNotifiedUser = true;
          
          // Собираем все успешные результаты
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            if (jobInfo?.videoUrl) {
              const isFalJob = generationId.startsWith('fal_');
              const job = isFalJob 
                ? await this.falService.getJobByRequestId(generationId)
                : await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            // Все джобы провалились - собираем все ошибки
            const failedErrors: string[] = [];
            for (const generationId of generationIds) {
              const jobInfo = jobStatuses.get(generationId);
              if (jobInfo?.error) {
                failedErrors.push(jobInfo.error);
              } else {
                // Проверяем БД на наличие ошибок
                const isFalJob = generationId.startsWith('fal_');
                const job = isFalJob
                  ? await this.falService.getJobByRequestId(generationId)
                  : await this.runwayService.getJobByGenerationId(generationId);
                if (job?.error_message) {
                  failedErrors.push(job.error_message);
                }
              }
            }
            await this.handleAllJobsFailed(telegramId, orderId, failedErrors);
          }
        } else if (attempts >= maxAttempts && !hasNotifiedUser) {
          hasNotifiedUser = true;
          // Таймаут - отправляем то, что готово
          const successfulVideos: Array<{ url: string; model?: string }> = [];
          for (const generationId of generationIds) {
            const jobInfo = jobStatuses.get(generationId);
            if (jobInfo?.videoUrl) {
              const isFalJob = generationId.startsWith('fal_');
              const job = isFalJob
                ? await this.falService.getJobByRequestId(generationId)
                : await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            // Таймаут - собираем ошибки из провалившихся джобов
            const failedErrors: string[] = [];
            for (const generationId of generationIds) {
              const jobInfo = jobStatuses.get(generationId);
              if (jobInfo?.error) {
                failedErrors.push(jobInfo.error);
              } else {
                // Проверяем БД на наличие ошибок
                const isFalJob = generationId.startsWith('fal_');
                const job = isFalJob
                  ? await this.falService.getJobByRequestId(generationId)
                  : await this.runwayService.getJobByGenerationId(generationId);
                if (job?.error_message) {
                  failedErrors.push(job.error_message);
                }
              }
            }
            await this.handleAllJobsFailed(telegramId, orderId, failedErrors);
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
              const isFalJob = generationId.startsWith('fal_');
              const job = isFalJob
                ? await this.falService.getJobByRequestId(generationId)
                : await this.runwayService.getJobByGenerationId(generationId);
              successfulVideos.push({ url: jobInfo.videoUrl, model: job?.model });
            }
          }

          if (successfulVideos.length > 0) {
            await this.handleMultipleJobsSuccess(generationIds, telegramId, orderId, successfulVideos);
          } else {
            // Собираем ошибки из провалившихся джобов
            const failedErrors: string[] = [];
            for (const generationId of generationIds) {
              const jobInfo = jobStatuses.get(generationId);
              if (jobInfo?.error) {
                failedErrors.push(jobInfo.error);
              } else {
                // Проверяем БД на наличие ошибок
                const isFalJob = generationId.startsWith('fal_');
                const job = isFalJob
                  ? await this.falService.getJobByRequestId(generationId)
                  : await this.runwayService.getJobByGenerationId(generationId);
                if (job?.error_message) {
                  failedErrors.push(job.error_message);
                }
              }
            }
            await this.handleAllJobsFailed(telegramId, orderId, failedErrors);
          }
        } else if (!hasNotifiedUser) {
          setTimeout(checkStatus, 5000);
        }
      }
    };

    // Start monitoring immediately (no delay)
    checkStatus();
  }

  private async monitorJob(generationId: string, telegramId: number, orderId: string): Promise<void> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;
    let progressMessageId: number | null = null; // Сохраняем ID сообщения для редактирования
    let lastProgressPercent: number | null = null;

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
            
            // Обновляем сообщение только если процент изменился
            if (lastProgressPercent !== progressPercent) {
              lastProgressPercent = progressPercent;
              const progressBar = this.createProgressBar(progressPercent);
              const progressMessage = `🔄 Генерация видео...\n\n${progressBar} ${progressPercent}%`;
              
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
      console.log(`🎯 handleMultipleJobsSuccess вызвана для заказа ${orderId}`);
      
      // Получаем заказ для проверки способа оплаты
      const order = await this.orderService.getOrder(orderId);
      console.log(`   order found: ${order ? 'да' : 'нет'}, order_type: ${order?.order_type}, current status: ${order?.status}`);
      
      // Update order status
      console.log(`   Обновляю статус заказа ${orderId} на 'completed'...`);
      await this.orderService.updateOrderStatus(orderId, 'completed' as any);
      console.log(`   ✅ Статус заказа ${orderId} обновлен на 'completed'`);

      // Для заказов animate_v2 (из broadcast-bot) отправляем результат в broadcast-bot
      if (order && order.order_type === 'animate_v2') {
        console.log(`✅ Заказ ${orderId} (animate_v2) успешно завершен. Отправляю результат в broadcast-bot...`);
        await this.sendAnimateV2ResultToBroadcastBot(telegramId, videos);
        return;
      }

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
      await this.handleAllJobsFailed(telegramId, orderId, [error instanceof Error ? error.message : String(error)]);
    }
  }

  private async handleAllJobsFailed(telegramId: number, orderId: string, errors: string[] = []): Promise<void> {
    try {
      const order = await this.orderService.getOrder(orderId);
      if (!order) return;

      await this.orderService.updateOrderStatus(orderId, 'failed' as any);

      // Для заказов animate_v2 (из broadcast-bot) не отправляем уведомления
      if (order.order_type === 'animate_v2') {
        console.log(`❌ Заказ ${orderId} (animate_v2) завершился с ошибкой. Уведомления не отправляются в основной бот.`);
        return;
      }

      const hasPayment = await this.orderService.hasPayment(orderId);
      if (!hasPayment) {
        await this.userService.returnGenerations(telegramId, 1);
        const newBalance = await this.userService.getUserGenerations(telegramId);
        await this.notifyUser(telegramId, `💼 Генерация возвращена на ваш баланс.\n\nБаланс: ${newBalance} генераций`);
      }

      // Проверяем ошибки на наличие модерации
      let errorMessage = '❌ Не удалось создать видео. Попробуйте другое изображение.';
      
      if (errors.length > 0) {
        // Ищем ошибку модерации среди всех ошибок
        const moderationError = errors.find(error => {
          const errorLower = error.toLowerCase();
          return errorLower.includes('content moderation') || 
                 errorLower.includes('moderation') || 
                 errorLower.includes('not passed moderation') ||
                 errorLower.includes('public figure') ||
                 errorLower.includes('did not pass');
        });
        
        if (moderationError) {
          // Переводим ошибку модерации
          errorMessage = `❌ ${this.translateRunwayError(moderationError)}`;
        } else {
          // Используем первую доступную переведенную ошибку
          const translatedError = this.translateRunwayError(errors[0]);
          if (translatedError !== errors[0]) {
            errorMessage = `❌ ${translatedError}`;
          }
        }
      }

      await this.notifyUser(telegramId, errorMessage);
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

      // Для заказов animate_v2 (из broadcast-bot) отправляем результат в broadcast-bot
      if (order && order.order_type === 'animate_v2') {
        console.log(`✅ Заказ ${orderId} (animate_v2) успешно завершен. Отправляю результат в broadcast-bot...`);
        await this.sendAnimateV2ResultToBroadcastBot(telegramId, [{ url: videoUrl }]);
        return;
      }

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

  private async sendAnimateV2ResultToBroadcastBot(telegramId: number, videos: Array<{ url: string; model?: string }>): Promise<void> {
    try {
      // Создаем экземпляр broadcast-bot для отправки уведомлений
      const broadcastBotToken = process.env.BROADCAST_BOT_TOKEN;
      if (!broadcastBotToken) {
        console.error('BROADCAST_BOT_TOKEN not set, cannot send notification to broadcast-bot');
        return;
      }

      const { Telegraf } = await import('telegraf');
      const broadcastBot = new Telegraf(broadcastBotToken);

      // Получаем progressMessageId из заказа
      let progressMessageId: number | null = null;
      try {
        // Находим заказ по telegramId
        const client = await (await import('../config/database')).default.connect();
        let orderId: string | null = null;
        try {
          const result = await client.query(
            `SELECT o.id, o.custom_prompt FROM orders o 
             JOIN users u ON o.user_id = u.id 
             WHERE u.telegram_id = $1 AND o.order_type = 'animate_v2' 
             ORDER BY o.created_at DESC LIMIT 1`,
            [telegramId]
          );
          if (result.rows[0]) {
            orderId = result.rows[0].id;
            const customPrompt = result.rows[0].custom_prompt;
            if (customPrompt) {
              try {
                const parsed = JSON.parse(customPrompt);
                if (parsed.progressMessageId) {
                  progressMessageId = parsed.progressMessageId;
                }
              } catch (e) {
                // Игнорируем, если не JSON
              }
            }
          }
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error getting progressMessageId:', error);
      }

      // Обновляем прогресс-бар до 100%
      if (progressMessageId) {
        try {
          const progressBar = this.createProgressBar(100);
          await broadcastBot.telegram.editMessageText(
            telegramId,
            progressMessageId,
            undefined,
            `🔄 Генерация видео...\n\n${progressBar} 100%`
          );
        } catch (error) {
          console.error('Error updating progress to 100%:', error);
        }
      }

      // Отправляем уведомление о готовности
      await broadcastBot.telegram.sendMessage(telegramId, '✅ Ваше видео готово! Отправляю...');

      // Отправляем все видео
      for (const video of videos) {
        if (video.url) {
          try {
            await broadcastBot.telegram.sendVideo(telegramId, video.url, {
              caption: `🎬 Видео готово!\n\nРезультат: <a href="${video.url}">скачать</a>\n\nСпасибо за использование Vividus Bot!`,
              parse_mode: 'HTML'
            });
          } catch (error) {
            console.error(`Error sending video to broadcast-bot:`, error);
            // Если не удалось отправить видео, отправляем ссылку
            await broadcastBot.telegram.sendMessage(
              telegramId,
              `🎬 Видео готово!\n\nРезультат: <a href="${video.url}">скачать</a>\n\nСпасибо за использование Vividus Bot!`,
              { parse_mode: 'HTML' }
            );
          }
        }
      }

      // Сообщение о возможности отправить следующее фото
      setTimeout(async () => {
        try {
          await broadcastBot.telegram.sendMessage(
            telegramId,
            '📸 Вы можете сразу отправить следующее фото для создания нового видео!'
          );
        } catch (error) {
          console.error(`Error sending next photo message to broadcast-bot:`, error);
        }
      }, 2000);

    } catch (error) {
      console.error(`Error sending animate_v2 result to broadcast-bot:`, error);
    }
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

  async processThrottledOrders(): Promise<void> {
    try {
      // Проверяем количество активных заказов
      const activeOrders = await this.orderService.getOrdersByStatus('processing' as any);
      const activeOrdersCount = activeOrders.length;

      // Если есть свободное место, обрабатываем заказы из очереди
      if (activeOrdersCount < this.MAX_CONCURRENT_ORDERS) {
        const availableSlots = this.MAX_CONCURRENT_ORDERS - activeOrdersCount;
        
        // Получаем заказы из очереди, отсортированные по дате создания (FIFO)
        const throttledOrders = await this.orderService.getOrdersByStatus('throttled' as any);
        const ordersToProcess = throttledOrders.slice(0, availableSlots);

        console.log(`🔄 Обрабатываю ${ordersToProcess.length} заказов из очереди (свободно мест: ${availableSlots})`);

        for (const order of ordersToProcess) {
          const user = await this.userService.getUserById(order.user_id);
          if (user) {
            // Уведомляем пользователя, что обработка началась
            await this.notifyUser(
              user.telegram_id,
              `✅ Ваш заказ начал обрабатываться!\n\n🎬 Генерация видео началась.`
            );
          }
          
          // Запускаем обработку заказа
          // Используем setTimeout чтобы не блокировать основной поток
          setTimeout(() => {
            this.processOrder(order.id).catch(error => {
              console.error(`Error processing throttled order ${order.id}:`, error);
            });
          }, 1000);
        }
      }
    } catch (error) {
      console.error('Error processing throttled orders:', error);
    }
  }

  private async processCombineAndAnimateOrder(orderId: string, order: any, telegramId: number): Promise<void> {
    try {
      console.log(`Processing combine_and_animate order: ${orderId}`);
      
      // Step 1: Combine images using text_to_image
      let referenceImages: string[] = [];
      if (order.reference_images) {
        try {
          referenceImages = JSON.parse(order.reference_images);
        } catch (e) {
          console.error('Error parsing reference_images:', e);
          referenceImages = [order.original_file_path];
        }
      } else {
        referenceImages = [order.original_file_path];
      }

      const combinePrompt = order.combine_prompt || 'combine all reference images into one cohesive image';
      
      await this.notifyUser(telegramId, '🎨 Шаг 1/2: Объединяю фото...');
      
      // Create combined image
      const textToImageJobId = await this.runwayService.createImageFromTextWithReferences(
        combinePrompt,
        referenceImages,
        orderId
      );
      
      // Monitor text_to_image job
      await this.monitorTextToImageJob(textToImageJobId, orderId, telegramId, order);
      
    } catch (error: any) {
      console.error(`Error processing combine_and_animate order ${orderId}:`, error);
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);
      
      const user = await this.userService.getUserById(order.user_id);
      if (user) {
        const hasPayment = await this.orderService.hasPayment(orderId);
        if (!hasPayment) {
          await this.userService.returnGenerations(user.telegram_id, 1);
          const newBalance = await this.userService.getUserGenerations(user.telegram_id);
          await this.notifyUser(user.telegram_id, `💼 Генерация возвращена на ваш баланс.\n\nБаланс: ${newBalance} генераций`);
        }
        
        const errorMessage = error?.message || 'Произошла ошибка при обработке. Попробуйте позже.';
        await this.notifyUser(user.telegram_id, `❌ ${errorMessage}`);
      }
    }
  }

  private async monitorTextToImageJob(
    generationId: string, 
    orderId: string, 
    telegramId: number, 
    order: any
  ): Promise<void> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const jobStatus = await this.runwayService.checkJobStatus(generationId);
        
        if (jobStatus.status === 'succeeded' && jobStatus.output && jobStatus.output.length > 0) {
          // Image created successfully
          const combinedImageUrl = jobStatus.output[0];
          
          // Update job status
          await this.runwayService.updateJobStatus(generationId, 'completed' as any, combinedImageUrl);
          
          // Download and save combined image
          const { FileService } = await import('./file');
          const fileService = new FileService();
          const localPath = await fileService.downloadFileFromUrl(combinedImageUrl, 'combined');
          const s3Url = await fileService.uploadToS3(localPath);
          
          // Update order with combined image
          await this.orderService.updateOrderCombinedImage(orderId, s3Url);
          
          // Отправляем объединенное изображение пользователю
          await this.notifyUser(telegramId, 'Современное объединённое фото ✅');
          try {
            await this.bot.telegram.sendPhoto(telegramId, combinedImageUrl, {
              caption: 'Современное объединённое фото'
            });
          } catch (error) {
            console.error('Error sending combined photo:', error);
            // Если не удалось отправить фото, отправляем ссылку
            await this.notifyUser(telegramId, `📸 Объединенное фото: ${combinedImageUrl}`);
          }
          
          await this.notifyUser(telegramId, '🎬 Шаг 2/2: Анимирую изображение...');
          
          // Step 2: Animate the combined image
          const animationPrompt = order.animation_prompt || 'animate this image with subtle movements and breathing effect';
          const videoGenerationIds = await this.runwayService.createMultipleVideosFromImage(
            s3Url,
            orderId,
            animationPrompt
          );
          
          if (videoGenerationIds.length > 0) {
            await this.orderService.updateOrderResult(orderId, videoGenerationIds[0]);
            this.monitorMultipleJobs(videoGenerationIds, telegramId, orderId);
          } else {
            throw new Error('Не удалось создать анимацию');
          }
          
        } else if (jobStatus.status === 'FAILED') {
          let errorMessage = jobStatus.failure || jobStatus.error || 'Job failed';
          if ((jobStatus as any).failureCode) {
            errorMessage = `${errorMessage}|failureCode:${(jobStatus as any).failureCode}`;
          }
          await this.runwayService.updateJobStatus(generationId, 'failed' as any, undefined, errorMessage);
          throw new Error(this.translateRunwayError(errorMessage));
        } else if (attempts >= maxAttempts) {
          throw new Error('Время ожидания объединения изображения истекло');
        } else {
          // Still processing, check again in 5 seconds
          setTimeout(checkStatus, 5000);
        }
      } catch (error: any) {
        console.error(`Error monitoring text_to_image job ${generationId}:`, error);
        
        if (attempts >= maxAttempts || error.message?.includes('FAILED') || error.message?.includes('failed')) {
          throw error;
        } else {
          setTimeout(checkStatus, 5000);
        }
      }
    };

    // Start monitoring
    setTimeout(checkStatus, 5000);
  }
}
