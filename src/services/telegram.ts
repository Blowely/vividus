import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { UserService } from './user';
import { OrderService } from './order';
import { PaymentService } from './payment';
import { FileService } from './file';
import { MockService } from './mock';
import { AnalyticsService } from './analytics';
import pool from '../config/database';

config();

export class TelegramService {
  private bot: Telegraf;
  private userService: UserService;
  private orderService: OrderService;
  private paymentService: PaymentService;
  private fileService: FileService;
  private mockService: MockService;
  private analyticsService: AnalyticsService;
  private pendingPrompts: Map<number, string> = new Map(); // userId -> fileId
  private pendingPromptsData: Map<number, { fileId: string; prompt: string }> = new Map(); // userId -> {fileId, prompt}
  private pendingMergeFirstPhoto: Map<number, string> = new Map(); // userId -> fileId (для режима объединения)
  private combineAndAnimatePhotos: Map<number, string[]> = new Map(); // userId -> fileId[] (для режима объединить и оживить)
  private combineAndAnimateState: Map<number, { combineType?: string; animationType?: string; combinePrompt?: string; animationPrompt?: string; waitingForCombinePrompt?: boolean; waitingForAnimationPrompt?: boolean }> = new Map(); // userId -> состояние
  private userMessages: Map<number, { messageId: number; chatId: number }> = new Map(); // userId -> {messageId, chatId}
  private waitingForEmail: Set<number> = new Set(); // userId -> waiting for email input
  private animateV2State: Map<number, { waitingForPhoto: boolean; waitingForPrompt: boolean; photoFileId?: string }> = new Map(); // userId -> состояние для Оживить v2

  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    this.userService = new UserService();
    this.orderService = new OrderService();
    this.paymentService = new PaymentService();
    this.fileService = new FileService();
    this.mockService = new MockService();
    this.analyticsService = new AnalyticsService();
    
    this.setupHandlers();
  }

  // Проверяет, является ли ошибка ошибкой блокировки бота
  private isBlockedError(error: any): boolean {
    return error?.response?.error_code === 403 && 
           (error?.response?.description?.includes('bot was blocked') || 
            error?.response?.description?.includes('Forbidden: bot was blocked'));
  }

  // Простой метод для отправки сообщений (без редактирования)
  private async sendMessage(ctx: Context, text: string, extra?: any): Promise<void> {
    try {
      const extraWithKeyboard = this.ensureReplyKeyboard(ctx, extra);
      await ctx.reply(text, extraWithKeyboard);
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        console.log(`Bot is blocked by user ${ctx.from?.id}, skipping message`);
        return;
      }
      throw error;
    }
  }

  private ensureReplyKeyboard(ctx: Context, extra?: any): any {
    // Если в extra уже есть remove_keyboard - используем как есть (явное удаление)
    if (extra?.reply_markup?.remove_keyboard) {
      return extra;
    }
    
    // Если в extra уже есть keyboard - используем как есть
    if (extra?.reply_markup?.keyboard) {
      return extra;
    }
    
    // Если есть inline_keyboard - не добавляем reply-клавиатуру в том же сообщении
    // (в Telegram нельзя одновременно использовать оба типа в одном сообщении)
    // Но reply-клавиатура останется из предыдущих сообщений
    if (extra?.reply_markup?.inline_keyboard) {
      return extra;
    }
    
    // Если нет reply_markup вообще - добавляем главную клавиатуру
    if (!extra?.reply_markup) {
      return {
        ...extra,
        reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
      };
    }
    
    return extra;
  }


  private formatLink(url: string, text: string = 'Ссылка'): string {
    return `<a href="${url}">${text}</a>`;
  }

  private getBackButton(): any[] {
    return [Markup.button.callback('◀️ Вернуться', 'back_to_menu')];
  }

  private getMainReplyKeyboard(userId: number): any {
    const keyboard = [];
    
    // Первая строка - кнопка новой нейросети для всех пользователей
    keyboard.push([Markup.button.text('🎬 Оживить фото')]);
    
    // Добавляем кнопку "Объединить и оживить" для админов под кнопкой "Оживить фото"
    if (this.isAdmin(userId)) {
      keyboard.push([Markup.button.text('🔀 Объединить и оживить')]);
    }
    
    keyboard.push([Markup.button.text('✨ Купить оживления'), Markup.button.text('❓ Поддержка')]);

    // Добавляем кнопки для админов
    if (this.isAdmin(userId)) {
      keyboard.push([Markup.button.text('📊 Статистика')]);
    }

    return {
      keyboard: keyboard,
      resize_keyboard: true
    };
  }

  // Публичный метод для отправки сообщений с сохранением reply-клавиатуры
  // Используется из других сервисов (PaymentService, ProcessorService)
  public async sendMessageWithKeyboard(telegramId: number, message: string, extra?: any): Promise<void> {
    try {
      // Получаем клавиатуру для пользователя
      const client = await pool.connect();
      try {
        const userResult = await client.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
        const userId = userResult.rows[0]?.id || null;
        
        // Если пользователь найден, добавляем клавиатуру
        const replyMarkup = userId ? this.getMainReplyKeyboard(telegramId) : undefined;
        
        await this.bot.telegram.sendMessage(telegramId, message, {
          ...extra,
          reply_markup: extra?.reply_markup || replyMarkup
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        console.log(`Bot is blocked by user ${telegramId}, skipping message`);
        return;
      }
      console.error(`Error sending message to user ${telegramId}:`, error);
      throw error;
    }
  }

  private setupHandlers() {
    // Auto-welcome for new users (only for non-command messages)
    this.bot.use(async (ctx, next) => {
      if (ctx.from && ctx.message && 'text' in ctx.message && !ctx.message.text.startsWith('/')) {
        const user = await this.userService.getUserByTelegramId(ctx.from.id);
        if (!user) {
          // New user - show welcome message
          await this.handleStart(ctx);
          return;
        }
      }
      return next();
    });
    
    // Start command
    this.bot.start(this.handleStart.bind(this));
    
    // Help command
    this.bot.help(this.handleHelp.bind(this));
    
    // Mock payment command (for testing)
    this.bot.command('mock_pay', this.handleMockPayment.bind(this));
    
    // Orders command
    this.bot.command('orders', this.showUserOrders.bind(this));
    
    // Analytics command (admin only)
    this.bot.command('stats', this.showAnalytics.bind(this));
    
    // Photo handler
    this.bot.on('photo', this.handlePhoto.bind(this));
    
    // Video handler
    this.bot.on('video', this.handleVideo.bind(this));
    
    // Animation handler (GIF)
    this.bot.on('animation', this.handleAnimation.bind(this));
    
    // Document handler (for other image formats)
    this.bot.on('document', this.handleDocument.bind(this));
    
    // Text handler for prompts
    this.bot.on('text', this.handleText.bind(this));
    
    // Callback query handler
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    
    // Pre-checkout query handler (для оплаты звездами)
    this.bot.on('pre_checkout_query', this.handlePreCheckoutQuery.bind(this));
    
    // Successful payment handler (для оплаты звездами)
    this.bot.on('successful_payment', this.handleSuccessfulPayment.bind(this));
    
    // Error handler
    this.bot.catch(async (err, ctx) => {
      console.error('Bot error:', err);
      // Не пытаемся отправить сообщение, если бот заблокирован пользователем
      if (this.isBlockedError(err)) {
        console.log(`Bot is blocked by user ${ctx.from?.id}, skipping error message`);
        return;
      }
      if (ctx.from && ctx.chat) {
        try {
          await this.sendMessage(ctx, 'Произошла ошибка. Попробуйте позже.');
        } catch (error: any) {
          // Игнорируем ошибки отправки в обработчике ошибок
          if (!this.isBlockedError(error)) {
            console.error('Error sending error message:', error);
          }
        }
      }
    });
  }

  private async handleStart(ctx: Context) {
    // Получаем параметр из команды /start
    // Поддерживаем как /start param, так и deep links через ctx.startParam
    let startParam = null;
    if (ctx.message && 'text' in ctx.message) {
      const textParts = ctx.message.text.split(' ');
      if (textParts.length > 1) {
        startParam = textParts[1];
      }
    }
    // Также проверяем deep link параметр
    if (!startParam && (ctx as any).startParam) {
      startParam = (ctx as any).startParam;
    }
    
    // Сначала создаем пользователя с startParam, чтобы он был учтен в статистике
    const user = await this.userService.getOrCreateUser(ctx.from!, startParam || undefined);
    
    // После создания пользователя обновляем статистику кампании
    if (startParam) {
      console.log(`User ${ctx.from?.id} started bot with parameter: ${startParam}`);
      await this.analyticsService.updateCampaignStats(startParam);
    }
    
    // Логируем права админа
    const isAdminUser = this.isAdmin(ctx.from!.id);
    console.log(`User ${ctx.from?.id} (${ctx.from?.username || 'no username'}) is admin: ${isAdminUser}`);
    
    await this.showMainMenu(ctx);
  }

  private async showMainMenu(ctx: Context) {
    const welcomeMessage = `
🎬 Добро пожаловать в Vividus Bot!

Я помогу оживить ваши фотографии с помощью нейросети.

📸 Как это работает:
1️⃣ Отправьте фото
2️⃣ Оплатите заказ, опишите анимацию или используйте базовую анимацию
3️⃣ Получите видео через 2-5 минут!

📢 Подписывайтесь на наш канал с инструкциями и рекомендациями: @vividusgo
❗️Поддержка 24/7: @vividusgosupp

👉 Начните с отправки фото:`;
    
    // Получаем баланс генераций
    const user = await this.userService.getOrCreateUser(ctx.from!);
    const generations = await this.userService.getUserGenerations(ctx.from!.id);

    // Сначала отправляем приветственное видео
    try {
      await ctx.replyWithVideo('https://storage.yandexcloud.net/vividus/service/IMG_2187.mp4', {
        caption: '🎬 Пример обработки старого фото'
      });
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        console.log(`Bot is blocked by user ${ctx.from?.id}, skipping welcome video`);
        return;
      }
      // Игнорируем ошибки отправки видео, но продолжаем отправку приветствия
      console.error('Error sending welcome video:', error);
    }

    // Для приветствия всегда отправляем новое сообщение (не редактируем)
    try {
      const message = await ctx.reply(welcomeMessage, {
          reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
        });
      // Сохраняем message_id для последующих сообщений
      if (ctx.from) {
        this.userMessages.set(ctx.from.id, { messageId: message.message_id, chatId: message.chat.id });
      }
    } catch (error: any) {
      if (this.isBlockedError(error)) {
        console.log(`Bot is blocked by user ${ctx.from?.id}, skipping welcome message`);
        return;
      }
      throw error;
    }
  }

  private async handleHelp(ctx: Context) {
    const userId = ctx.from!.id;
    const helpMessage = `
❓ Помощь по использованию бота

📸 Как использовать:
1. Отправьте фото (JPG, PNG)
2. Дождитесь обработки
3. Получите анимированное видео!

⏱️ Время обработки: 2-5 минут

💬 По вопросам обращайтесь: @vividusgosupp
🆔 Ваш ID: ${userId}

Для начала отправьте фото!`;
    
        await this.sendMessage(ctx, helpMessage, {
          reply_markup: {
            inline_keyboard: [this.getBackButton()]
          }
        });
  }

  private async handlePhoto(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      const photo = (ctx.message as any)['photo'];
      const document = (ctx.message as any)['document'];
      
      let fileId: string;
      
      // Если это фото, получаем file_id из массива фото
      if (photo && Array.isArray(photo) && photo.length > 0) {
        // Get the highest quality photo
        fileId = photo[photo.length - 1].file_id;
      } else if (document && document.file_id) {
        // Если это документ (изображение), получаем file_id из документа
        fileId = document.file_id;
      } else {
        await this.sendMessage(ctx, '❌ Не удалось получить изображение. Пожалуйста, отправьте фото заново.');
        return;
      }
      
      // Проверяем, является ли это частью медиа-группы
      const mediaGroupId = (ctx.message as any)['media_group_id'];
      if (mediaGroupId) {
        // Это медиа-группа - обрабатываем через handleMediaGroup логику
        await this.handleMediaGroupPhoto(ctx, user, fileId, mediaGroupId);
        return;
      }
      
      // Проверяем, находимся ли мы в режиме "Оживить v2"
      // ВАЖНО: используем ctx.from!.id (number), а не user.telegram_id (может быть string)
      const userId = ctx.from!.id;
      console.log(`📸 Обработка фото от пользователя ${userId}`);
      console.log(`   Все ключи в animateV2State Map:`, Array.from(this.animateV2State.keys()));
      const animateV2State = this.animateV2State.get(userId);
      console.log(`   animateV2State для ${userId}:`, JSON.stringify(animateV2State));
      if (animateV2State && animateV2State.waitingForPhoto) {
        console.log(`✅ Режим Оживить v2 активен для пользователя ${userId}`);
        
        // Проверяем наличие caption (текста, прикрепленного к фото)
        const caption = (ctx.message as any)['caption'];
        
        if (caption) {
          // Если есть caption, сразу обрабатываем его как промпт
          this.animateV2State.set(userId, { 
            waitingForPhoto: false, 
            waitingForPrompt: false, 
            photoFileId: fileId 
          });
          await this.processAnimateV2Prompt(ctx, user, fileId, caption);
        } else {
          // Если нет caption, просим ввести промпт
          this.animateV2State.set(userId, { 
            waitingForPhoto: false, 
            waitingForPrompt: true, 
            photoFileId: fileId 
          });
          
          const promptMessage = `📸 Фото получено!

✍️ Напишите, как оживить изображение:

Примеры:
• Персонажи на фото улыбаются и обнимаются 🤗
• Человек слегка кивает и улыбается 😊
• Девушка моргает и немного поворачивает голову 💫

📌 Важно:
• Используйте описания «мужчина слева», «женщина справа», «ребёнок в центре»
• Не пишите «я», «мы», «сестра» и т.п.
• Если на фото нет человека — не указывайте его

📏 Требования к фото:
• Минимальный размер: 300x300 пикселей
• Формат: JPG или PNG`;
          
          await this.sendMessage(ctx, promptMessage, {
            reply_markup: {
              inline_keyboard: [
                [Markup.button.callback('✨ Использовать базовую анимацию', 'skip_prompt_v2')],
                this.getBackButton()
              ]
            }
          });
          
          // Отправляем невидимое сообщение с reply-клавиатурой
          setTimeout(async () => {
            try {
              await ctx.reply('\u200B', {
                reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
              });
            } catch (e: any) {
              if (this.isBlockedError(e)) {
                console.log(`Bot is blocked by user ${ctx.from?.id}, skipping keyboard message`);
              }
            }
          }, 500);
        }
        return;
      }
      
      // Проверяем, находимся ли мы в режиме объединить и оживить
      const combinePhotos = this.combineAndAnimatePhotos.get(user.telegram_id);
      if (combinePhotos !== undefined) {
        // Проверяем права админа
        if (!this.isAdmin(ctx.from!.id)) {
          // Очищаем состояние, если пользователь не админ
          this.combineAndAnimatePhotos.delete(user.telegram_id);
          this.combineAndAnimateState.delete(user.telegram_id);
          await this.sendMessage(ctx, '❌ У вас нет доступа к этой функции.');
          return;
        }
        
        // Добавляем фото в список (ровно 2 фото)
        if (combinePhotos.length < 2) {
          combinePhotos.push(fileId);
          this.combineAndAnimatePhotos.set(user.telegram_id, combinePhotos);
          
          if (combinePhotos.length === 1) {
            await this.sendMessage(ctx, `Принял 1/2. Пришлите ещё одно изображение.`);
          } else if (combinePhotos.length === 2) {
            // Оба фото получены, запрашиваем промпт для анимации
            await this.requestAnimationPrompt(ctx);
          }
          return;
        } else {
          // Уже есть 2 фото, игнорируем остальные
          await this.sendMessage(ctx, 'ℹ️ Уже получено 2 фото. Если случайно отправили больше — бот возьмёт первые два.');
          return;
        }
      }
      
      // Проверяем, находимся ли мы в режиме объединения (старый режим merge)
      // ВАЖНО: Этот режим не должен активироваться для обычных пользователей
      // Он используется только для старого функционала объединения, который сейчас заменен на combine_and_animate
      const firstPhotoId = this.pendingMergeFirstPhoto.get(user.telegram_id);
      if (firstPhotoId && firstPhotoId !== 'MERGE_MODE_WAITING') {
        // Проверяем, что это действительно режим merge (есть pendingPromptsData с merge:)
        const promptData = this.pendingPromptsData.get(user.telegram_id);
        if (promptData && promptData.prompt.startsWith('merge:')) {
          // Это второе фото в режиме merge, обрабатываем объединение
          await this.handleMergeSecondPhoto(ctx, user, fileId);
          return;
        } else {
          // Состояние merge осталось, но это не merge - очищаем его
          console.log(`⚠️ Очищаю застрявшее состояние merge для пользователя ${user.telegram_id}`);
          this.pendingMergeFirstPhoto.delete(user.telegram_id);
          this.pendingPromptsData.delete(user.telegram_id);
        }
      } else if (firstPhotoId === 'MERGE_MODE_WAITING') {
        // Это первое фото в режиме объединения
        this.pendingMergeFirstPhoto.set(user.telegram_id, fileId);
        await this.sendMessage(ctx, '📸 Первое фото получено! Теперь отправьте второе фото.');
        return;
      }
      
      // Проверяем наличие caption (текста, прикрепленного к фото)
      const caption = (ctx.message as any)['caption'];
      
      if (caption) {
        // Если есть caption, сразу обрабатываем его как промпт
      this.pendingPrompts.set(user.telegram_id, fileId);
        await this.processPrompt(ctx, user, caption);
      } else {
        // Если нет caption, просим ввести промпт
        const promptMessage = `📸 Фото получено!

✍️ Напишите, как оживить изображение:

Примеры:
• Персонажи на фото улыбаются и обнимаются 🤗
• Человек слегка кивает и улыбается 😊
• Девушка моргает и немного поворачивает голову 💫

📌 Важно:
• Используйте описания «мужчина слева», «женщина справа», «ребёнок в центре»
• Не пишите «я», «мы», «сестра» и т.п.
• Если на фото нет человека — не указывайте его

📏 Требования к фото:
• Минимальный размер: 300x300 пикселей
• Формат: JPG или PNG`;
        
        await this.sendMessage(ctx, promptMessage, {
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('✨ Использовать базовую анимацию', 'skip_prompt')],
              this.getBackButton()
            ]
          }
        });
        
        // Отправляем невидимое сообщение с reply-клавиатурой, чтобы она всегда была видна
        // (после inline-сообщений reply-клавиатура может пропасть)
        setTimeout(async () => {
          try {
            await ctx.reply('\u200B', {
              reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
            });
          } catch (e: any) {
            // Игнорируем ошибки (клавиатура уже может быть видна или бот заблокирован)
            if (this.isBlockedError(e)) {
              console.log(`Bot is blocked by user ${ctx.from?.id}, skipping keyboard message`);
            }
          }
        }, 500);
        
        // Store file ID for later processing
        this.pendingPrompts.set(user.telegram_id, fileId);
      }
      
    } catch (error) {
      console.error('Error handling photo:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке фото. Попробуйте позже.');
    }
  }

  private async handleMediaGroupPhoto(ctx: Context, user: any, fileId: string, mediaGroupId: string): Promise<void> {
    try {
      // Проверяем, находимся ли мы в режиме объединить и оживить
      const combinePhotos = this.combineAndAnimatePhotos.get(user.telegram_id);
      if (combinePhotos !== undefined) {
        // Проверяем права админа
        if (!this.isAdmin(ctx.from!.id)) {
          // Очищаем состояние, если пользователь не админ
          this.combineAndAnimatePhotos.delete(user.telegram_id);
          this.combineAndAnimateState.delete(user.telegram_id);
          return;
        }
        
        // Используем mediaGroupId для группировки фото из одного альбома
        // Создаем ключ для хранения фото из этой медиа-группы
        const mediaGroupKey = `combine_${user.telegram_id}_${mediaGroupId}`;
        
        // Получаем или создаем массив фото для этой медиа-группы
        if (!(global as any).combineMediaGroups) {
          (global as any).combineMediaGroups = new Map();
        }
        
        let groupPhotos = (global as any).combineMediaGroups.get(mediaGroupKey) || [];
        
        // Добавляем фото, если его еще нет в группе (избегаем дубликатов)
        if (!groupPhotos.includes(fileId)) {
          groupPhotos.push(fileId);
          (global as any).combineMediaGroups.set(mediaGroupKey, groupPhotos);
        }
        
        // Берем только первые 2 фото из группы
        const photosToUse = groupPhotos.slice(0, 2);
        
        // Обновляем основной список фото для режима combine_and_animate
        this.combineAndAnimatePhotos.set(user.telegram_id, photosToUse);
        
        // Если получили 2 фото, запрашиваем промпт (с задержкой, чтобы все фото из группы успели обработаться)
        if (photosToUse.length === 2) {
          // Проверяем, не запрашивали ли уже промпт для этой группы
          const state = this.combineAndAnimateState.get(user.telegram_id) || {};
          if (!state.waitingForAnimationPrompt) {
            // Небольшая задержка, чтобы все фото из группы успели обработаться
            setTimeout(async () => {
              // Проверяем еще раз, что у нас есть 2 фото
              const currentPhotos = this.combineAndAnimatePhotos.get(user.telegram_id) || [];
              if (currentPhotos.length >= 2) {
                await this.requestAnimationPrompt(ctx);
              }
              // Очищаем временное хранилище для этой медиа-группы
              if ((global as any).combineMediaGroups) {
                (global as any).combineMediaGroups.delete(mediaGroupKey);
              }
            }, 1500);
          }
        }
        return;
      }
      
      // Для медиа-групп используем специальный ключ с mediaGroupId
      const mergeKey = `merge_${user.telegram_id}_${mediaGroupId}`;
      const storedData = this.pendingMergeFirstPhoto.get(user.telegram_id);
      
      // Проверяем, сохранили ли мы уже первое фото из этой группы
      // Используем простую логику: если нет сохраненного фото или это маркер ожидания, сохраняем первое
      if (!storedData || storedData === 'MERGE_MODE_WAITING' || !storedData.toString().includes(mediaGroupId)) {
        // Это первое фото из группы, сохраняем его с привязкой к mediaGroupId
        this.pendingMergeFirstPhoto.set(user.telegram_id, `${mediaGroupId}:${fileId}`);
        // Не отправляем сообщение сразу, ждем второе фото
      } else if (storedData.toString().startsWith(mediaGroupId + ':')) {
        // Это второе фото из группы - извлекаем первое и обрабатываем объединение
        const firstFileId = storedData.toString().replace(`${mediaGroupId}:`, '');
        this.pendingMergeFirstPhoto.delete(user.telegram_id);
        
        // Обрабатываем объединение
        await this.handleMergeSecondPhoto(ctx, user, fileId, firstFileId);
      } else {
        // Неожиданная ситуация, сохраняем текущее как первое
        this.pendingMergeFirstPhoto.set(user.telegram_id, `${mediaGroupId}:${fileId}`);
      }
    } catch (error) {
      console.error('Error handling media group photo:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке медиа-группы. Попробуйте позже.');
    }
  }

  private async handleVideo(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Проверяем режим рассылки для админа
      // Для обычных пользователей видео не обрабатываются
      await this.sendMessage(ctx, '❌ Пожалуйста, отправьте фото (не видео) для создания анимации.');
    } catch (error) {
      console.error('Error handling video:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке видео.');
    }
  }

  private async handleAnimation(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Для обычных пользователей GIF не обрабатываются
      await this.sendMessage(ctx, '❌ Пожалуйста, отправьте фото (не GIF) для создания анимации.');
    } catch (error) {
      console.error('Error handling animation:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке GIF.');
    }
  }

  private async handleDocument(ctx: Context) {
    const user = await this.userService.getOrCreateUser(ctx.from!);
    
    const document = (ctx.message as any)['document'];
    const mimeType = document.mime_type;
    
    if (mimeType && mimeType.startsWith('image/')) {
      await this.handlePhoto(ctx);
    } else {
      await this.sendMessage(ctx, '❌ Пожалуйста, отправьте изображение в формате JPG или PNG.');
    }
  }

  private async handleMergeMode(ctx: Context): Promise<void> {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const message = `🔄 Режим объединения двух фото

📸 Как это работает:
1️⃣ Отправьте первое фото (или сразу два фото подряд в одном сообщении)
2️⃣ Отправьте второе фото (если еще не отправили)
3️⃣ Введите промпт для анимации (опционально)
4️⃣ Получите видео с плавным переходом между фото!

💡 Вы можете отправить оба фото сразу в одном сообщении (выделите оба фото при отправке).`;
      
      await this.sendMessage(ctx, message);
      
      // Сбрасываем состояние и устанавливаем флаг режима объединения
      // Сохраняем специальный маркер, что мы в режиме merge
      this.pendingMergeFirstPhoto.delete(user.telegram_id);
      // Используем специальное значение для индикации режима merge без первого фото
      this.pendingMergeFirstPhoto.set(user.telegram_id, 'MERGE_MODE_WAITING');
      
    } catch (error) {
      console.error('Error handling merge mode:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка. Попробуйте позже.');
    }
  }

  private async handleMergeSecondPhoto(ctx: Context, user: any, secondFileId: string, providedFirstFileId?: string): Promise<void> {
    try {
      // Если firstFileId передан напрямую (из медиа-группы), используем его
      // Иначе получаем из pendingMergeFirstPhoto
      let firstPhotoId = providedFirstFileId;
      
      if (!firstPhotoId) {
        const storedData = this.pendingMergeFirstPhoto.get(user.telegram_id);
        
        if (storedData) {
          // Очищаем mediaGroupId префикс если есть
          if (storedData.toString().includes(':')) {
            firstPhotoId = storedData.toString().split(':').slice(1).join(':');
          } else {
            firstPhotoId = storedData as string;
          }
        }
      }
      
      if (!firstPhotoId || firstPhotoId === 'MERGE_MODE_WAITING') {
        // Если первое фото потеряно или еще не было получено, сохраняем текущее как первое
        this.pendingMergeFirstPhoto.set(user.telegram_id, secondFileId);
        await this.sendMessage(ctx, '📸 Первое фото сохранено! Теперь отправьте второе фото.');
        return;
      }

      // Оба фото получены, убираем из ожидания
      this.pendingMergeFirstPhoto.delete(user.telegram_id);

      const mergePromptMessage = `📸 Оба фото получены!

✍️ Напишите, как анимировать переход между фото:

Примеры:
• Плавный переход и вращение 🔄
• Масштабирование с эффектом затухания ✨
• Морфинг между изображениями 🎭

📌 Важно:
• Опишите желаемый эффект перехода
• Можно комбинировать несколько эффектов`;
      
      await this.sendMessage(ctx, mergePromptMessage);
      
      // Сохраняем оба fileId в специальную структуру для merge заказа
      this.pendingPromptsData.set(user.telegram_id, { 
        fileId: firstPhotoId, 
        prompt: `merge:${secondFileId}` // Используем специальный формат для merge
      });
      this.pendingPrompts.set(user.telegram_id, firstPhotoId);
      
      await this.sendMessage(ctx, '💡 Вы можете отправить промпт или нажать кнопку для базовой анимации.', {
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('✨ Использовать базовую анимацию', 'skip_prompt_merge')],
            this.getBackButton()
          ]
        }
      });

    } catch (error) {
      console.error('Error handling merge second photo:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке второго фото. Попробуйте позже.');
    }
  }

  private async processPrompt(ctx: Context, user: any, promptText: string): Promise<void> {
    try {
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        await this.sendMessage(ctx, '❌ Фото не найдено. Отправьте фото заново!');
        return;
      }
      
      // Очищаем застрявшее состояние merge, если оно есть (для обычного оживления не нужно)
      const firstPhotoId = this.pendingMergeFirstPhoto.get(user.telegram_id);
      const promptData = this.pendingPromptsData.get(user.telegram_id);
      if (firstPhotoId || (promptData && promptData.prompt.startsWith('merge:'))) {
        console.log(`⚠️ Очищаю застрявшее состояние merge при обычном оживлении для пользователя ${user.telegram_id}`);
        this.pendingMergeFirstPhoto.delete(user.telegram_id);
        if (promptData && promptData.prompt.startsWith('merge:')) {
          this.pendingPromptsData.delete(user.telegram_id);
        }
      }
      
      // Remove from pending prompts
      this.pendingPrompts.delete(user.telegram_id);
      
      // Для fal.ai отправляем изображение как есть (без обработки)
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId, true);
      
      // Process the prompt
      let processedPrompt = promptText.toLowerCase().trim();
      const originalPrompt = promptText;
      
      if (processedPrompt === 'пропустить' || processedPrompt === 'skip') {
        processedPrompt = 'everyone in the photo is waving hand, subtle movements and breathing effect';
      } else {
        // Translate Russian prompts to English for better AI understanding
        let translatedPrompt = this.translatePrompt(processedPrompt);
        
        // Убираем "animate this image with" если пользователь уже его указал
        translatedPrompt = translatedPrompt.replace(/^animate this image with\s*/i, '');
        
        // Всегда добавляем базовую часть "animate this image with"
        processedPrompt = `animate this image with ${translatedPrompt}`;
      }
      
      // Проверяем баланс генераций пользователя
      const userGenerations = await this.userService.getUserGenerations(user.telegram_id);
      
      if (userGenerations >= 1) {
        // Создаем заказ со статусом processing (без оплаты)
        // Финальная проверка баланса будет выполнена в processOrder перед началом обработки
        const order = await this.orderService.createOrder(user.id, s3Url, processedPrompt);
        await this.orderService.updateOrderStatus(order.id, 'processing' as any);
        
        // Объединенное сообщение о промпте, создании заказа и начале генерации
        const displayPrompt = (originalPrompt === 'пропустить' || originalPrompt === 'skip') 
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания' 
          : originalPrompt;
        await this.sendMessage(ctx, `🎬 Отлично! Промпт: "${displayPrompt}"\n\n✅ Заказ создан\n🎬 Начинаю оживление видео...\n\n⏳ Это займет 2-5 минут.`);
      
        // Запускаем обработку заказа (списание оживлений произойдет при успешном оживлении)
        const { ProcessorService } = await import('./processor');
        const processorService = new ProcessorService();
        await processorService.processOrder(order.id);
      } else {
        // У пользователя нет генераций - предлагаем купить генерации
        
        // Сохраняем fileId и промпт для повторной обработки после покупки генераций
        this.pendingPrompts.set(user.telegram_id, fileId);
        this.pendingPromptsData.set(user.telegram_id, { fileId, prompt: originalPrompt || 'пропустить' });
        
        const displayPromptForMessage = (originalPrompt === 'пропустить' || originalPrompt === 'skip' || !originalPrompt)
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания'
          : originalPrompt;
        const noGenerationsMessage = `💼 У вас нет оживлений фото для обработки

📸 Ваше фото сохранено и готово к обработке
🎬 Промпт: "${displayPromptForMessage}"

Выберите способ оплаты:`;
        
        // Пакеты генераций (оригинальные цены)
        const packages = [
          { count: 1, originalPrice: 169 },
          { count: 3, originalPrice: 507 },
          { count: 5, originalPrice: 845 },
          { count: 10, originalPrice: 1690 }
        ];
        
        // Коэффициент скидки: 89/169 ≈ 0.5266 (скидка ~47.34%)
        const discountCoefficient = 89 / 169;
        
        const keyboard = packages.map(pkg => {
          // Используем цену со скидкой как финальную цену (оригинальная * 89/169)
          const discountedPrice = Math.round(pkg.originalPrice * discountCoefficient);
          const buttonText = `${discountedPrice}₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)}`;
          return [
            Markup.button.callback(
              buttonText,
              `buy_and_process_${pkg.count}_${discountedPrice}`
            )
          ];
        });
        
        keyboard.push(this.getBackButton());
        
        await this.sendMessage(ctx, noGenerationsMessage, {
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      }
      
    } catch (error) {
      console.error('Error processing prompt:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке промпта. Попробуйте позже.');
    }
  }

  private async handleText(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const text = (ctx.message as any).text;
      
      console.log(`📝 handleText: пользователь ${ctx.from!.id}, текст: "${text}"`);
      
      // Проверяем, ожидает ли пользователь ввода email
      if (this.waitingForEmail.has(ctx.from!.id)) {
        await this.processEmailInput(ctx, text);
        return;
      }
      
      // Проверяем, ожидает ли пользователь промпт для анимации в режиме combine_and_animate
      const combineState = this.combineAndAnimateState.get(user.telegram_id);
      if (combineState && combineState.waitingForAnimationPrompt) {
        // Проверяем права админа
        if (!this.isAdmin(ctx.from!.id)) {
          this.combineAndAnimatePhotos.delete(user.telegram_id);
          this.combineAndAnimateState.delete(user.telegram_id);
          await this.sendMessage(ctx, '❌ У вас нет доступа к этой функции.');
          return;
        }
        
        const photos = this.combineAndAnimatePhotos.get(user.telegram_id) || [];
        
        if (photos.length < 2) {
          await this.sendMessage(ctx, '❌ Нужно отправить 2 фото. Начните заново.');
          this.combineAndAnimatePhotos.delete(user.telegram_id);
          this.combineAndAnimateState.delete(user.telegram_id);
          return;
        }
        
        // Берем только первые 2 фото
        const twoPhotos = photos.slice(0, 2);
        
        combineState.animationPrompt = text;
        combineState.waitingForAnimationPrompt = false;
        this.combineAndAnimateState.set(user.telegram_id, combineState);
        
        await this.sendMessage(ctx, 'Объединяю фото и готовлю видео, это займет до 5 минут...');
        await this.createCombineAndAnimateOrder(ctx, user, twoPhotos, combineState);
        return;
      }
      
      // Обрабатываем команды от reply кнопок
      // Оживить фото - новая нейросеть для всех пользователей
      if (text === '🎬 Оживить фото') {
        console.log(`👤 Пользователь ${ctx.from!.id} нажал "Оживить фото"`);
        const userId = ctx.from!.id;
        const state = { waitingForPhoto: true, waitingForPrompt: false };
        this.animateV2State.set(userId, state);
        console.log(`✅ Состояние animateV2State установлено для пользователя ${userId}`);
        console.log(`   Проверка сразу после set: ${JSON.stringify(this.animateV2State.get(userId))}`);
        console.log(`   Все ключи и типы:`, Array.from(this.animateV2State.keys()).map(k => `${k} (${typeof k})`));
        await this.sendMessage(ctx, '📸 Отправьте фото для создания анимации!');
        return;
      }
      
      // Объединить и оживить - только для админов
      if (text === '🔀 Объединить и оживить') {
        // Проверяем права админа
        if (!this.isAdmin(ctx.from!.id)) {
          await this.sendMessage(ctx, '❌ У вас нет доступа к этой функции.');
          return;
        }
        
        // Инициализируем режим объединить и оживить
        this.combineAndAnimatePhotos.set(user.telegram_id, []);
        this.combineAndAnimateState.set(user.telegram_id, {});
        
        const instructions = `🔀 ОБЪЕДИНИТЬ И ОЖИВИТЬ

ВАЖНО:
Функция совмещает 2 фотографии и рисует сцену с нуля, чтобы создать современный общий кадр или видео.

⚠️ Возможны небольшие неточности: лицо, выражение или детали внешности могут слегка измениться.

📸 ТРЕБОВАНИЯ К ФОТО:
• Фото в нормальном положении — не перевёрнутые и не боком
• Без рамок и без лишних элементов (текста, логотипов, фонов)
• Лицо должно быть чётко видно, хорошо освещено, без сильных теней
• Если на фото больше одного человека — нейросеть иногда может добавить лишнее лицо
• Рекомендуется: на каждом фото 1 человек — так соединение получится точнее

📤 КАК ОТПРАВЛЯТЬ:
• РОВНО 2 изображения
• Можно отправить одним альбомом из 2 фото или по одному сообщению
• Принимаются как фото, так и документ
• Форматы: JPG/JPEG/PNG

ℹ️ Если случайно пришлёте больше 2 — бот автоматически возьмёт первые два, а остальные проигнорирует.`;
        
        await this.sendMessage(ctx, instructions);
        return;
      }
      
      if (text === '✨ Купить оживления') {
        await this.handleBuyGenerations(ctx);
        return;
      }
      
      if (text === '📋 Мои заказы') {
        await this.showUserOrders(ctx);
        return;
      }
      
      if (text === '⚙️ Настройки') {
        await this.handleSettings(ctx);
        return;
      }
      
      if (text === '❓ Поддержка') {
        await this.handleHelp(ctx);
        return;
      }
      
      if (text === '🎬 Получить результат') {
        await this.handleGetResult(ctx);
        return;
      }
      
      if (text === '🧪 Тестовая оплата') {
        await this.handleTestPayment(ctx);
        return;
      }
      
      if (text === '📊 Статистика' && this.isAdmin(ctx.from!.id)) {
        await this.showAnalytics(ctx);
        return;
      }
      
      // Проверяем, ожидает ли пользователь ввода промпта для "Оживить v2"
      const userId = ctx.from!.id;
      const animateV2State = this.animateV2State.get(userId);
      if (animateV2State && animateV2State.waitingForPrompt && animateV2State.photoFileId) {
        console.log(`✍️ Получен промпт для Оживить v2 от пользователя ${userId}: "${text}"`);
        await this.processAnimateV2Prompt(ctx, user, animateV2State.photoFileId, text);
        return;
      }
      
      // Check if user has pending photo
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        // User doesn't have pending photo, treat as regular message
        await this.sendMessage(ctx, '📸 Отправьте фото для создания анимации!');
        return;
      }
      
      // Проверяем, является ли это промптом для объединения (старый режим merge)
      // ВАЖНО: Проверяем не только prompt, но и наличие первого фото в pendingMergeFirstPhoto
      const promptData = this.pendingPromptsData.get(user.telegram_id);
      const firstPhotoId = this.pendingMergeFirstPhoto.get(user.telegram_id);
      if (promptData && promptData.prompt.startsWith('merge:') && firstPhotoId && firstPhotoId !== 'MERGE_MODE_WAITING') {
        // Это промпт для объединяющего заказа (старый режим merge)
        await this.processMergePrompt(ctx, user, text);
      } else {
        // Обычный промпт - очищаем застрявшее состояние merge если есть
        if (firstPhotoId || (promptData && promptData.prompt.startsWith('merge:'))) {
          console.log(`⚠️ Очищаю застрявшее состояние merge при обработке обычного промпта для пользователя ${user.telegram_id}`);
          this.pendingMergeFirstPhoto.delete(user.telegram_id);
          if (promptData && promptData.prompt.startsWith('merge:')) {
            this.pendingPromptsData.delete(user.telegram_id);
          }
        }
        // Обычный промпт
        await this.processPrompt(ctx, user, text);
      }
      
    } catch (error) {
      console.error('Error handling text:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке промпта. Попробуйте позже.');
    }
  }

  private async processMergePrompt(ctx: Context, user: any, promptText: string): Promise<void> {
    try {
      const promptData = this.pendingPromptsData.get(user.telegram_id);
      if (!promptData || !promptData.prompt.startsWith('merge:')) {
        await this.sendMessage(ctx, '❌ Фото для объединения не найдено. Начните заново!');
        return;
      }
      
      // Извлекаем fileId первого и второго фото
      const firstFileId = promptData.fileId;
      const secondFileId = promptData.prompt.replace('merge:', '');
      
      // Очищаем данные
      this.pendingPromptsData.delete(user.telegram_id);
      this.pendingPrompts.delete(user.telegram_id);
      
      // Загружаем оба фото в S3 (для fal.ai отправляем как есть, без обработки)
      const firstS3Url = await this.fileService.downloadTelegramFileToS3(firstFileId, true);
      const secondS3Url = await this.fileService.downloadTelegramFileToS3(secondFileId, true);
      
      // Обрабатываем промпт
      let processedPrompt = promptText.toLowerCase().trim();
      const originalPrompt = promptText;
      
      if (processedPrompt === 'пропустить' || processedPrompt === 'skip') {
        processedPrompt = 'animate transition between two images with smooth morphing and movement';
      } else {
        let translatedPrompt = this.translatePrompt(processedPrompt);
        translatedPrompt = translatedPrompt.replace(/^animate transition between two images with\s*/i, '');
        processedPrompt = `animate transition between two images with ${translatedPrompt}`;
      }
      
      // Проверяем баланс генераций
      const userGenerations = await this.userService.getUserGenerations(user.telegram_id);
      
      if (userGenerations >= 1) {
        // Создаем merge заказ
        const order = await this.orderService.createMergeOrder(user.id, firstS3Url, secondS3Url, processedPrompt);
        await this.orderService.updateOrderStatus(order.id, 'processing' as any);
        
        const displayPromptMerge = (originalPrompt === 'пропустить' || originalPrompt === 'skip') 
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания' 
          : originalPrompt;
        await this.sendMessage(ctx, `🎬 Отлично! Промпт: "${displayPromptMerge}"\n\n✅ Заказ на объединение создан\n🎬 Начинаю оживление видео...\n\n⏳ Это займет 2-5 минут.`);
        
        // Запускаем обработку заказа
        const { ProcessorService } = await import('./processor');
        const processorService = new ProcessorService();
        await processorService.processOrder(order.id);
      } else {
        // У пользователя нет генераций - предлагаем купить
        // Сохраняем данные для повторной обработки после покупки
        this.pendingPromptsData.set(user.telegram_id, {
          fileId: firstFileId,
          prompt: `merge:${secondFileId}:${originalPrompt || 'пропустить'}`
        });
        this.pendingPrompts.set(user.telegram_id, firstFileId);
        
        const displayPromptForMergeMessage = (originalPrompt === 'пропустить' || originalPrompt === 'skip' || !originalPrompt)
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания'
          : originalPrompt;
        const noGenerationsMessage = `💼 У вас нет оживлений фото для обработки

📸 Ваши фото сохранены и готовы к обработке
🎬 Промпт: "${displayPromptForMergeMessage}"

Выберите способ оплаты:`;
        
        // Пакеты генераций (финальные цены)
        const packages = [
          { count: 1, originalPrice: 169 },
          { count: 3, originalPrice: 507 },
          { count: 5, originalPrice: 845 },
          { count: 10, originalPrice: 1690 }
        ];
        
        // Коэффициент скидки: 89/169 ≈ 0.5266 (скидка ~47.34%)
        const discountCoefficient = 89 / 169;
        
        const keyboard = packages.map(pkg => {
          const discountedPrice = Math.round(pkg.originalPrice * discountCoefficient);
          const buttonText = `${discountedPrice}₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)}`;
          return [
            Markup.button.callback(
              buttonText,
              `buy_and_process_merge_${pkg.count}_${discountedPrice}`
            )
          ];
        });
        
        keyboard.push(this.getBackButton());
        
        await this.sendMessage(ctx, noGenerationsMessage, {
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      }
      
    } catch (error) {
      console.error('Error processing merge prompt:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке промпта для объединения. Попробуйте позже.');
    }
  }

  private translatePrompt(russianPrompt: string): string {
    // Simple Russian to English translation for common animation prompts
    const translations: { [key: string]: string } = {
      'машет рукой': 'waving hand',
      'улыбается': 'smiling',
      'моргает': 'blinking',
      'дышит': 'breathing',
      'кивает': 'nodding',
      'качает головой': 'shaking head',
      'подмигивает': 'winking',
      'смеется': 'laughing',
      'плачет': 'crying',
      'злится': 'angry expression',
      'удивляется': 'surprised expression',
      'грустный': 'sad expression',
      'счастливый': 'happy expression',
      'танцует': 'dancing',
      'бегает': 'running',
      'идет': 'walking',
      'прыгает': 'jumping',
      'сидит': 'sitting',
      'стоит': 'standing',
      'лежит': 'lying down',
      'говорит': 'speaking',
      'поет': 'singing',
      'читает': 'reading',
      'пишет': 'writing',
      'рисует': 'drawing',
      'играет': 'playing',
      'работает': 'working',
      'спит': 'sleeping',
      'ест': 'eating',
      'пьет': 'drinking'
    };
    
    // Try to find exact match first
    if (translations[russianPrompt]) {
      return translations[russianPrompt];
    }
    
    // Try to find partial matches
    for (const [russian, english] of Object.entries(translations)) {
      if (russianPrompt.includes(russian)) {
        return english;
      }
    }
    
    // If no translation found, return the original prompt
    // RunwayML should handle Russian text reasonably well
    return russianPrompt;
  }

  private translateAnimationPrompt(russianPrompt: string): string {
    // Переводим русские описания анимации на английский
    const translations: { [key: string]: string } = {
      'улыбаются': 'smiling',
      'обнимаются': 'hugging',
      'кивает': 'nodding',
      'моргает': 'blinking',
      'поворачивает голову': 'turning head',
      'идут навстречу': 'walking towards each other',
      'идут': 'walking',
      'танцует': 'dancing',
      'бегает': 'running',
      'говорит': 'speaking',
      'машет': 'waving',
      'дышит': 'breathing',
      'мужчина слева': 'man on the left',
      'женщина справа': 'woman on the right',
      'ребёнок в центре': 'child in the center',
      'люди на фото': 'people in the photo'
    };
    
    let translated = russianPrompt.toLowerCase();
    
    // Заменяем фразы
    for (const [russian, english] of Object.entries(translations)) {
      if (translated.includes(russian)) {
        translated = translated.replace(russian, english);
      }
    }
    
    // Добавляем базовую часть если нужно
    if (!translated.includes('animate')) {
      translated = `animate this image with ${translated}`;
    }
    
    return translated;
  }

  private async handleCallbackQuery(ctx: Context) {
    const callbackData = (ctx.callbackQuery as any)['data'];
    
    switch (callbackData) {
      case 'my_orders':
        await this.showUserOrders(ctx);
        break;
      case 'help':
        await this.handleHelp(ctx);
        break;
      case 'show_stats':
        await this.showAnalytics(ctx);
        break;
      case 'mock_payment':
        await this.handleMockPayment(ctx);
        break;
        case 'get_result':
          await this.handleGetResult(ctx);
          break;
        case 'pay_order':
          await this.handlePayOrder(ctx);
          break;
      case 'skip_prompt':
        const user = await this.userService.getOrCreateUser(ctx.from!);
        await this.processPrompt(ctx, user, 'пропустить');
        break;
      case 'skip_prompt_v2':
        const userV2 = await this.userService.getOrCreateUser(ctx.from!);
        const userId = ctx.from!.id;
        const animateV2State = this.animateV2State.get(userId);
        if (animateV2State && animateV2State.photoFileId) {
          await this.processAnimateV2Prompt(ctx, userV2, animateV2State.photoFileId, 'пропустить');
        }
        break;
      case 'skip_prompt_merge':
        const userMerge = await this.userService.getOrCreateUser(ctx.from!);
        await this.processMergePrompt(ctx, userMerge, 'пропустить');
        break;
      case 'back_to_menu':
        // Удаляем inline клавиатуру и показываем главное меню с reply клавиатурой
        try {
          await ctx.reply('◀️ Возвращаюсь в главное меню...', {
            reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
          });
        } catch (e: any) {
          // Игнорируем ошибки (бот может быть заблокирован)
          if (this.isBlockedError(e)) {
            console.log(`Bot is blocked by user ${ctx.from?.id}, skipping back to menu message`);
          }
        }
        await this.showMainMenu(ctx);
        break;
      case 'test_payment':
        await this.handleTestPayment(ctx);
        break;
      case 'settings':
        await this.handleSettings(ctx);
        break;
      case 'set_email':
        await this.handleSetEmail(ctx);
        break;
      case 'clear_email':
        await this.handleClearEmail(ctx);
        break;
      case 'cancel_email':
        this.waitingForEmail.delete(ctx.from!.id);
        await this.handleSettings(ctx);
        break;
      case 'buy_generations_stars':
        await ctx.answerCbQuery('Оплата звёздами пока не доступна');
        break;
      case 'back_to_stats':
        await ctx.answerCbQuery('◀️');
        await this.showAnalytics(ctx);
        break;
      default:
        if (callbackData.startsWith('buy_and_process_combine_')) {
          // Формат: buy_and_process_combine_{count}_{price}
          const parts = callbackData.replace('buy_and_process_combine_', '').split('_');
          if (parts.length === 2) {
            const count = parseInt(parts[0], 10);
            const price = parseInt(parts[1], 10);
            if (!isNaN(count) && !isNaN(price)) {
              // Сначала покупаем генерации, затем обрабатываем объединение и оживление
              await this.handlePurchaseGenerationsAndProcessCombine(ctx, count, price);
            } else {
              console.error(`Invalid buy_and_process_combine callback: ${callbackData}`);
              await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
            }
          } else {
            console.error(`Invalid buy_and_process_combine callback format: ${callbackData}`);
            await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
          }
        } else if (callbackData.startsWith('buy_and_process_')) {
          // Формат: buy_and_process_{count}_{price}
          const parts = callbackData.replace('buy_and_process_', '').split('_');
          if (parts.length === 2) {
            const count = parseInt(parts[0], 10);
            const price = parseInt(parts[1], 10);
            if (!isNaN(count) && !isNaN(price)) {
              // Сначала покупаем генерации, затем обрабатываем фото
              await this.handlePurchaseGenerationsAndProcess(ctx, count, price);
            } else {
              console.error(`Invalid buy_and_process callback: ${callbackData}`);
              await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
            }
          } else {
            console.error(`Invalid buy_and_process callback format: ${callbackData}`);
            await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
          }
        } else if (callbackData.startsWith('campaign_stats_')) {
          const campaignName = callbackData.replace('campaign_stats_', '');
          await this.showCampaignStats(ctx, campaignName);
        } else if (callbackData.startsWith('delete_campaign_')) {
          const campaignName = callbackData.replace('delete_campaign_', '');
          await this.handleDeleteCampaign(ctx, campaignName);
        } else if (callbackData.startsWith('restore_campaign_')) {
          const campaignName = callbackData.replace('restore_campaign_', '');
          await this.handleRestoreCampaign(ctx, campaignName);
        } else if (callbackData === 'show_deleted_campaigns') {
          await this.showDeletedCampaigns(ctx);
        } else if (callbackData.startsWith('pay_')) {
          const orderId = callbackData.replace('pay_', '');
          await this.handlePayOrder(ctx, orderId);
        } else if (callbackData.startsWith('buy_generations_stars_')) {
          await ctx.answerCbQuery('Оплата звёздами пока не доступна');
        } else if (callbackData.startsWith('buy_generations_')) {
          // Формат: buy_generations_{count}_{price}
          const parts = callbackData.replace('buy_generations_', '').split('_');
          if (parts.length === 2) {
            const count = parseInt(parts[0], 10);
            const price = parseInt(parts[1], 10);
            if (!isNaN(count) && !isNaN(price)) {
              await this.handlePurchaseGenerations(ctx, count, price);
            } else {
              console.error(`Invalid buy_generations callback: ${callbackData}`);
              await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
            }
          } else {
            console.error(`Invalid buy_generations callback format: ${callbackData}`);
            await ctx.answerCbQuery('❌ Ошибка: неверный формат данных');
          }
        }
        break;
    }
    
    await ctx.answerCbQuery();
  }

  private async sendPaymentRequest(ctx: Context, order: any, customPrompt?: string) {
    const paymentMessage = `
💳 Оплата заказа

📸 Фото: готово к обработке
🎬 Промпт: ${customPrompt ? `"${customPrompt}"` : 'оживите это изображение с помощью легких движений и эффекта дыхания'}

Для оплаты нажмите кнопку ниже:`;
    
    await this.sendMessage(ctx, paymentMessage, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('💳 Оплатить', `pay_${order.id}`)],
          [Markup.button.callback('❌ Отменить', 'cancel')],
          this.getBackButton()
        ]
      }
    });
  }

  private async showUserOrders(ctx: Context) {
    const user = await this.userService.getOrCreateUser(ctx.from!);
    const orders = await this.orderService.getUserOrders(user.id);
    
    if (orders.length === 0) {
      await this.sendMessage(ctx, '📋 У вас пока нет заказов. Отправьте фото для создания первого заказа!');
      return;
    }
    
    let message = '📋 Ваши заказы:\n\n';
    const completedOrders = orders.filter(order => order.status === 'completed');
    
    for (const order of orders) {
      const status = this.getOrderStatusText(order.status);
      message += `🆔 ${order.id.slice(0, 8)}...\n`;
      message += `📊 Статус: ${status}\n`;
      message += `📅 Дата: ${new Date(order.created_at).toLocaleDateString()}\n\n`;
    }
    
    // Add buttons for completed orders
    const keyboard = [];
    if (completedOrders.length > 0) {
      keyboard.push([Markup.button.callback('🎬 Получить последний результат', 'get_result')]);
    }
    keyboard.push(this.getBackButton());
    
    await this.sendMessage(ctx, message, {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
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

  private isAdmin(userId: number): boolean {
    const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
    return adminIds.includes(userId);
  }

  private async processAnimateV2Prompt(ctx: Context, user: any, fileId: string, promptText: string): Promise<void> {
    try {
      const userId = ctx.from!.id;
      
      // Загружаем фото в S3 без обработки (для fal.ai отправляем как есть)
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId, true);
      
      // Обрабатываем промпт
      let processedPrompt = promptText.toLowerCase().trim();
      const originalPrompt = promptText;
      
      if (processedPrompt === 'пропустить' || processedPrompt === 'skip') {
        processedPrompt = 'everyone in the photo is waving hand, subtle movements and breathing effect';
      } else {
        // Переводим промпт
        let translatedPrompt = this.translatePrompt(processedPrompt);
        translatedPrompt = translatedPrompt.replace(/^animate this image with\s*/i, '');
        processedPrompt = `animate this image with ${translatedPrompt}`;
      }
      
      // Создаем заказ для использования fal.ai
      const order = await this.orderService.createOrder(
        user.id, 
        s3Url, 
        processedPrompt
      );
      
      await this.orderService.updateOrderStatus(order.id, 'processing' as any);
      
      // Очищаем состояние
      this.animateV2State.delete(userId);
      
      // Отображаем промпт пользователю
      const displayPrompt = (originalPrompt === 'пропустить' || originalPrompt === 'skip') 
        ? 'оживите это изображение с помощью легких движений и эффекта дыхания' 
        : originalPrompt;
      await this.sendMessage(ctx, `🎬 Отлично! Промпт: "${displayPrompt}"\n\n✅ Заказ создан\n🎬 Начинаю оживление фото...\n\n⏳ Это займет 2-5 минут.`);
      
      // Запускаем обработку заказа
      const { ProcessorService } = await import('./processor');
      const processorService = new ProcessorService();
      await processorService.processOrder(order.id);
      
    } catch (error) {
      console.error('Error processing animate v2 prompt:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при создании заказа. Попробуйте позже.');
    }
  }

  private async createAnimateV2Order(ctx: Context, user: any, fileId: string): Promise<void> {
    try {
      // Загружаем фото в S3
      // Для fal.ai отправляем изображение как есть (без обработки)
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId, true);
      
      // Создаем обычный заказ (single) для fal.ai
      const order = await this.orderService.createOrder(
        user.id, 
        s3Url, 
        'everyone in the photo is waving hand, subtle movements and breathing effect'
      );
      console.log(`📝 Создан заказ для fal.ai: ${order.id}, order_type: ${order.order_type}`);
      
      await this.orderService.updateOrderStatus(order.id, 'processing' as any);
      
      // Очищаем состояние (используем ctx.from!.id, number)
      this.animateV2State.delete(ctx.from!.id);
      
      // Запускаем обработку заказа
      const { ProcessorService } = await import('./processor');
      const processorService = new ProcessorService();
      await processorService.processOrder(order.id);
      
    } catch (error) {
      console.error('Error creating animate v2 order:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при создании заказа. Попробуйте позже.');
    }
  }

  private async showCampaignStats(ctx: Context, campaignName: string) {
    if (!this.isAdmin(ctx.from!.id)) {
      await ctx.answerCbQuery('❌ У вас нет прав для просмотра статистики');
      return;
    }

    try {
      const analytics = await this.analyticsService.getCampaignAnalytics(campaignName);
      
      if (analytics.length === 0) {
        await ctx.answerCbQuery('❌ Статистика по кампании не найдена');
        return;
      }

      const stat = analytics[0];
      
      // Экранируем специальные символы Markdown в названии кампании
      const escapedCampaignName = stat.campaign_name
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`');

      // Форматируем сообщение для пересылки (без inline-кнопок или с минимальными)
      const message = `📊 *Статистика по кампании: ${escapedCampaignName}*\n\n` +
        `📅 Статистика на ${this.getCurrentDateTime()}:\n\n` +
        `👥 Пользователи: ${stat.total_users}\n` +
        `💰 Сумма оплат: ${stat.total_payments_rub.toFixed(2)} ₽\n` +
        `⭐ Сумма в stars: ${stat.total_payments_stars}\n` +
        `🎬 Успешных оживлений: ${stat.completed_orders}\n` +
        `📈 Конверсия: ${stat.conversion_rate}%`;

      await ctx.answerCbQuery('✅');
      
      await this.sendMessage(ctx, message, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('🗑️ Удалить кампанию', `delete_campaign_${stat.campaign_name}`)],
            [Markup.button.callback('◀️ Назад к общей статистике', 'back_to_stats')]
          ]
        }
      });
    } catch (error) {
      console.error('Error showing campaign stats:', error);
      await ctx.answerCbQuery('❌ Ошибка при получении статистики');
    }
  }

  private async handleDeleteCampaign(ctx: Context, campaignName: string) {
    if (!this.isAdmin(ctx.from!.id)) {
      await ctx.answerCbQuery('❌ У вас нет прав для удаления кампаний');
      return;
    }

    try {
      await this.analyticsService.deleteCampaign(campaignName);
      await ctx.answerCbQuery('✅ Кампания удалена');
      await this.sendMessage(ctx, `✅ Кампания "${campaignName}" удалена.\n\nОна больше не будет отображаться в статистике, но данные сохранятся в базе.`);
      // Обновляем список аналитики
      await this.showAnalytics(ctx);
    } catch (error) {
      console.error('Error deleting campaign:', error);
      await ctx.answerCbQuery('❌ Ошибка при удалении');
      await this.sendMessage(ctx, '❌ Ошибка при удалении кампании');
    }
  }

  private async showDeletedCampaigns(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await this.sendMessage(ctx, '❌ У вас нет прав для просмотра удаленных кампаний');
      return;
    }

    try {
      const deletedCampaigns = await this.analyticsService.getDeletedCampaigns();
      
      if (deletedCampaigns.length === 0) {
        await this.sendMessage(ctx, '🗑️ Удаленных кампаний нет');
        return;
      }

      let message = '🗑️ Удаленные кампании:\n\n';
      const inlineKeyboard: any[] = [];
      
      for (const campaign of deletedCampaigns) {
        message += `🏷️ ${campaign.name}\n`;
        if (campaign.description) {
          message += `   ${campaign.description}\n`;
        }
        message += `   📅 Создана: ${new Date(campaign.created_at).toLocaleDateString()}\n\n`;
        
        inlineKeyboard.push([
          Markup.button.callback(`↩️ Восстановить: ${campaign.name}`, `restore_campaign_${campaign.name}`)
        ]);
      }
      
      inlineKeyboard.push(this.getBackButton());
      
      await this.sendMessage(ctx, message, {
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      });
    } catch (error) {
      console.error('Error showing deleted campaigns:', error);
      await this.sendMessage(ctx, '❌ Ошибка при получении удаленных кампаний');
    }
  }

  private async handleRestoreCampaign(ctx: Context, campaignName: string) {
    if (!this.isAdmin(ctx.from!.id)) {
      await ctx.answerCbQuery('❌ У вас нет прав для восстановления кампаний');
      return;
    }

    try {
      await this.analyticsService.restoreCampaign(campaignName);
      await ctx.answerCbQuery('✅ Кампания восстановлена');
      await this.sendMessage(ctx, `✅ Кампания "${campaignName}" восстановлена.\n\nОна снова будет отображаться в статистике.`);
      // Обновляем список удаленных кампаний
      await this.showDeletedCampaigns(ctx);
    } catch (error) {
      console.error('Error restoring campaign:', error);
      await ctx.answerCbQuery('❌ Ошибка при восстановлении');
      await this.sendMessage(ctx, '❌ Ошибка при восстановлении кампании');
    }
  }

  private async showAnalytics(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await this.sendMessage(ctx, '❌ У вас нет прав для просмотра статистики');
      return;
    }

    try {
      const analytics = await this.analyticsService.getCampaignAnalytics();
      const todayStats = await this.analyticsService.getTodayStatsByCampaign();
      
      if (analytics.length === 0) {
        await this.sendMessage(ctx, '📊 Статистика пока пуста');
        return;
      }

      let message = `📊 Статистика по кампаниям\n\n📅 Статистика на ${this.getCurrentDateTime()}:\n\n`;
      const inlineKeyboard: any[] = [];
      
      for (const stat of analytics) {
        // Экранируем специальные символы Markdown в названии кампании
        const campaignName = stat.campaign_name
          .replace(/\*/g, '\\*')
          .replace(/_/g, '\\_')
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]')
          .replace(/\(/g, '\\(')
          .replace(/\)/g, '\\)')
          .replace(/~/g, '\\~')
          .replace(/`/g, '\\`');
        
        const today = todayStats.get(stat.campaign_name) || {
          users: 0,
          payments_rub: 0,
          payments_stars: 0,
          completed_orders: 0
        };
        
        // Форматируем изменения за сегодня
        const formatTodayChange = (todayValue: number, isDecimal: boolean = false): string => {
          if (todayValue === 0) return '';
          const displayValue = isDecimal ? Math.round(todayValue) : todayValue;
          return todayValue > 0 ? ` (+${displayValue})` : ` (${displayValue})`;
        };
        
        message += `🏷️ *${campaignName}*\n`;
        message += `👥 Пользователи: ${stat.total_users}${formatTodayChange(today.users)}\n`;
        message += `💰 Сумма оплат: ${stat.total_payments_rub} руб${formatTodayChange(today.payments_rub, true)}\n`;
        message += `⭐ Сумма в stars: ${stat.total_payments_stars}${formatTodayChange(today.payments_stars)}\n`;
        message += `🎬 Успешных оживлений: ${stat.completed_orders}${formatTodayChange(today.completed_orders)}\n`;
        message += `📈 Конверсия: ${stat.conversion_rate}%\n\n`;
        
        // Добавляем кнопки для детальной статистики и удаления
        inlineKeyboard.push([
          Markup.button.callback(`📊 Детали: ${stat.campaign_name}`, `campaign_stats_${stat.campaign_name}`),
          Markup.button.callback(`🗑️ Удалить`, `delete_campaign_${stat.campaign_name}`)
        ]);
      }
      
      // Добавляем кнопку для просмотра удаленных кампаний
      inlineKeyboard.push([
        Markup.button.callback('🗑️ Удаленные кампании', 'show_deleted_campaigns')
      ]);
      inlineKeyboard.push(this.getBackButton());

      await this.sendMessage(ctx, message, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      });
    } catch (error) {
      console.error('Error showing analytics:', error);
      await this.sendMessage(ctx, '❌ Ошибка при получении статистики');
    }
  }

  private async handlePayOrder(ctx: Context, orderId?: string) {
    if (!orderId) {
      await this.sendMessage(ctx, '❌ Ошибка: не указан ID заказа');
      return;
    }
    
    try {
      const order = await this.orderService.getOrder(orderId);
      if (!order) {
        await this.sendMessage(ctx, '❌ Заказ не найден');
        return;
      }
      
      // Create payment (цена 1 рубль для денежной оплаты)
      const paymentAmount = 1;
      const payment = await this.paymentService.createPayment(order.id, paymentAmount);
      
      // Generate YooMoney payment URL
      const paymentUrl = await this.paymentService.generatePaymentUrl(payment.id, paymentAmount);
      
      const paymentMessage = `
💳 Оплата заказа

🆔 Заказ: ${order.id.slice(0, 8)}...

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}

После оплаты бот автоматически получит уведомление и начнет обработку.`;
      
      await this.sendMessage(ctx, paymentMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            this.getBackButton()
          ]
        }
      });
      
    } catch (error) {
      console.error('Error creating payment:', error);
      await this.sendMessage(ctx, '❌ Ошибка при создании платежа. Попробуйте позже.');
    }
  }

  private async handleTestPayment(ctx: Context) {
    try {
      // Создаем тестовый платеж с telegram_id пользователя
      const testAmount = 1;
      const telegramId = ctx.from!.id;
      const payment = await this.paymentService.createTestPayment(testAmount, telegramId);
      
      // Генерируем ссылку на оплату с telegram_id
      const paymentUrl = await this.paymentService.generatePaymentUrl(payment.id, testAmount, telegramId);
      
      const testMessage = `
🧪 Тестовая ссылка на оплату

💰 Сумма: ${testAmount} рублей
🆔 ID платежа: ${payment.id.slice(0, 8)}...

Для оплаты перейдите по ${this.formatLink(paymentUrl, 'ссылке')}

⚠️ Внимание: Это тестовый платеж для проверки интеграции с ЮKassa.
Используйте тестовую карту для оплаты.`;

      await this.sendMessage(ctx, testMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [this.getBackButton()]
        }
      });
      
    } catch (error) {
      console.error('Error creating test payment:', error);
      await this.sendMessage(ctx, '❌ Ошибка при создании тестового платежа. Попробуйте позже.');
    }
  }

  private async handleMockPayment(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Получаем последний заказ пользователя
      const orders = await this.orderService.getUserOrders(user.id);
      if (orders.length === 0) {
        await this.sendMessage(ctx, 'У вас нет заказов для тестирования. Сначала отправьте фото!');
        return;
      }
      
      const lastOrder = orders[0];
      
      if (lastOrder.status !== 'payment_required') {
        await this.sendMessage(ctx, `Заказ уже в статусе: ${this.getOrderStatusText(lastOrder.status)}`);
        return;
      }
      
      // Мокаем успешную оплату
      await this.mockService.mockSuccessfulPayment(lastOrder.id);
      
      await this.sendMessage(ctx, '🎭 Мок-платеж успешен! Заказ переведен в обработку.');
      
    } catch (error) {
      console.error('Error in mock payment:', error);
      await this.sendMessage(ctx, 'Ошибка при мок-платеже. Попробуйте позже.');
    }
  }

  private async handleGetResult(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Get user's completed orders
      const orders = await this.orderService.getUserOrders(user.id);
      const completedOrders = orders.filter(order => order.status === 'completed');
      
      if (completedOrders.length === 0) {
        await this.sendMessage(ctx, '❌ У вас пока нет готовых видео. Сначала отправьте фото для обработки!');
        return;
      }
      
      // Get the most recent completed order
      const latestOrder = completedOrders[0];
      
      if (!latestOrder.did_job_id) {
        await this.sendMessage(ctx, '❌ Информация о видео не найдена. Попробуйте позже.');
        return;
      }
      
      // Check status via fal.ai API
      const { FalService } = await import('./fal');
      const falService = new FalService();
      const status = await falService.checkJobStatus(latestOrder.did_job_id);
      
      if (status.status === 'SUCCEEDED' && status.output && status.output.length > 0) {
        const videoUrl = status.output[0];
        
        await this.sendMessage(ctx, `🎬 Ваше последнее видео готово!\n\n📹 Результат: ${this.formatLink(videoUrl, 'Ссылка')}\n\nСпасибо за использование Vividus Bot!`, {
          parse_mode: 'HTML'
        });
        
        // Сообщение о возможности отправить следующее фото (отправляем новое сообщение, не редактируем)
        setTimeout(async () => {
          try {
            await ctx.reply('📸 Вы можете сразу отправить следующее фото для создания нового видео!', {
              reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
            });
          } catch (e: any) {
            if (this.isBlockedError(e)) {
              console.log(`Bot is blocked by user ${ctx.from?.id}, skipping next photo message`);
            }
          }
        }, 2000);
      } else {
        await this.sendMessage(ctx, `⏳ Статус обработки: ${status.status}\n\nПопробуйте позже.`);
      }
      
    } catch (error) {
      console.error('Error getting result:', error);
      await this.sendMessage(ctx, '❌ Ошибка при получении результата');
    }
  }

  private async handleSettings(ctx: Context) {
    try {
      const user = await this.userService.getUserByTelegramId(ctx.from!.id);
      const currentEmail = user?.email || 'не указан';
      
      const settingsMessage = `
⚙️ <b>Настройки</b>

📧 <b>Email для получения чека:</b> ${currentEmail}

Вы можете указать ваш email, чтобы получать кассовые чеки на почту при оплате.
Если email не указан, чек будет формироваться автоматически, но отправка на email не произойдет.`;

      const keyboard = [];
      
      if (currentEmail === 'не указан') {
        keyboard.push([Markup.button.callback('✏️ Указать email', 'set_email')]);
      } else {
        keyboard.push(
          [Markup.button.callback('✏️ Изменить email', 'set_email')],
          [Markup.button.callback('🗑 Удалить email', 'clear_email')]
        );
      }
      
      keyboard.push(this.getBackButton());

      await this.sendMessage(ctx, settingsMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
    } catch (error) {
      console.error('Error showing settings:', error);
      await this.sendMessage(ctx, '❌ Ошибка при открытии настроек');
    }
  }

  private async handleSetEmail(ctx: Context) {
    this.waitingForEmail.add(ctx.from!.id);
    await this.sendMessage(ctx, '📧 Пожалуйста, отправьте ваш email адрес:\n\nПример: example@mail.ru', {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('❌ Отменить', 'cancel_email')]
        ]
      }
    });
    await ctx.answerCbQuery();
  }

  private async handleClearEmail(ctx: Context) {
    try {
      await this.userService.updateUserEmail(ctx.from!.id, null);
      await this.sendMessage(ctx, '✅ Email удален из настроек');
      await ctx.answerCbQuery();
      // Обновляем меню настроек
      setTimeout(() => this.handleSettings(ctx), 500);
    } catch (error) {
      console.error('Error clearing email:', error);
      await this.sendMessage(ctx, '❌ Ошибка при удалении email');
    }
  }

  private async processEmailInput(ctx: Context, emailText: string) {
    try {
      // Простая валидация email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      if (!emailRegex.test(emailText.trim())) {
        await this.sendMessage(ctx, '❌ Некорректный формат email. Попробуйте еще раз:\n\nПример: example@mail.ru', {
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('❌ Отменить', 'cancel_email')]
            ]
          }
        });
        return;
      }

      const email = emailText.trim().toLowerCase();
      await this.userService.updateUserEmail(ctx.from!.id, email);
      this.waitingForEmail.delete(ctx.from!.id);
      
      await this.sendMessage(ctx, `✅ Email успешно сохранен: ${email}\n\nТеперь кассовые чеки будут приходить на этот адрес.`);
      
      // Возвращаемся в меню настроек через 2 секунды
      setTimeout(() => this.handleSettings(ctx), 2000);
      
    } catch (error) {
      console.error('Error processing email:', error);
      this.waitingForEmail.delete(ctx.from!.id);
      await this.sendMessage(ctx, '❌ Ошибка при сохранении email. Попробуйте позже.');
    }
  }

  private async handleBuyGenerations(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const currentGenerations = await this.userService.getUserGenerations(ctx.from!.id);
      
      // Пакеты генераций со скидкой ~47.34% (финальная цена за 1 генерацию: 89 руб)
      // Текущие цены - это оригинальные, вычисляем цены со скидкой
      const packages = [
        { count: 1, originalPrice: 169 },
        { count: 3, originalPrice: 507 },
        { count: 5, originalPrice: 845 },
        { count: 10, originalPrice: 1690 }
      ];
      
      // Коэффициент скидки: 89/169 ≈ 0.5266 (скидка ~47.34%)
      const discountCoefficient = 89 / 169;
      
      // Формируем список пакетов с зачеркиванием и скидкой в тексте сообщения
      let packageListText = '';
      packages.forEach(pkg => {
        const originalPrice = pkg.originalPrice as number;
        const discountedPrice = Math.round(originalPrice * discountCoefficient);
        const discountPercent = Math.round((1 - discountedPrice / originalPrice) * 100);
        // Используем combining strikethrough для зачеркивания в тексте сообщения
        // Финальная цена только в кнопках, в тексте только зачеркнутая оригинальная
        // Делаем процент скидки и зачеркнутую цену жирными
        const originalPriceStr = `${originalPrice}₽`;
        const strikethroughPrice = Array.from(originalPriceStr).map(char => char + '\u0336').join('');
        packageListText += `${pkg.count} ${this.getGenerationWord(pkg.count)}: <b>-${discountPercent}%</b> ${strikethroughPrice}\n`;
      });
      
      const message = `💼 У вас осталось оживлений фото: ${currentGenerations}

${packageListText}
Выберите пакет 👇`;
      
      const keyboard = packages.map(pkg => {
        // Используем цену со скидкой как финальную цену (оригинальная * 69/129)
        // В кнопках форматирование недоступно, но можно визуально выделить цену
        const actualPrice = Math.round((pkg.originalPrice as number) * discountCoefficient);
        // Используем эмодзи или символы для визуального выделения цены
        const buttonText = `${pkg.count} ${this.getGenerationWord(pkg.count)} → 💰 ${actualPrice}₽`;
        return [
          Markup.button.callback(
            buttonText,
            `buy_generations_${pkg.count}_${actualPrice}`
          )
        ];
      });
      
      // Добавляем кнопку оплаты звёздами (скрыто)
      // keyboard.push([Markup.button.callback('⭐ Оплатить звёздами', 'buy_generations_stars')]);
      keyboard.push(this.getBackButton());
      
      // Отправляем новое сообщение вместо редактирования
      try {
        await ctx.reply(message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      } catch (error: any) {
        if (this.isBlockedError(error)) {
          console.log(`Bot is blocked by user ${ctx.from?.id}, skipping buy generations menu`);
          return;
        }
        throw error;
      }
      
      // Отправляем невидимое сообщение с reply-клавиатурой, чтобы она всегда была видна
      // (после inline-сообщений reply-клавиатура может пропасть)
      setTimeout(async () => {
        try {
          await ctx.reply('\u200B', {
            reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
          });
        } catch (e: any) {
          // Игнорируем ошибки (клавиатура уже может быть видна или бот заблокирован)
          if (this.isBlockedError(e)) {
            console.log(`Bot is blocked by user ${ctx.from?.id}, skipping keyboard message`);
          }
        }
      }, 500);
    } catch (error) {
      console.error('Error showing buy generations menu:', error);
      await this.sendMessage(ctx, '❌ Ошибка при загрузке меню покупки оживлений');
    }
  }

  private async handleBuyAndProcess(ctx: Context, generationsCount: number, price: number) {
    try {
      await ctx.answerCbQuery();
      
      // Сначала создаем покупку генераций
      console.log(`📦 Creating generation purchase with auto-process: ${generationsCount} generations for ${price} RUB, user: ${ctx.from!.id}`);
      
      const payment = await this.paymentService.createGenerationPurchase(ctx.from!.id, generationsCount, price);
      console.log(`✅ Payment created: ${payment.id}`);
      
      const paymentUrl = await this.paymentService.generateGenerationPurchaseUrl(
        payment.id,
        price,
        generationsCount,
        ctx.from!.id
      );
      console.log(`✅ Payment URL generated: ${paymentUrl}`);
      
      const message = `💳 Покупка оживлений фото и обработка

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽
🆔 ID платежа: ${payment.id.slice(0, 8)}...

После оплаты:
✅ Оживления будут добавлены на ваш баланс
✅ Ваше фото будет автоматически обработано

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}`;
      
      // Сохраняем информацию о том, что после оплаты нужно обработать фото
      // Используем metadata в платеже или создаем специальный флаг
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const fileId = this.pendingPrompts.get(user.telegram_id);
      
      if (fileId) {
        // Сохраняем информацию о необходимости обработки после покупки
        // Можно использовать временное хранилище или добавить в metadata платежа
        // Для простоты используем pendingPrompts с модификатором
        this.pendingPrompts.set(user.telegram_id, `process_after_payment_${payment.id}_${fileId}`);
      }
      
      await this.sendMessage(ctx, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            this.getBackButton()
          ]
        }
      });
    } catch (error) {
      console.error('Error creating buy and process purchase:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.sendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handleSingleOrderPayment(ctx: Context) {
    try {
      await ctx.answerCbQuery();
      
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const fileId = this.pendingPrompts.get(user.telegram_id);
      
      if (!fileId) {
        await this.sendMessage(ctx, '❌ Фото не найдено. Отправьте фото заново!');
        return;
      }
      
      // Получаем промпт (если был сохранен)
      const promptText = 'everyone in the photo is waving hand, subtle movements and breathing effect'; // Можно сохранять промпт отдельно
      
      // Для fal.ai отправляем изображение как есть (без обработки)
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId, true);
      
      // Создаем заказ с оплатой
      const order = await this.orderService.createOrder(user.id, s3Url, promptText);
      
      // Создаем платеж (цена 1 рубль для денежной оплаты)
      const paymentAmount = 1;
      const payment = await this.paymentService.createPayment(order.id, paymentAmount);
      const paymentUrl = await this.paymentService.generatePaymentUrl(payment.id, paymentAmount);
      
      // Удаляем из pending
      this.pendingPrompts.delete(user.telegram_id);
      
      const paymentMessage = `
💳 Оплата заказа

📸 Фото: готово к обработке
🎬 Промпт: оживите это изображение с помощью легких движений и эффекта дыхания
Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}`;
      
      await this.sendMessage(ctx, paymentMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            [Markup.button.callback('❌ Отменить', 'cancel')],
            this.getBackButton()
          ]
        }
      });
    } catch (error) {
      console.error('Error creating single order payment:', error);
      await this.sendMessage(ctx, '❌ Ошибка при создании платежа. Попробуйте позже.');
    }
  }

  private async handlePurchaseGenerationsAndProcess(ctx: Context, generationsCount: number, price: number) {
    try {
      await ctx.answerCbQuery();
      
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Получаем сохраненное фото и промпт
      const promptData = this.pendingPromptsData.get(user.telegram_id);
      const fileId = this.pendingPrompts.get(user.telegram_id);
      
      if (!fileId || !promptData) {
        await this.sendMessage(ctx, '❌ Фото не найдено. Отправьте фото заново!');
        return;
      }
      
      const originalPrompt = promptData.prompt || 'пропустить';
      
      console.log(`📦 Creating generation purchase with auto-process: ${generationsCount} generations for ${price} RUB, user: ${ctx.from!.id}`);
      
      // Создаем покупку генераций (передаем fileId и prompt для сохранения в хранилище)
      const payment = await this.paymentService.createGenerationPurchase(
        ctx.from!.id, 
        generationsCount, 
        price,
        fileId,
        originalPrompt
      );
      
      // Генерируем URL с metadata, включая fileId и prompt для автоматической обработки
      const paymentUrl = await this.paymentService.generateGenerationPurchaseUrl(
        payment.id,
        price,
        generationsCount,
        ctx.from!.id,
        fileId,
        originalPrompt
      );
      
      // НЕ удаляем сохраненные данные - они нужны для автоматической обработки после оплаты
      // Данные будут удалены после успешной обработки фото через webhook
      
      const message = `💳 Покупка оживлений фото и обработка

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽

После оплаты оживления будут добавлены на баланс, и фото будет обработано автоматически.`;
      
      await this.sendMessage(ctx, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            this.getBackButton()
          ]
        }
      });
    } catch (error) {
      console.error('Error creating generation purchase with processing:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.sendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handlePurchaseGenerationsAndProcessCombine(ctx: Context, generationsCount: number, price: number) {
    try {
      await ctx.answerCbQuery();
      
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Получаем сохраненные фото и состояние для объединения и оживления
      const combinePhotos = this.combineAndAnimatePhotos.get(user.telegram_id);
      const combineState = this.combineAndAnimateState.get(user.telegram_id);
      
      if (!combinePhotos || combinePhotos.length < 2 || !combineState) {
        await this.sendMessage(ctx, '❌ Фото не найдены. Отправьте фото заново!');
        return;
      }
      
      const animationPrompt = combineState.animationPrompt || 'пропустить';
      
      console.log(`📦 Creating generation purchase with auto-process combine: ${generationsCount} generations for ${price} RUB, user: ${ctx.from!.id}`);
      
      // Создаем покупку генераций
      // После успешной оплаты в webhook нужно будет проверить наличие combineAndAnimatePhotos
      // и автоматически создать заказ
      const payment = await this.paymentService.createGenerationPurchase(
        ctx.from!.id, 
        generationsCount, 
        price
      );
      
      // Сохраняем данные для автоматической обработки после оплаты
      // Используем глобальное хранилище для передачи данных в webhook
      if (typeof (global as any).pendingCombineAndAnimatePurchases === 'undefined') {
        (global as any).pendingCombineAndAnimatePurchases = new Map();
      }
      (global as any).pendingCombineAndAnimatePurchases.set(payment.id, {
        telegramId: ctx.from!.id,
        photos: combinePhotos,
        state: combineState
      });
      
      // Генерируем URL для оплаты
      const paymentUrl = await this.paymentService.generateGenerationPurchaseUrl(
        payment.id,
        price,
        generationsCount,
        ctx.from!.id
      );
      
      const message = `💳 Покупка оживлений фото и обработка

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽

После оплаты оживления будут добавлены на баланс, и фото будут обработаны автоматически.`;
      
      await this.sendMessage(ctx, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            this.getBackButton()
          ]
        }
      });
    } catch (error) {
      console.error('Error creating generation purchase with combine processing:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.sendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handlePurchaseGenerations(ctx: Context, generationsCount: number, price: number) {
    try {
      await ctx.answerCbQuery();
      
      console.log(`📦 Creating generation purchase: ${generationsCount} generations for ${price} RUB, user: ${ctx.from!.id}`);
      
      const payment = await this.paymentService.createGenerationPurchase(ctx.from!.id, generationsCount, price);
      console.log(`✅ Payment created: ${payment.id}`);
      
      const paymentUrl = await this.paymentService.generateGenerationPurchaseUrl(
        payment.id,
        price,
        generationsCount,
        ctx.from!.id
      );
      console.log(`✅ Payment URL generated: ${paymentUrl}`);
      
      const message = `💳 Покупка оживлений фото

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽
🆔 ID платежа: ${payment.id.slice(0, 8)}...

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}

После оплаты оживления будут автоматически добавлены на ваш баланс.`;
      
      await this.sendMessage(ctx, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.url('💳 Оплатить', paymentUrl)],
            this.getBackButton()
          ]
        }
      });
    } catch (error) {
      console.error('Error creating generation purchase:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.sendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handleBuyGenerationsStars(ctx: Context) {
    try {
      await ctx.answerCbQuery();
      
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const currentGenerations = await this.userService.getUserGenerations(ctx.from!.id);
      
      // Пакеты генераций (те же цены, но в звездах)
      // Конвертация: 1 рубль ≈ 1 звезда
      const packages = [
        { count: 1, price: 89 },
        { count: 3, price: 267 },
        { count: 5, price: 445 },
        { count: 10, price: 890 }
      ];
      
      const message = `⭐ Оплата звёздами Telegram

💼 У вас осталось оживлений фото: ${currentGenerations}

Выберите пакет:`;
      
      const keyboard = packages.map(pkg => {
        const buttonText = `${pkg.count} ${this.getGenerationWord(pkg.count)} → ⭐ ${pkg.price} звёзд`;
        return [
          Markup.button.callback(
            buttonText,
            `buy_generations_stars_${pkg.count}_${pkg.price}`
          )
        ];
      });
      
      keyboard.push(this.getBackButton());
      
      await this.sendMessage(ctx, message, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
    } catch (error) {
      console.error('Error showing buy generations stars menu:', error);
      await this.sendMessage(ctx, '❌ Ошибка при загрузке меню оплаты звёздами');
    }
  }

  private async handlePurchaseGenerationsStars(ctx: Context, generationsCount: number, stars: number) {
    try {
      await ctx.answerCbQuery();
      
      console.log(`⭐ Creating stars payment: ${generationsCount} generations for ${stars} stars, user: ${ctx.from!.id}`);
      
      // Создаем платеж в БД (сохраняем сумму в рублях для совместимости, но помечаем как оплату звездами)
      const payment = await this.paymentService.createGenerationPurchase(ctx.from!.id, generationsCount, stars);
      console.log(`✅ Payment created: ${payment.id}`);
      
      // Создаем инвойс со звездами
      const invoicePayload = `stars_${payment.id}_${generationsCount}`;
      
      try {
        await ctx.replyWithInvoice({
          title: `Покупка ${generationsCount} ${this.getGenerationWord(generationsCount)}`,
          description: `Пополнение баланса оживлений фото для обработки фотографий`,
          payload: invoicePayload,
          provider_token: '', // Не требуется для звезд
          currency: 'XTR', // Код валюты для звезд Telegram
          prices: [
            {
              label: `${generationsCount} ${this.getGenerationWord(generationsCount)}`,
              amount: stars * 100 // Telegram требует сумму в минимальных единицах (для звезд это сотые)
            }
          ],
          start_parameter: invoicePayload,
          need_name: false,
          need_phone_number: false,
          need_email: false,
          need_shipping_address: false,
          send_phone_number_to_provider: false,
          send_email_to_provider: false,
          is_flexible: false
        });
      } catch (error: any) {
        console.error('Error sending invoice:', error);
        if (this.isBlockedError(error)) {
          console.log(`Bot is blocked by user ${ctx.from?.id}, skipping invoice`);
          return;
        }
        throw error;
      }
    } catch (error) {
      console.error('Error creating stars payment:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.sendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handlePreCheckoutQuery(ctx: any) {
    try {
      const query = ctx.preCheckoutQuery || ctx.update?.pre_checkout_query;
      if (!query) {
        console.error('Pre-checkout query not found in context');
        return;
      }
      const payload = query.invoice_payload;
      
      console.log(`🔍 Pre-checkout query received: ${payload}`);
      
      // Проверяем формат payload: stars_{paymentId}_{generationsCount}
      if (!payload.startsWith('stars_')) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Неверный формат платежа'
        });
        return;
      }
      
      const parts = payload.replace('stars_', '').split('_');
      if (parts.length !== 2) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Неверный формат данных платежа'
        });
        return;
      }
      
      const paymentId = parts[0];
      const generationsCount = parseInt(parts[1], 10);
      
      // Проверяем, что платеж существует
      const client = await pool.connect();
      try {
        const paymentResult = await client.query(
          'SELECT * FROM payments WHERE id = $1',
          [paymentId]
        );
        
        if (!paymentResult.rows[0]) {
          await ctx.answerPreCheckoutQuery(false, {
            error_message: 'Платеж не найден'
          });
          return;
        }
        
        // Подтверждаем оплату
        await ctx.answerPreCheckoutQuery(true);
        console.log(`✅ Pre-checkout query approved for payment ${paymentId}`);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Error handling pre-checkout query:', error);
      try {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Ошибка при обработке запроса'
        });
      } catch (e) {
        console.error('Error answering pre-checkout query:', e);
      }
    }
  }

  private async handleSuccessfulPayment(ctx: any) {
    try {
      const payment = ctx.message?.successful_payment || ctx.update?.message?.successful_payment;
      if (!payment) {
        console.error('Successful payment not found in context');
        return;
      }
      const payload = payment.invoice_payload;
      
      console.log(`✅ Successful payment received: ${payload}, amount: ${payment.total_amount} ${payment.currency}`);
      
      // Проверяем формат payload: stars_{paymentId}_{generationsCount}
      if (!payload.startsWith('stars_')) {
        console.error(`Invalid payload format: ${payload}`);
        return;
      }
      
      const parts = payload.replace('stars_', '').split('_');
      if (parts.length !== 2) {
        console.error(`Invalid payload parts: ${payload}`);
        return;
      }
      
      const paymentId = parts[0];
      const generationsCount = parseInt(parts[1], 10);
      const starsAmount = payment.total_amount / 100; // Конвертируем из минимальных единиц
      
      console.log(`📦 Processing stars payment: paymentId=${paymentId}, generations=${generationsCount}, stars=${starsAmount}`);
      
      // Обновляем статус платежа
      await this.paymentService.updatePaymentStatus(paymentId, 'success' as any);
      
      // Получаем информацию о платеже
      const client = await pool.connect();
      try {
        const paymentResult = await client.query(
          'SELECT user_id FROM payments WHERE id = $1',
          [paymentId]
        );
        
        if (!paymentResult.rows[0]) {
          console.error(`Payment ${paymentId} not found`);
          return;
        }
        
        const userId = paymentResult.rows[0].user_id;
        
        // Получаем telegram_id пользователя
        const userResult = await client.query(
          'SELECT telegram_id, start_param FROM users WHERE id = $1',
          [userId]
        );
        
        if (!userResult.rows[0]) {
          console.error(`User not found for payment ${paymentId}`);
          return;
        }
        
        const telegramId = userResult.rows[0].telegram_id;
        const startParam = userResult.rows[0].start_param;
        
        // Добавляем генерации пользователю
        const { UserService } = await import('./user');
        const userService = new UserService();
        
        console.log(`➕ Adding ${generationsCount} generations to user ${telegramId}`);
        await userService.addGenerations(telegramId, generationsCount);
        
        const newBalance = await userService.getUserGenerations(telegramId);
        console.log(`✅ New balance: ${newBalance} generations`);
        
        // Отправляем уведомление пользователю
        try {
          await this.bot.telegram.sendMessage(
            telegramId,
            `✅ Оживления успешно пополнены!\n\n➕ Начислено: ${generationsCount} ${this.getGenerationWord(generationsCount)}\n💼 Ваш баланс: ${newBalance} оживлений фото\n⭐ Оплачено: ${starsAmount} звёзд`
          );
        } catch (error: any) {
          if (this.isBlockedError(error)) {
            console.log(`Bot is blocked by user ${telegramId}, skipping notification`);
          } else {
            throw error;
          }
        }
        
        // Обновляем статистику кампании
        if (startParam) {
          try {
            const { AnalyticsService } = await import('./analytics');
            const analyticsService = new AnalyticsService();
            await analyticsService.updateCampaignStats(startParam);
          } catch (error) {
            console.error('Error updating campaign stats after stars payment:', error);
          }
        }
        
        // Сохраняем информацию о методе оплаты (можно добавить отдельное поле в будущем)
        // Пока просто логируем
        console.log(`💾 Stars payment saved: paymentId=${paymentId}, stars=${starsAmount}`);
        
      } finally {
        client.release();
      }
      
    } catch (error) {
      console.error('Error handling successful payment:', error);
    }
  }

  private async requestAnimationPrompt(ctx: Context): Promise<void> {
    const message = `Теперь напишите, как оживить фото:

Примеры:
• "Люди на фото улыбаются и обнимаются 🤗"
• "Мужчина слегка кивает и улыбается 😊"
• "Девушка моргает и слегка поворачивает голову 💫"

📌 Важно:
• Используйте описания «мужчина слева», «женщина справа», «ребёнок в центре».
• Не пишите «я», «мы», «сестра» и т.п.
• Если на фото нет человека — не указывайте его.

📏 Требования к фото:
• Минимальный размер: 300x300 пикселей
• Формат: JPG или PNG`;

    await this.sendMessage(ctx, message);
    
    // Устанавливаем флаг ожидания промпта
    const user = await this.userService.getOrCreateUser(ctx.from!);
    const state = this.combineAndAnimateState.get(user.telegram_id) || {};
    state.waitingForAnimationPrompt = true;
    this.combineAndAnimateState.set(user.telegram_id, state);
  }


  private async createCombineAndAnimateOrder(
    ctx: Context, 
    user: any, 
    photos: string[], 
    state: { combineType?: string; animationType?: string; combinePrompt?: string; animationPrompt?: string }
  ): Promise<void> {
    try {
      // Загружаем все фото в S3
      const photoUrls: string[] = [];
      for (const fileId of photos) {
        // Для fal.ai отправляем изображение как есть (без обработки)
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId, true);
        photoUrls.push(s3Url);
      }
      
      // Формируем промпты
      // Промпт для объединения - всегда стандартный (совмещает 2 фото и рисует сцену с нуля)
      const combinePrompt = 'combine two reference images into one modern scene, drawing a new scene from scratch to create a cohesive common frame, merge the people from both images naturally into one composition';
      
      // Промпт для анимации - берем из пользовательского ввода
      // Используем тот же базовый промпт, что и в обычном оживлении
      let animationPrompt = state.animationPrompt || 'everyone in the photo is waving hand, subtle movements and breathing effect';
      const originalAnimationPrompt = animationPrompt;
      
      // Переводим русский промпт на английский для лучшего понимания AI
      animationPrompt = this.translateAnimationPrompt(animationPrompt);
      
      // Проверяем баланс генераций пользователя
      const userGenerations = await this.userService.getUserGenerations(user.telegram_id);
      
      if (userGenerations >= 1) {
        // Создаем заказ со статусом processing (без оплаты)
        // Финальная проверка баланса будет выполнена в processOrder перед началом обработки
        const { OrderStatus } = await import('../types');
        const order = await this.orderService.createCombineAndAnimateOrder(
          user.id,
          photoUrls,
          combinePrompt,
          animationPrompt,
          OrderStatus.PROCESSING, // Статус processing вместо payment_required
          originalAnimationPrompt // Передаем оригинальный промпт для сохранения в custom_prompt
        );
        
        // Очищаем состояние
        this.combineAndAnimatePhotos.delete(user.telegram_id);
        this.combineAndAnimateState.delete(user.telegram_id);
        
        // Объединенное сообщение о промпте, создании заказа и начале генерации
        const displayPrompt = (originalAnimationPrompt === 'пропустить' || originalAnimationPrompt === 'skip') 
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания' 
          : originalAnimationPrompt;
        await this.sendMessage(ctx, `🔀 Объединяю фото и готовлю видео...\n\n🎬 Промпт: "${displayPrompt}"\n\n✅ Заказ создан\n🎬 Начинаю оживление видео...\n\n⏳ Это займет до 5 минут.`);
      
        // Запускаем обработку заказа (списание оживлений произойдет при успешном оживлении)
        const { ProcessorService } = await import('./processor');
        const processorService = new ProcessorService();
        await processorService.processOrder(order.id);
      } else {
        // У пользователя нет генераций - предлагаем купить генерации
        
        // Сохраняем фото и промпт для повторной обработки после покупки генераций
        this.combineAndAnimatePhotos.set(user.telegram_id, photos);
        this.combineAndAnimateState.set(user.telegram_id, state);
        
        const displayPromptForMessage = (originalAnimationPrompt === 'пропустить' || originalAnimationPrompt === 'skip' || !originalAnimationPrompt)
          ? 'оживите это изображение с помощью легких движений и эффекта дыхания'
          : originalAnimationPrompt;
        const noGenerationsMessage = `💼 У вас нет оживлений фото для обработки

📸 Ваши фото сохранены и готовы к обработке
🎬 Промпт: "${displayPromptForMessage}"

Выберите способ оплаты:`;
        
        // Пакеты генераций (оригинальные цены)
        const packages = [
          { count: 1, originalPrice: 169 },
          { count: 3, originalPrice: 507 },
          { count: 5, originalPrice: 845 },
          { count: 10, originalPrice: 1690 }
        ];
        
        // Коэффициент скидки: 89/169 ≈ 0.5266 (скидка ~47.34%)
        const discountCoefficient = 89 / 169;
        
        const keyboard = packages.map(pkg => {
          // Используем цену со скидкой как финальную цену (оригинальная * 89/169)
          const discountedPrice = Math.round(pkg.originalPrice * discountCoefficient);
          const buttonText = `${discountedPrice}₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)}`;
          return [
            Markup.button.callback(
              buttonText,
              `buy_and_process_combine_${pkg.count}_${discountedPrice}`
            )
          ];
        });
        
        keyboard.push(this.getBackButton());
        
        await this.sendMessage(ctx, noGenerationsMessage, {
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      }
      
    } catch (error) {
      console.error('Error creating combine and animate order:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при создании заказа. Попробуйте позже.');
    }
  }

  private getGenerationWord(count: number): string {
    if (count % 10 === 1 && count % 100 !== 11) {
      return 'оживление фото';
    } else if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
      return 'оживления фото';
    } else {
      return 'оживлений фото';
    }
  }

  private getOrderStatusText(status: string): string {
    const statusMap: { [key: string]: string } = {
      'pending': '⏳ Ожидает',
      'payment_required': '💳 Требуется оплата',
      'processing': '🔄 Обрабатывается',
      'throttled': '⏸ В очереди',
      'completed': '✅ Готово',
      'failed': '❌ Ошибка',
      'cancelled': '❌ Отменено'
    };
    
    return statusMap[status] || status;
  }

  public async start() {
    try {
      // Set bot commands menu
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: '🚀 Начать работу с ботом' },
        { command: 'help', description: '❓ Помощь и инструкции' },
        { command: 'orders', description: '📋 Мои заказы' }
      ]);
      
      await this.bot.launch();
      console.log('Telegram bot started');
    } catch (error) {
      console.error('Failed to start bot:', error);
    }
  }

  public async stop() {
    await this.bot.stop();
  }
}
