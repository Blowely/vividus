import { config } from 'dotenv';
import { TelegramService } from './services/telegram';
import { ProcessorService } from './services/processor';
import { PaymentService } from './services/payment';
import pool from './config/database';
import redisClient from './config/redis';
import { startWebhookServer } from './webhook/server';

config();

class App {
  private telegramService: TelegramService;
  private processorService: ProcessorService;
  private paymentService: PaymentService;

  constructor() {
    this.telegramService = new TelegramService();
    this.processorService = new ProcessorService();
    this.paymentService = new PaymentService();
  }

  async start() {
    try {
      console.log('Starting Vividus Bot...');

      // Connect to database
      await this.initDatabase();
      
      // Connect to Redis
      await this.initRedis();

      // Start webhook server first (before Telegram bot)
      console.log('Starting webhook server...');
      startWebhookServer();
      console.log('Webhook server started on port', process.env.PORT || 3000);

      // Start Telegram bot
      console.log('Starting Telegram bot...');
      await this.telegramService.start();
      console.log('Telegram bot started successfully');

      // Start background processors
      this.startBackgroundProcessors();

      console.log('Vividus Bot started successfully!');
    } catch (error) {
      console.error('Failed to start app:', error);
      process.exit(1);
    }
  }

  private async initDatabase() {
    try {
      const client = await pool.connect();
      console.log('Connected to PostgreSQL');
      client.release();
    } catch (error) {
      console.error('Failed to connect to database:', error);
      throw error;
    }
  }

  private async initRedis() {
    try {
      await redisClient.connect();
      console.log('Connected to Redis');
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      // Redis is optional, continue without it
    }
  }

  private startBackgroundProcessors() {
    // Process pending orders every 30 seconds
    setInterval(async () => {
      try {
        await this.processorService.processPendingOrders();
      } catch (error) {
        console.error('Error processing pending orders:', error);
      }
    }, 30000);

    // Clean up old files every hour
    setInterval(async () => {
      try {
        const { FileService } = await import('./services/file');
        const fileService = new FileService();
        await fileService.cleanupOldFiles(7); // Keep files for 7 days
      } catch (error) {
        console.error('Error cleaning up old files:', error);
      }
    }, 3600000); // 1 hour
  }

  async stop() {
    try {
      console.log('Stopping Vividus Bot...');
      
      await this.telegramService.stop();
      await pool.end();
      await redisClient.quit();
      
      console.log('Vividus Bot stopped');
    } catch (error) {
      console.error('Error stopping app:', error);
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await app.stop();
  process.exit(0);
});

const app = new App();
app.start();
