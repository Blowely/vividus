import { Telegraf } from 'telegraf';
import pool from '../config/database';
import { config } from 'dotenv';
import { S3Service } from '../services/s3';
import * as fs from 'fs';
import * as path from 'path';

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
  private adminBot: Telegraf; // Broadcast-бот для отправки статистики админу и получения файлов
  private s3Service: S3Service;

  constructor() {
    // Используем токен ОСНОВНОГО бота для отправки сообщений пользователям
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    // Используем токен BROADCAST-бота для отправки статистики админу
    this.adminBot = new Telegraf(process.env.BROADCAST_BOT_TOKEN!);
    this.s3Service = new S3Service();
  }

  // Скачиваем файл через broadcast-бот и конвертируем в Buffer
  private async downloadMediaFile(fileId: string): Promise<Buffer> {
    const fileLink = await this.adminBot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
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
        
        // Скачиваем файл через broadcast-бот
        const fileBuffer = await this.downloadMediaFile(broadcastData.mediaFileId);
        
        // Отправляем как Buffer через основной бот
        if (broadcastData.mediaType === 'photo') {
          await this.bot.telegram.sendPhoto(userId, { source: fileBuffer }, options);
        } else if (broadcastData.mediaType === 'video') {
          await this.bot.telegram.sendVideo(userId, { source: fileBuffer }, options);
        } else if (broadcastData.mediaType === 'animation') {
          await this.bot.telegram.sendAnimation(userId, { source: fileBuffer }, options);
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

  // Проверка только органических пользователей (исключая кампании "unu", "smm", "task_pay")
  async checkOrganicUsersStatus(adminChatId: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      // Получаем только органических пользователей (исключаем кампании "unu", "smm", "task_pay")
      const result = await client.query(
        `SELECT telegram_id FROM users 
         WHERE start_param IS NULL OR start_param NOT IN ('unu', 'smm', 'task_pay')
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
        `ℹ️ Исключены пользователи из кампаний: unu, smm, task_pay`;
      
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
              `ℹ️ Исключены пользователи из кампаний: unu, smm, task_pay`;
            
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
        `ℹ️ Исключены пользователи из кампаний: unu, smm, task_pay`;
      
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

  // Создание полного дампа базы данных
  async createFullDatabaseDump(adminChatId: number): Promise<void> {
    const client = await pool.connect();
    const tables = ['users', 'orders', 'payments', 'did_jobs', 'campaigns', 'campaign_stats', 'activity_logs'];
    
    try {
      const progressMessage = await this.adminBot.telegram.sendMessage(
        adminChatId,
        '💾 Создание полного дампа базы данных...\n\n' +
        '⏳ Подготовка...'
      );
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const s3Links: { [key: string]: string } = {};
      const rowCounts: { [key: string]: number } = {};
      const tempDir = path.join(__dirname, '../../temp_dumps');
      
      // Создаем временную директорию
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Создаем дампы всех таблиц с прогресс-баром
      for (let i = 0; i < tables.length; i++) {
        const tableName = tables[i];
        const progress = this.getProgressBar(i, tables.length);
        
        await this.adminBot.telegram.editMessageText(
          adminChatId,
          progressMessage.message_id,
          undefined,
          `💾 Создание полного дампа базы данных...\n\n` +
          `📊 Прогресс: ${progress}\n` +
          `📦 Обработка таблицы: ${tableName}`
        );
        
        // Создаем дамп и сохраняем во временный файл
        const { dump, rowCount } = await this.createTableDumpContent(client, tableName);
        rowCounts[tableName] = rowCount;
        
        const tempFilePath = path.join(tempDir, `${tableName}_${timestamp}.sql`);
        fs.writeFileSync(tempFilePath, dump, 'utf8');
        
        // Загружаем в S3
        const s3Key = `service/dumps/${tableName}_${timestamp}.sql`;
        const s3Url = await this.s3Service.uploadFile(tempFilePath, s3Key);
        s3Links[tableName] = s3Url;
        
        // Удаляем временный файл
        fs.unlinkSync(tempFilePath);
      }
      
      // Финальный прогресс
      await this.adminBot.telegram.editMessageText(
        adminChatId,
        progressMessage.message_id,
        undefined,
        `💾 Создание полного дампа базы данных...\n\n` +
        `📊 Прогресс: ${this.getProgressBar(tables.length, tables.length)}\n` +
        `☁️ Загрузка в S3...`
      );
      
      // Создаем скрипт восстановления (до удаления директории)
      const restoreScript = this.createRestoreScript(tables, timestamp, s3Links);
      const restoreScriptPath = path.join(tempDir, `restore_${timestamp}.sh`);
      fs.writeFileSync(restoreScriptPath, restoreScript, 'utf8');
      
      const restoreScriptKey = `service/dumps/restore_${timestamp}.sh`;
      const restoreScriptUrl = await this.s3Service.uploadFile(restoreScriptPath, restoreScriptKey);
      
      // Удаляем временный скрипт
      fs.unlinkSync(restoreScriptPath);
      
      // Удаляем временную директорию, если пуста
      try {
        fs.rmdirSync(tempDir);
      } catch (e) {
        // Игнорируем ошибку, если директория не пуста
      }
      
      // Формируем сообщение со ссылками
      let message = `✅ Полный дамп базы данных создан и загружен в S3!\n\n` +
        `📅 Дата: ${this.getCurrentDateTime()}\n\n` +
        `📊 Статистика по таблицам:\n`;
      
      for (const tableName of tables) {
        const escapedTableName = tableName.replace(/_/g, '\\_');
        message += `\n📦 <b>${escapedTableName}</b>: ${rowCounts[tableName]} записей\n`;
        message += `   🔗 <a href="${s3Links[tableName]}">Скачать дамп</a>\n`;
      }
      
      message += `\n🔧 <a href="${restoreScriptUrl}">Скрипт восстановления</a>\n`;
      message += `\n💡 Все файлы сохранены в S3: service/dumps/`;
      
      await this.adminBot.telegram.editMessageText(
        adminChatId,
        progressMessage.message_id,
        undefined,
        message,
        { parse_mode: 'HTML' }
      );
      
    } catch (error) {
      console.error('Error creating full database dump:', error);
      await this.adminBot.telegram.sendMessage(
        adminChatId,
        `❌ Ошибка при создании дампа: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      client.release();
    }
  }

  // Создание дампа конкретной таблицы
  async createTableDump(tableName: string, adminChatId: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      const progressMessage = await this.adminBot.telegram.sendMessage(
        adminChatId,
        `💾 Создание дампа таблицы ${tableName}...\n\n` +
        '⏳ Чтение данных...'
      );
      
      const { dump, rowCount } = await this.createTableDumpContent(client, tableName);
      
      await this.adminBot.telegram.editMessageText(
        adminChatId,
        progressMessage.message_id,
        undefined,
        `💾 Создание дампа таблицы ${tableName}...\n\n` +
        `📊 Найдено записей: ${rowCount}\n` +
        `☁️ Загрузка в S3...`
      );
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const tempDir = path.join(__dirname, '../../temp_dumps');
      
      // Создаем временную директорию
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Сохраняем во временный файл
      const tempFilePath = path.join(tempDir, `${tableName}_${timestamp}.sql`);
      fs.writeFileSync(tempFilePath, dump, 'utf8');
      
      // Загружаем в S3
      const s3Key = `service/dumps/${tableName}_${timestamp}.sql`;
      const s3Url = await this.s3Service.uploadFile(tempFilePath, s3Key);
      
      // Удаляем временный файл
      fs.unlinkSync(tempFilePath);
      
      // Формируем сообщение со ссылкой
      const escapedTableName = tableName.replace(/_/g, '\\_');
      let message = `✅ Дамп таблицы <b>${escapedTableName}</b> успешно создан и загружен в S3!\n\n` +
        `📊 Записей: ${rowCount}\n` +
        `📅 ${this.getCurrentDateTime()}\n\n` +
        `🔗 <a href="${s3Url}">Скачать дамп</a>`;
      
      await this.adminBot.telegram.editMessageText(
        adminChatId,
        progressMessage.message_id,
        undefined,
        message,
        { parse_mode: 'HTML' }
      );
      
    } catch (error) {
      console.error(`Error creating dump for table ${tableName}:`, error);
      await this.adminBot.telegram.sendMessage(
        adminChatId,
        `❌ Ошибка при создании дампа таблицы ${tableName}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      client.release();
    }
  }

  // Создание SQL-дампа содержимого таблицы (с обработкой порциями)
  private async createTableDumpContent(client: any, tableName: string): Promise<{ dump: string; rowCount: number }> {
    // Получаем структуру таблицы
    const columnsResult = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [tableName]);
    
    const columns = columnsResult.rows.map((row: any) => row.column_name);
    
    // Получаем количество записей
    const countResult = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
    const totalRows = parseInt(countResult.rows[0].count, 10);
    
    const header = `-- Dump of table: ${tableName}\n` +
      `-- Generated at: ${this.getCurrentDateTime()}\n` +
      `-- Rows: ${totalRows}\n\n`;
    
    if (totalRows === 0) {
      return { dump: `${header}-- Table ${tableName} is empty\n\n`, rowCount: 0 };
    }
    
    const BATCH_SIZE = 1000; // Обрабатываем по 1000 записей за раз
    let dump = header + `-- Data for table: ${tableName}\n`;
    
    // Обрабатываем данные порциями, чтобы не загружать всю таблицу в память
    for (let offset = 0; offset < totalRows; offset += BATCH_SIZE) {
      const batchResult = await client.query(
        `SELECT * FROM ${tableName} ORDER BY (SELECT NULL) LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset]
      );
      const rows = batchResult.rows;
      
      // Генерируем INSERT-ы для текущей порции
      for (const row of rows) {
        const values = columns.map((col: string) => {
          const value = row[col];
          
          if (value === null || value === undefined) {
            return 'NULL';
          }
          
          if (typeof value === 'string') {
            return `'${value.replace(/'/g, "''")}'`;
          }
          
          if (value instanceof Date) {
            return `'${value.toISOString()}'`;
          }
          
          if (typeof value === 'boolean') {
            return value ? 'TRUE' : 'FALSE';
          }
          
          if (typeof value === 'object') {
            return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
          }
          
          return value.toString();
        });
        
        dump += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      
      // Освобождаем память после обработки порции
      rows.length = 0;
    }
    
    dump += '\n';
    
    return { dump, rowCount: totalRows };
  }

  // Создание скрипта восстановления
  private createRestoreScript(tables: string[], timestamp: string, s3Links: { [key: string]: string }): string {
    let script = `#!/bin/bash\n\n`;
    script += `# Скрипт восстановления базы данных из S3\n`;
    script += `# Создан: ${this.getCurrentDateTime()}\n\n`;
    script += `# Использование:\n`;
    script += `# 1. Установите переменные окружения для подключения к БД:\n`;
    script += `#    export PGHOST=localhost\n`;
    script += `#    export PGPORT=5432\n`;
    script += `#    export PGDATABASE=vividus\n`;
    script += `#    export PGUSER=postgres\n`;
    script += `#    export PGPASSWORD=password\n`;
    script += `# 2. Запустите скрипт: ./restore_${timestamp}.sh\n\n`;
    
    script += `set -e\n\n`;
    
    script += `echo "🔄 Начало восстановления базы данных из S3..."\n`;
    script += `echo ""\n\n`;
    
    script += `# Создаем временную директорию\n`;
    script += `TMP_DIR=$(mktemp -d)\n`;
    script += `trap "rm -rf $TMP_DIR" EXIT\n`;
    script += `cd $TMP_DIR\n`;
    script += `echo "📁 Временная директория: $TMP_DIR"\n`;
    script += `echo ""\n\n`;
    
    script += `# Скачиваем файлы из S3\n`;
    script += `echo "📥 Скачивание дампов из S3..."\n`;
    script += `echo ""\n`;
    
    // Скачивание файлов из S3
    for (const tableName of tables) {
      script += `echo "📦 Скачивание ${tableName}..."\n`;
      script += `curl -o "${tableName}_${timestamp}.sql" "${s3Links[tableName]}"\n`;
    }
    
    script += `\necho ""\n`;
    script += `echo "✅ Все файлы дампов скачаны"\n`;
    script += `echo ""\n\n`;
    
    script += `# Очистка таблиц (в правильном порядке, учитывая foreign keys)\n`;
    script += `echo "🗑️  Очистка существующих данных..."\n`;
    const reversedTables = [...tables].reverse();
    for (const tableName of reversedTables) {
      script += `psql -c "TRUNCATE TABLE ${tableName} CASCADE;" || true\n`;
    }
    
    script += `\necho ""\n`;
    script += `echo "📥 Восстановление данных..."\n`;
    script += `echo ""\n\n`;
    
    // Восстановление в правильном порядке (учитывая зависимости)
    const orderedTables = ['users', 'campaigns', 'orders', 'payments', 'did_jobs', 'campaign_stats', 'activity_logs'];
    for (const tableName of orderedTables) {
      if (tables.includes(tableName)) {
        script += `echo "📦 Восстановление таблицы: ${tableName}"\n`;
        script += `psql -f "${tableName}_${timestamp}.sql" -q\n`;
        script += `echo "✅ ${tableName} восстановлена"\n`;
        script += `echo ""\n`;
      }
    }
    
    script += `\necho ""\n`;
    script += `echo "✅ Восстановление базы данных завершено успешно!"\n`;
    script += `echo ""\n`;
    script += `echo "📊 Статистика:"\n`;
    
    for (const tableName of tables) {
      script += `echo -n "  • ${tableName}: "\n`;
      script += `psql -t -c "SELECT COUNT(*) FROM ${tableName};"\n`;
    }
    
    return script;
  }
}

