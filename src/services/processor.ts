import { RunwayService } from './runway';
import { OrderService } from './order';
import { FileService } from './file';
import { UserService } from './user';
import { Telegraf } from 'telegraf';
import { config } from 'dotenv';

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

      // Notify user that processing started with animation
      await this.notifyUser(user.telegram_id, '🎬 Начинаю обработку вашего фото...\n\n⏳ Пожалуйста, подождите...');

      // Create video using RunwayML
      const generationId = await this.runwayService.createVideoFromImage(
        order.original_file_path,
        orderId,
        order.custom_prompt
      );

      // Update order with generation ID
      await this.orderService.updateOrderResult(orderId, '', generationId);

      // Start monitoring the job
      this.monitorJob(generationId, user.telegram_id, orderId);

    } catch (error) {
      console.error(`Error processing order ${orderId}:`, error);
      
      // Update order status to failed
      await this.orderService.updateOrderStatus(orderId, 'failed' as any);
      
      // Notify user about error
      const order = await this.orderService.getOrder(orderId);
      if (order) {
        const user = await this.userService.getUserById(order.user_id);
        if (user) {
          await this.notifyUser(user.telegram_id, '❌ Произошла ошибка при обработке. Попробуйте позже.');
        }
      }
    }
  }

  private async monitorJob(generationId: string, telegramId: number, orderId: string): Promise<void> {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const jobStatus = await this.runwayService.checkJobStatus(generationId);
        
        if (jobStatus.status === 'SUCCEEDED') {
          // Job completed successfully
          await this.handleJobSuccess(generationId, telegramId, orderId, jobStatus.output[0]);
        } else if (jobStatus.status === 'FAILED') {
          // Job failed
          await this.handleJobFailure(generationId, telegramId, orderId, jobStatus.error);
        } else if (attempts >= maxAttempts) {
          // Timeout
          await this.handleJobTimeout(generationId, telegramId, orderId);
        } else {
          // Still processing, send progress update
          if (jobStatus.progress !== undefined) {
            const progressPercent = Math.round(jobStatus.progress * 100);
            const progressBar = this.createProgressBar(progressPercent);
            await this.notifyUser(telegramId, `🔄 Обработка видео...\n\n${progressBar} ${progressPercent}%`);
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
      // Download video
      const videoPath = await this.fileService.saveProcessedVideo(
        Buffer.from(''), // Will be replaced with actual video data
        orderId
      );

      // Update order with result
      await this.orderService.updateOrderResult(orderId, videoPath, generationId);
      await this.orderService.updateOrderStatus(orderId, 'completed' as any);

      // Update job status
      await this.runwayService.updateJobStatus(generationId, 'completed' as any, videoUrl);

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

      // Notify user
      await this.notifyUser(telegramId, '❌ Ошибка при обработке видео. Попробуйте позже.');

    } catch (error) {
      console.error(`Error handling job failure ${generationId}:`, error);
    }
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
      // Send video URL directly instead of downloading
      await this.bot.telegram.sendMessage(
        telegramId,
        `🎬 Ваше видео готово!\n\n📹 Результат: ${videoUrl}\n\nСпасибо за использование Vividus Bot!`
      );

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
