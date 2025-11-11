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

  private getCurrentDateTime(): string {
    const now = new Date();
    // Московское время (UTC+3)
    const moscowTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
    const day = String(moscowTime.getUTCDate()).padStart(2, '0');
    const month = String(moscowTime.getUTCMonth() + 1).padStart(2, '0');
    const year = moscowTime.getUTCFullYear();
    const hours = String(moscowTime.getUTCHours()).padStart(2, '0');
    const minutes = String(moscowTime.getUTCMinutes()).padStart(2, '0');
    const seconds = String(moscowTime.getUTCSeconds()).padStart(2, '0');
    
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds} (МСК)`;
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

  // Проверка статуса бота у пользователя через sendChatAction
  private async checkUserStatus(userId: number): Promise<{ active: boolean; reason?: string }> {
    try {
      // Используем sendChatAction с 'typing' - это показывает индикатор "печатает..."
      // но это самый надежный способ определить блокировку
      // Если бот заблокирован, вернет ошибку 403
      await this.bot.telegram.sendChatAction(userId, 'typing');
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
      const result = await client.query('SELECT telegram_id, start_param FROM users ORDER BY telegram_id');
      const users = result.rows;
      const totalUsers = users.length;
      
      let activeCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      // Статистика по неорганическим пользователям (unu)
      let unuActiveCount = 0;
      let unuBlockedCount = 0;
      let unuErrorCount = 0;
      let unuTotalCount = 0;
      
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
        const isUnu = user.start_param === 'unu';
        const status = await this.checkUserStatus(user.telegram_id);
        
        processedCount++;
        
        // Общая статистика
        if (status.active) {
          activeCount++;
        } else if (status.reason === 'blocked') {
          blockedCount++;
        } else {
          errorCount++;
        }
        
        // Статистика по неорганическим пользователям (unu)
        if (isUnu) {
          unuTotalCount++;
          if (status.active) {
            unuActiveCount++;
          } else if (status.reason === 'blocked') {
            unuBlockedCount++;
          } else {
            unuErrorCount++;
          }
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
      let finalMessage = `✅ Проверка завершена!\n\n` +
        `📊 Статистика на ${this.getCurrentDateTime()}:\n\n` +
        `👥 Всего пользователей: ${totalUsers}\n` +
        `📤 Обработано: ${processedCount}\n\n` +
        `✅ Активны (бот не заблокирован): ${activeCount} (${totalUsers > 0 ? Math.round(activeCount / totalUsers * 100) : 0}%)\n` +
        `🚫 Заблокировали бота: ${blockedCount} (${totalUsers > 0 ? Math.round(blockedCount / totalUsers * 100) : 0}%)\n` +
        `❌ Ошибки проверки: ${errorCount} (${totalUsers > 0 ? Math.round(errorCount / totalUsers * 100) : 0}%)`;
      
      // Добавляем статистику по неорганическим пользователям (unu)
      if (unuTotalCount > 0) {
        finalMessage += `\n\n━━━━━━━━━━━━━━━━━━━━\n` +
          `📊 Неорганические пользователи (unu):\n` +
          `👥 Всего: ${unuTotalCount}\n` +
          `✅ Успешно: ${unuActiveCount} (${Math.round(unuActiveCount / unuTotalCount * 100)}%)\n` +
          `🚫 Заблокировали бота: ${unuBlockedCount} (${Math.round(unuBlockedCount / unuTotalCount * 100)}%)\n` +
          `❌ Неуспешно: ${unuErrorCount} (${Math.round(unuErrorCount / unuTotalCount * 100)}%)`;
      }
      
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

  // Проверка только органических пользователей (исключая кампанию "unu")
  async checkOrganicUsersStatus(adminChatId: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      // Получаем только органических пользователей (исключаем кампанию "unu")
      const result = await client.query(
        `SELECT telegram_id FROM users 
         WHERE start_param IS NULL OR start_param != 'unu' 
         ORDER BY telegram_id`
      );
      const users = result.rows;
      const totalUsers = users.length;
      
      let activeCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      // Отправляем начальное сообщение
      const initialMessage = `🔍 Проверка статуса органических пользователей...\n\n` +
        `📊 Прогресс: 0/${totalUsers}\n` +
        `${this.getProgressBar(0, totalUsers)}\n\n` +
        `✅ Активны: 0\n` +
        `🚫 Заблокировали: 0\n` +
        `❌ Ошибки: 0\n\n` +
        `ℹ️ Исключены пользователи из кампании "unu"`;
      
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
            const progressText = `🔍 Проверка статуса органических пользователей...\n\n` +
              `📊 Прогресс: ${processedCount}/${totalUsers}\n` +
              `${this.getProgressBar(processedCount, totalUsers)}\n\n` +
              `✅ Активны: ${activeCount}\n` +
              `🚫 Заблокировали: ${blockedCount}\n` +
              `❌ Ошибки: ${errorCount}\n\n` +
              `ℹ️ Исключены пользователи из кампании "unu"`;
            
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
      const finalMessage = `✅ Проверка органических пользователей завершена!\n\n` +
        `📊 Статистика на ${this.getCurrentDateTime()}:\n\n` +
        `👥 Всего органических пользователей: ${totalUsers}\n` +
        `📤 Обработано: ${processedCount}\n\n` +
        `✅ Активны (бот не заблокирован): ${activeCount} (${totalUsers > 0 ? Math.round(activeCount / totalUsers * 100) : 0}%)\n` +
        `🚫 Заблокировали бота: ${blockedCount} (${totalUsers > 0 ? Math.round(blockedCount / totalUsers * 100) : 0}%)\n` +
        `❌ Ошибки проверки: ${errorCount} (${totalUsers > 0 ? Math.round(errorCount / totalUsers * 100) : 0}%)\n\n` +
        `ℹ️ Исключены пользователи из кампании "unu"`;
      
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
      
      console.log(`Organic users status check completed: ${activeCount}/${totalUsers} active, ${blockedCount} blocked`);
      
    } catch (error) {
      console.error('Error during organic users status check:', error);
      await this.adminBot.telegram.sendMessage(
        adminChatId,
        '❌ Ошибка при проверке статуса органических пользователей'
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
          `📊 Статистика на ${this.getCurrentDateTime()}:\n\n` +
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

  // Рассылка только пользователям без платежей
  async sendBroadcastToNonPayingUsers(
    broadcastData: BroadcastData, 
    adminChatId: number
  ): Promise<BroadcastResult> {
    const client = await pool.connect();
    
    try {
      // Получаем пользователей, которые еще не делали успешных платежей
      const result = await client.query(`
        SELECT DISTINCT u.telegram_id 
        FROM users u
        LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'success'
        WHERE p.id IS NULL
        ORDER BY u.telegram_id
      `);
      const users = result.rows;
      const totalUsers = users.length;
      
      let successCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      console.log(`Starting broadcast to ${totalUsers} non-paying users`);
      
      // Отправляем начальное сообщение с прогрессом
      let progressMessageId: number | undefined;
      try {
        const initialProgress = `💸 Рассылка неплатящим пользователям началась...\n\n` +
          `👥 Всего неплатящих пользователей: ${totalUsers}\n\n` +
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
        
        // Обновляем прогресс
        const shouldUpdate = totalUsers <= 10 
          ? true 
          : (processedCount % 10 === 0 || processedCount === totalUsers);
        
        if (shouldUpdate && progressMessageId) {
          try {
            const progressText = `💸 Рассылка неплатящим пользователям в процессе...\n\n` +
              `👥 Всего неплатящих пользователей: ${totalUsers}\n\n` +
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
        
        // Задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      // Отправляем финальную статистику
      if (progressMessageId) {
        const finalMessage = `✅ Рассылка неплатящим пользователям завершена!\n\n` +
          `📊 Статистика на ${this.getCurrentDateTime()}:\n\n` +
          `👥 Всего неплатящих пользователей: ${totalUsers}\n` +
          `📤 Обработано: ${processedCount}\n\n` +
          `✅ Успешно доставлено: ${successCount} (${totalUsers > 0 ? Math.round(successCount / totalUsers * 100) : 0}%)\n` +
          `🚫 Заблокировали бота: ${blockedCount} (${totalUsers > 0 ? Math.round(blockedCount / totalUsers * 100) : 0}%)\n` +
          `❌ Ошибки отправки: ${errorCount} (${totalUsers > 0 ? Math.round(errorCount / totalUsers * 100) : 0}%)\n\n` +
          `ℹ️ Отправлено только пользователям без успешных платежей`;
        
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
      
      console.log(`Broadcast to non-paying users completed: ${successCount}/${totalUsers} successful`);
      
      return { 
        successCount, 
        blockedCount, 
        errorCount, 
        totalUsers,
        processedCount
      };
    } catch (error) {
      console.error('Error during broadcast to non-paying users:', error);
      await this.adminBot.telegram.sendMessage(
        adminChatId,
        '❌ Ошибка при рассылке неплатящим пользователям'
      );
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

