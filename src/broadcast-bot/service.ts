import { Telegraf } from 'telegraf';
import pool from '../config/database';
import { config } from 'dotenv';

config();

interface BroadcastData {
  text?: string;
  mediaType?: string;
  mediaFileId?: string;
}

interface BroadcastResult {
  successCount: number;
  blockedCount: number;
  errorCount: number;
  totalUsers: number;
  processedCount: number;
}

export class BroadcastService {
  private bot: Telegraf; // Основной бот для отправки сообщений пользователям
  private adminBot: Telegraf; // Broadcast-бот для отправки статистики админу

  constructor() {
    // Используем токен ОСНОВНОГО бота для отправки сообщений пользователям
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    // Используем токен BROADCAST-бота для отправки статистики админу
    this.adminBot = new Telegraf(process.env.BROADCAST_BOT_TOKEN!);
  }

  private isBlockedError(error: any): boolean {
    return error?.response?.error_code === 403 && 
           (error?.response?.description?.includes('bot was blocked') || 
            error?.response?.description?.includes('Forbidden: bot was blocked'));
  }

  private getProgressBar(current: number, total: number, width: number = 20): string {
    const percentage = Math.round((current / total) * 100);
    const filledWidth = Math.round((current / total) * width);
    const emptyWidth = width - filledWidth;
    
    const filledBar = '█'.repeat(filledWidth);
    const emptyBar = '░'.repeat(emptyWidth);
    
    return `${filledBar}${emptyBar} ${percentage}%`;
  }

  private async sendToUser(userId: number, broadcastData: BroadcastData): Promise<{ success: boolean; reason?: string }> {
    try {
      if (broadcastData.mediaType && broadcastData.mediaFileId) {
        const options: any = {};
        if (broadcastData.text) {
          options.caption = broadcastData.text;
        }
        
        if (broadcastData.mediaType === 'photo') {
          await this.bot.telegram.sendPhoto(userId, broadcastData.mediaFileId, options);
        } else if (broadcastData.mediaType === 'video') {
          await this.bot.telegram.sendVideo(userId, broadcastData.mediaFileId, options);
        } else if (broadcastData.mediaType === 'animation') {
          await this.bot.telegram.sendAnimation(userId, broadcastData.mediaFileId, options);
        }
      } else if (broadcastData.text) {
        await this.bot.telegram.sendMessage(userId, broadcastData.text);
      }
      return { success: true };
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        console.log(`User ${userId} blocked the bot`);
        return { success: false, reason: 'blocked' };
      } else {
        console.error(`Error sending to user ${userId}:`, error);
        return { success: false, reason: 'error' };
      }
    }
  }

  // Публичный метод для отправки одному пользователю (для теста)
  async sendBroadcastToUser(userId: number, broadcastData: BroadcastData): Promise<{ success: boolean; reason?: string }> {
    return this.sendToUser(userId, broadcastData);
  }

  // Публичный метод для массовой рассылки
  async startMassBroadcast(broadcastData: BroadcastData, adminUserId: number, adminChatId: number): Promise<void> {
    await this.sendBroadcast(broadcastData, adminChatId);
  }

  // Проверка статуса бота у пользователя (без отправки сообщения и без уведомлений)
  private async checkUserStatus(userId: number): Promise<{ active: boolean; reason?: string }> {
    try {
      // Используем getChat - это просто получает информацию о чате
      // НЕ показывает никаких уведомлений пользователю и невидимо для него
      // Если бот заблокирован, вернет ошибку 403
      await this.bot.telegram.getChat(userId);
      return { active: true };
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        return { active: false, reason: 'blocked' };
      } else {
        // Другие ошибки (например, пользователь не существует) тоже считаем неактивными
        return { active: false, reason: 'error' };
      }
    }
  }

  // Проверка всех пользователей без рассылки
  async checkAllUsersStatus(adminChatId: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT telegram_id FROM users ORDER BY telegram_id');
      const users = result.rows;
      const totalUsers = users.length;
      
      let activeCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      // Отправляем начальное сообщение
      const initialMessage = `🔍 Проверка статуса пользователей...\n\n` +
        `📊 Прогресс: 0/${totalUsers}\n` +
        `${this.getProgressBar(0, totalUsers)}\n\n` +
        `✅ Активны: 0\n` +
        `🚫 Заблокировали: 0\n` +
        `❌ Ошибки: 0`;
      
      const progressMsg = await this.adminBot.telegram.sendMessage(adminChatId, initialMessage);
      const progressMessageId = progressMsg.message_id;
      
      // Проверяем каждого пользователя
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const status = await this.checkUserStatus(user.telegram_id);
        
        processedCount++;
        
        if (status.active) {
          activeCount++;
        } else if (status.reason === 'blocked') {
          blockedCount++;
        } else {
          errorCount++;
        }
        
        // Обновляем прогресс
        const shouldUpdate = totalUsers <= 10 
          ? true 
          : (processedCount % 10 === 0 || processedCount === totalUsers);
        
        if (shouldUpdate) {
          try {
            const progressText = `🔍 Проверка статуса пользователей...\n\n` +
              `📊 Прогресс: ${processedCount}/${totalUsers}\n` +
              `${this.getProgressBar(processedCount, totalUsers)}\n\n` +
              `✅ Активны: ${activeCount}\n` +
              `🚫 Заблокировали: ${blockedCount}\n` +
              `❌ Ошибки: ${errorCount}`;
            
            await this.adminBot.telegram.editMessageText(
              adminChatId,
              progressMessageId,
              undefined,
              progressText
            );
          } catch (error) {
            // Игнорируем ошибки обновления
          }
        }
        
        // Небольшая задержка чтобы не получить rate limit
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Финальная статистика
      const finalMessage = `✅ Проверка завершена!\n\n` +
        `📊 Статистика:\n` +
        `👥 Всего пользователей: ${totalUsers}\n` +
        `📤 Обработано: ${processedCount}\n\n` +
        `✅ Активны (бот не заблокирован): ${activeCount} (${Math.round(activeCount / totalUsers * 100)}%)\n` +
        `🚫 Заблокировали бота: ${blockedCount} (${Math.round(blockedCount / totalUsers * 100)}%)\n` +
        `❌ Ошибки проверки: ${errorCount} (${Math.round(errorCount / totalUsers * 100)}%)`;
      
      try {
        await this.adminBot.telegram.editMessageText(
          adminChatId,
          progressMessageId,
          undefined,
          finalMessage
        );
      } catch (error) {
        await this.adminBot.telegram.sendMessage(adminChatId, finalMessage);
      }
      
      console.log(`Status check completed: ${activeCount}/${totalUsers} active, ${blockedCount} blocked`);
      
    } catch (error) {
      console.error('Error during status check:', error);
      await this.adminBot.telegram.sendMessage(
        adminChatId,
        '❌ Ошибка при проверке статуса пользователей'
      );
    } finally {
      client.release();
    }
  }

  private async sendBroadcast(
    broadcastData: BroadcastData, 
    adminChatId: number,
    onProgress?: (current: number, total: number, stats: { success: number; blocked: number; error: number }) => void
  ): Promise<BroadcastResult> {
    const client = await pool.connect();
    
    try {
      // Получаем всех пользователей из базы данных
      const result = await client.query('SELECT telegram_id FROM users ORDER BY telegram_id');
      const users = result.rows;
      const totalUsers = users.length;
      
      let successCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      console.log(`Starting broadcast to ${totalUsers} users`);
      
      // Отправляем начальное сообщение с прогрессом
      let progressMessageId: number | undefined;
      try {
        const initialProgress = `📢 Рассылка началась...\n\n` +
          `📊 Прогресс: 0/${totalUsers}\n` +
          `${this.getProgressBar(0, totalUsers)}\n\n` +
          `✅ Успешно: 0\n` +
          `🚫 Заблокировали: 0\n` +
          `❌ Ошибки: 0`;
        
        const msg = await this.adminBot.telegram.sendMessage(adminChatId, initialProgress);
        progressMessageId = msg.message_id;
      } catch (error) {
        console.error('Error creating initial progress message:', error);
      }
      
      // Рассылаем сообщения
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const sendResult = await this.sendToUser(user.telegram_id, broadcastData);
        
        processedCount++;
        
        if (sendResult.success) {
          successCount++;
        } else if (sendResult.reason === 'blocked') {
          blockedCount++;
        } else {
          errorCount++;
        }
        
        // Обновляем прогресс: для малого количества - после каждого, для большого - каждые 10
        const shouldUpdate = totalUsers <= 10 
          ? true // Обновляем после каждого для малого количества
          : (processedCount % 10 === 0 || processedCount === totalUsers); // Для большого - каждые 10
        
        if (shouldUpdate && progressMessageId) {
          try {
            const progressText = `📢 Рассылка в процессе...\n\n` +
              `📊 Прогресс: ${processedCount}/${totalUsers}\n` +
              `${this.getProgressBar(processedCount, totalUsers)}\n\n` +
              `✅ Успешно: ${successCount}\n` +
              `🚫 Заблокировали: ${blockedCount}\n` +
              `❌ Ошибки: ${errorCount}`;
            
            await this.adminBot.telegram.editMessageText(
              adminChatId,
              progressMessageId,
              undefined,
              progressText
            );
          } catch (error) {
            // Игнорируем ошибки обновления прогресса
          }
        }
        
        if (onProgress) {
          onProgress(processedCount, totalUsers, {
            success: successCount,
            blocked: blockedCount,
            error: errorCount
          });
        }
        
        // Задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Отправляем финальную статистику
      if (progressMessageId) {
        const finalMessage = `✅ Рассылка завершена!\n\n` +
          `📊 Статистика:\n` +
          `👥 Всего пользователей: ${totalUsers}\n` +
          `📤 Обработано: ${processedCount}\n\n` +
          `✅ Успешно доставлено: ${successCount} (${Math.round(successCount / totalUsers * 100)}%)\n` +
          `🚫 Заблокировали бота: ${blockedCount} (${Math.round(blockedCount / totalUsers * 100)}%)\n` +
          `❌ Ошибки отправки: ${errorCount} (${Math.round(errorCount / totalUsers * 100)}%)`;
        
        try {
          await this.adminBot.telegram.editMessageText(
            adminChatId,
            progressMessageId,
            undefined,
            finalMessage
          );
        } catch (error) {
          await this.adminBot.telegram.sendMessage(adminChatId, finalMessage);
        }
      }
      
      console.log(`Broadcast completed: ${successCount}/${totalUsers} successful`);
      
      return { 
        successCount, 
        blockedCount, 
        errorCount, 
        totalUsers,
        processedCount
      };
    } catch (error) {
      console.error('Error during broadcast:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async start() {
    console.log('Broadcast bot service ready');
  }

  getBot() {
    return this.bot;
  }
}

