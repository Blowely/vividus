import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { UserService } from './user';
import { OrderService } from './order';
import { PaymentService } from './payment';
import { RunwayService } from './runway';
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
  private runwayService: RunwayService;
  private fileService: FileService;
  private mockService: MockService;
  private analyticsService: AnalyticsService;
  private pendingPrompts: Map<number, string> = new Map(); // userId -> fileId
  private pendingPromptsData: Map<number, { fileId: string; prompt: string }> = new Map(); // userId -> {fileId, prompt}
  private pendingMergeFirstPhoto: Map<number, string> = new Map(); // userId -> fileId (для режима объединения)
  private userMessages: Map<number, { messageId: number; chatId: number }> = new Map(); // userId -> {messageId, chatId}
  private waitingForEmail: Set<number> = new Set(); // userId -> waiting for email input
  private waitingForBroadcast: Map<number, { text?: string; mediaType?: string; mediaFileId?: string }> = new Map(); // adminId -> broadcast content

  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    this.userService = new UserService();
    this.orderService = new OrderService();
    this.paymentService = new PaymentService();
    this.runwayService = new RunwayService();
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
    const keyboard = [
      [Markup.button.text('🎬 Оживить фото')],
      [Markup.button.text('✨ Купить генерации'), Markup.button.text('❓ Поддержка')],
    ];

    // Добавляем кнопки для админов
    if (this.isAdmin(userId)) {
      keyboard.push([Markup.button.text('📊 Статистика'), Markup.button.text('Тест рассылки')]);
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
✅Отзывы: @vividusFB

👉 Начните с отправки фото:`;
    
    // Получаем баланс генераций
    const user = await this.userService.getOrCreateUser(ctx.from!);
    const generations = await this.userService.getUserGenerations(ctx.from!.id);
    
    // Создаем reply клавиатуру (кнопки под полем ввода)
      const keyboard = [
      [Markup.button.text('🎬 Оживить фото')],
      [Markup.button.text('✨ Купить генерации'),Markup.button.text('❓ Поддержка')],
      ];

    // Добавляем кнопки для админов
      if (this.isAdmin(ctx.from!.id)) {
      keyboard.push([Markup.button.text('📊 Статистика'), Markup.button.text('Тест рассылки')]);
      }

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
          reply_markup: {
          keyboard: keyboard,
          resize_keyboard: true
          }
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
    const helpMessage = `
❓ Помощь по использованию бота

📸 Как использовать:
1. Отправьте фото (JPG, PNG)
2. Дождитесь обработки
3. Получите анимированное видео!

⏱️ Время обработки: 2-5 минут

💬 По вопросам обращайтесь: @vividusgosupp

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
      
      // Проверяем режим рассылки для админа
      if (this.isAdmin(ctx.from!.id) && this.waitingForBroadcast.has(ctx.from!.id)) {
        await this.handleBroadcastContent(ctx);
        return;
      }
      
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
      
      // Проверяем, находимся ли мы в режиме объединения
      const firstPhotoId = this.pendingMergeFirstPhoto.get(user.telegram_id);
      if (firstPhotoId) {
        if (firstPhotoId === 'MERGE_MODE_WAITING') {
          // Это первое фото в режиме объединения
          this.pendingMergeFirstPhoto.set(user.telegram_id, fileId);
          await this.sendMessage(ctx, '📸 Первое фото получено! Теперь отправьте второе фото.');
          return;
        } else {
          // Это второе фото, обрабатываем объединение
          await this.handleMergeSecondPhoto(ctx, user, fileId);
          return;
        }
      }
      
      // Проверяем наличие caption (текста, прикрепленного к фото)
      const caption = (ctx.message as any)['caption'];
      
      if (caption) {
        // Если есть caption, сразу обрабатываем его как промпт
      this.pendingPrompts.set(user.telegram_id, fileId);
        await this.processPrompt(ctx, user, caption);
      } else {
        // Если нет caption, просим ввести промпт
        const promptMessage = '📸 Фото получено!\n\n✍️ Опишите, как вы хотите анимировать изображение.\n\nНапример: "машет рукой", "улыбается", "моргает", "дышит" и т.д.';
        
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
      if (this.isAdmin(ctx.from!.id) && this.waitingForBroadcast.has(ctx.from!.id)) {
        await this.handleBroadcastContent(ctx);
        return;
      }
      
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
      
      // Проверяем режим рассылки для админа
      if (this.isAdmin(ctx.from!.id) && this.waitingForBroadcast.has(ctx.from!.id)) {
        await this.handleBroadcastContent(ctx);
        return;
      }
      
      // Для обычных пользователей GIF не обрабатываются
      await this.sendMessage(ctx, '❌ Пожалуйста, отправьте фото (не GIF) для создания анимации.');
    } catch (error) {
      console.error('Error handling animation:', error);
      await this.sendMessage(ctx, '❌ Произошла ошибка при обработке GIF.');
    }
  }

  private async handleDocument(ctx: Context) {
    const user = await this.userService.getOrCreateUser(ctx.from!);
    
    // Проверяем режим рассылки для админа
    if (this.isAdmin(ctx.from!.id) && this.waitingForBroadcast.has(ctx.from!.id)) {
      await this.handleBroadcastContent(ctx);
      return;
    }
    
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

      await this.sendMessage(ctx, '📸 Оба фото получены!\n\n✍️ Опишите, как вы хотите анимировать переход между фото.\n\nНапример: "плавный переход", "масштабирование", "вращение" и т.д.');
      
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
      
      // Remove from pending prompts
      this.pendingPrompts.delete(user.telegram_id);
      
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId);
      
      // Process the prompt
      let processedPrompt = promptText.toLowerCase().trim();
      const originalPrompt = promptText;
      
      if (processedPrompt === 'пропустить' || processedPrompt === 'skip') {
        processedPrompt = 'animate this image with subtle movements and breathing effect';
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
        // Проверяем баланс, но не списываем - списание будет после успешной генерации
        if (userGenerations < 1) {
          await this.sendMessage(ctx, '❌ Недостаточно генераций для обработки.\n\n✨ Вы можете купить генерации в меню.');
          return;
        }
        
        // Создаем заказ со статусом processing (без оплаты)
        const order = await this.orderService.createOrder(user.id, s3Url, processedPrompt);
        await this.orderService.updateOrderStatus(order.id, 'processing' as any);
        
        // Объединенное сообщение о промпте, создании заказа и начале генерации
        await this.sendMessage(ctx, `🎬 Отлично! Промпт: "${originalPrompt}"\n\n✅ Заказ создан\n🎬 Начинаю генерацию видео...\n\n⏳ Это займет 2-5 минут.`);
      
        // Запускаем обработку заказа (списание генераций произойдет при успешной генерации)
        const { ProcessorService } = await import('./processor');
        const processorService = new ProcessorService();
        await processorService.processOrder(order.id);
      } else {
        // У пользователя нет генераций - предлагаем купить генерации
        
        // Сохраняем fileId и промпт для повторной обработки после покупки генераций
        this.pendingPrompts.set(user.telegram_id, fileId);
        this.pendingPromptsData.set(user.telegram_id, { fileId, prompt: originalPrompt || 'пропустить' });
        
        const noGenerationsMessage = `💼 У вас нет генераций для обработки фото

📸 Ваше фото сохранено и готово к обработке
🎬 Промпт: "${originalPrompt ? originalPrompt : 'стандартная анимация'}"

Выберите способ оплаты:`;
        
        // Пакеты генераций (оригинальные цены)
        const packages = [
          { count: 1, originalPrice: 129 },
          { count: 3, originalPrice: 387 },
          { count: 5, originalPrice: 645 },
          { count: 10, originalPrice: 1290 }
        ];
        
        // Коэффициент скидки: 69/129 ≈ 0.5349 (скидка ~46.51%)
        const discountCoefficient = 69 / 129;
        
        const keyboard = packages.map(pkg => {
          // Используем цену со скидкой как финальную цену (оригинальная * 69/129)
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
      
      // Проверяем, ожидает ли пользователь ввода email
      if (this.waitingForEmail.has(ctx.from!.id)) {
        await this.processEmailInput(ctx, text);
        return;
      }
      
      // Проверяем режим рассылки для админа
      if (this.isAdmin(ctx.from!.id) && this.waitingForBroadcast.has(ctx.from!.id)) {
        await this.handleBroadcastContent(ctx);
        return;
      }
      
      // Обрабатываем команды от reply кнопок
      if (text === '🎬 Оживить фото') {
        await this.sendMessage(ctx, '📸 Отправьте фото для создания анимации!');
        return;
      }
      
      if (text === '✨ Купить генерации') {
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
      
      if (text === 'Тест рассылки' && this.isAdmin(ctx.from!.id)) {
        await this.sendTestMessage(ctx);
        return;
      }
      
      // Check if user has pending photo
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        // User doesn't have pending photo, treat as regular message
        await this.sendMessage(ctx, '📸 Отправьте фото для создания анимации!');
        return;
      }
      
      // Проверяем, является ли это промптом для объединения
      const promptData = this.pendingPromptsData.get(user.telegram_id);
      if (promptData && promptData.prompt.startsWith('merge:')) {
        // Это промпт для объединяющего заказа
        await this.processMergePrompt(ctx, user, text);
      } else {
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
      
      // Загружаем оба фото в S3
      const firstS3Url = await this.fileService.downloadTelegramFileToS3(firstFileId);
      const secondS3Url = await this.fileService.downloadTelegramFileToS3(secondFileId);
      
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
        
        await this.sendMessage(ctx, `🎬 Отлично! Промпт: "${originalPrompt}"\n\n✅ Заказ на объединение создан\n🎬 Начинаю генерацию видео...\n\n⏳ Это займет 2-5 минут.`);
        
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
        
        const noGenerationsMessage = `💼 У вас нет генераций для обработки фото

📸 Ваши фото сохранены и готовы к обработке
🎬 Промпт: "${originalPrompt ? originalPrompt : 'стандартная анимация'}"

Выберите способ оплаты:`;
        
        // Пакеты генераций (оригинальные цены)
        const packages = [
          { count: 1, originalPrice: 129 },
          { count: 3, originalPrice: 387 },
          { count: 5, originalPrice: 645 },
          { count: 10, originalPrice: 1290 }
        ];
        
        // Коэффициент скидки: 69/129 ≈ 0.5349 (скидка ~46.51%)
        const discountCoefficient = 69 / 129;
        
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
      case 'cancel_broadcast':
        if (this.isAdmin(ctx.from!.id)) {
          this.waitingForBroadcast.delete(ctx.from!.id);
          await ctx.answerCbQuery('❌ Рассылка отменена');
          await this.sendMessage(ctx, '❌ Режим рассылки отменен');
        }
        break;
      case 'broadcast_test':
        if (this.isAdmin(ctx.from!.id)) {
          const broadcastData = this.waitingForBroadcast.get(ctx.from!.id);
          if (broadcastData && (broadcastData.text || broadcastData.mediaFileId)) {
            await ctx.answerCbQuery('🧪 Отправляю тестовому пользователю...');
            
            const targetUserId = 6303475609;
            const result = await this.sendBroadcastToUser(targetUserId, broadcastData);
            
            if (result.success) {
              await this.sendMessage(ctx, `✅ Сообщение успешно отправлено тестовому пользователю (${targetUserId})`);
            } else {
              await this.sendMessage(ctx, `❌ Не удалось отправить сообщение: ${result.reason === 'blocked' ? 'пользователь заблокировал бота' : 'ошибка отправки'}`);
            }
            
            // Очищаем режим рассылки
            this.waitingForBroadcast.delete(ctx.from!.id);
          } else {
            await ctx.answerCbQuery('❌ Контент не найден');
          }
        }
        break;
      case 'broadcast_all':
        if (this.isAdmin(ctx.from!.id)) {
          const broadcastData = this.waitingForBroadcast.get(ctx.from!.id);
          if (broadcastData && (broadcastData.text || broadcastData.mediaFileId)) {
            await ctx.answerCbQuery('📢 Начинаю массовую рассылку...');
            
            // Отправляем начальное сообщение с прогрессом
            const progressMsg = await this.sendMessage(ctx, '📢 Подготовка к рассылке...');
            
            // Запускаем рассылку с обновлением прогресса
            const stats = await this.sendBroadcastToAll(
              broadcastData, 
              ctx.from!.id,
              (progressMsg as any)?.message_id,
              ctx.chat?.id
            );
            
            // Отправляем финальную статистику
            const finalMessage = `✅ Рассылка завершена!\n\n` +
              `📊 Статистика:\n` +
              `👥 Всего пользователей: ${stats.totalUsers}\n` +
              `📤 Обработано: ${stats.processedCount}\n\n` +
              `✅ Успешно доставлено: ${stats.successCount} (${Math.round(stats.successCount / stats.totalUsers * 100)}%)\n` +
              `🚫 Заблокировали бота: ${stats.blockedCount} (${Math.round(stats.blockedCount / stats.totalUsers * 100)}%)\n` +
              `❌ Ошибки отправки: ${stats.errorCount} (${Math.round(stats.errorCount / stats.totalUsers * 100)}%)`;
            
            try {
              await this.bot.telegram.editMessageText(
                ctx.chat!.id,
                (progressMsg as any)?.message_id,
                undefined,
                finalMessage
              );
            } catch (error) {
              await this.sendMessage(ctx, finalMessage);
            }
            
            // Очищаем режим рассылки
            this.waitingForBroadcast.delete(ctx.from!.id);
          } else {
            await ctx.answerCbQuery('❌ Контент не найден');
          }
        }
        break;
      default:
        if (callbackData.startsWith('buy_and_process_')) {
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
🎬 Промпт: ${customPrompt ? `"${customPrompt}"` : 'стандартная анимация'}

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

  private isAdmin(userId: number): boolean {
    const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
    return adminIds.includes(userId);
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
        `👥 Пользователи: ${stat.total_users}\n` +
        `💰 Сумма оплат: ${stat.total_payments_rub.toFixed(2)} ₽\n` +
        `⭐ Сумма в stars: ${stat.total_payments_stars}\n` +
        `🎬 Успешных генераций: ${stat.completed_orders}\n` +
        `📈 Конверсия: ${stat.conversion_rate}%`;

      await ctx.answerCbQuery('✅');
      
      await this.sendMessage(ctx, message, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('◀️ Назад к общей статистике', 'back_to_stats')]
          ]
        }
      });
    } catch (error) {
      console.error('Error showing campaign stats:', error);
      await ctx.answerCbQuery('❌ Ошибка при получении статистики');
    }
  }

  private async sendTestMessage(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await this.sendMessage(ctx, '❌ У вас нет прав для этой команды');
      return;
    }
    
    // Устанавливаем режим ожидания контента для рассылки
    this.waitingForBroadcast.set(ctx.from!.id, {});
    
    await this.sendMessage(ctx, 
      '📨 Режим тестовой рассылки\n\n' +
      'Отправьте сообщение с текстом и/или медиа (фото/видео), которое нужно разослать.\n\n' +
      'Сообщение будет отправлено тестовому пользователю (ID: 6303475609).',
      {
        reply_markup: {
          inline_keyboard: [
            [Markup.button.callback('❌ Отменить', 'cancel_broadcast')]
          ]
        }
      }
    );
  }

  private async handleBroadcastContent(ctx: Context) {
    const adminId = ctx.from!.id;
    const broadcastData = this.waitingForBroadcast.get(adminId);
    
    if (!broadcastData) return false;
    
    const message = ctx.message as any;
    let text = message.text || message.caption || '';
    let mediaType: string | undefined;
    let mediaFileId: string | undefined;
    
    // Определяем тип медиа
    if (message.photo && message.photo.length > 0) {
      mediaType = 'photo';
      mediaFileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.video) {
      mediaType = 'video';
      mediaFileId = message.video.file_id;
    } else if (message.animation) {
      mediaType = 'animation';
      mediaFileId = message.animation.file_id;
    }
    
    // Сохраняем контент
    this.waitingForBroadcast.set(adminId, {
      text: text || undefined,
      mediaType,
      mediaFileId
    });
    
    // Показываем превью и кнопки
    let preview = '📋 Контент для рассылки:\n\n';
    if (mediaType) {
      preview += `📎 Медиа: ${mediaType}\n`;
    }
    if (text) {
      preview += `📝 Текст: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}\n`;
    }
    preview += '\nВыберите действие:';
    
    await this.sendMessage(ctx, preview, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('🧪 Отправить тестовому', 'broadcast_test')],
          [Markup.button.callback('📢 Отправить всем', 'broadcast_all')],
          [Markup.button.callback('❌ Отменить', 'cancel_broadcast')]
        ]
      }
    });
    
    return true;
  }

  private async sendBroadcastToUser(userId: number, broadcastData: { text?: string; mediaType?: string; mediaFileId?: string }): Promise<{ success: boolean; reason?: string }> {
    try {
      if (broadcastData.mediaType && broadcastData.mediaFileId) {
        // Отправляем медиа с текстом
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
        // Отправляем только текст
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

  private getProgressBar(current: number, total: number, width: number = 20): string {
    const percentage = Math.round((current / total) * 100);
    const filledWidth = Math.round((current / total) * width);
    const emptyWidth = width - filledWidth;
    
    const filledBar = '█'.repeat(filledWidth);
    const emptyBar = '░'.repeat(emptyWidth);
    
    return `${filledBar}${emptyBar} ${percentage}%`;
  }

  private async sendBroadcastToAll(broadcastData: { text?: string; mediaType?: string; mediaFileId?: string }, adminId: number, progressMessageId?: number, progressChatId?: number) {
    const client = await pool.connect();
    try {
      // Получаем всех пользователей
      const result = await client.query('SELECT telegram_id FROM users ORDER BY telegram_id');
      const users = result.rows;
      const totalUsers = users.length;
      
      let successCount = 0;
      let blockedCount = 0;
      let errorCount = 0;
      let processedCount = 0;
      
      // Отправляем начальное сообщение с прогрессом
      let progressMessage: any;
      if (progressMessageId && progressChatId) {
        try {
          const initialProgress = `📢 Рассылка началась...\n\n` +
            `📊 Прогресс: 0/${totalUsers}\n` +
            `${this.getProgressBar(0, totalUsers)}\n\n` +
            `✅ Успешно: 0\n` +
            `🚫 Заблокировали: 0\n` +
            `❌ Ошибки: 0`;
          
          progressMessage = await this.bot.telegram.editMessageText(
            progressChatId,
            progressMessageId,
            undefined,
            initialProgress
          );
        } catch (error) {
          console.error('Error creating initial progress message:', error);
        }
      }
      
      // Рассылаем сообщения
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const result = await this.sendBroadcastToUser(user.telegram_id, broadcastData);
        
        processedCount++;
        
        if (result.success) {
          successCount++;
        } else if (result.reason === 'blocked') {
          blockedCount++;
        } else {
          errorCount++;
        }
        
        // Обновляем прогресс каждые 10 пользователей или на последнем
        if (processedCount % 10 === 0 || processedCount === totalUsers) {
          if (progressMessageId && progressChatId) {
            try {
              const progressText = `📢 Рассылка в процессе...\n\n` +
                `📊 Прогресс: ${processedCount}/${totalUsers}\n` +
                `${this.getProgressBar(processedCount, totalUsers)}\n\n` +
                `✅ Успешно: ${successCount}\n` +
                `🚫 Заблокировали: ${blockedCount}\n` +
                `❌ Ошибки: ${errorCount}`;
              
              await this.bot.telegram.editMessageText(
                progressChatId,
                progressMessageId,
                undefined,
                progressText
              );
            } catch (error) {
              // Игнорируем ошибки обновления прогресса
            }
          }
        }
        
        // Задержка между отправками для избежания rate limit
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      return { 
        successCount, 
        blockedCount, 
        errorCount, 
        totalUsers,
        processedCount
      };
    } finally {
      client.release();
    }
  }

  private async showAnalytics(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await this.sendMessage(ctx, '❌ У вас нет прав для просмотра статистики');
      return;
    }

    try {
      const analytics = await this.analyticsService.getCampaignAnalytics();
      
      if (analytics.length === 0) {
        await this.sendMessage(ctx, '📊 Статистика пока пуста');
        return;
      }

      let message = '📊 Статистика по кампаниям:\n\n';
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
        
        message += `🏷️ *${campaignName}*\n`;
        message += `👥 Пользователи: ${stat.total_users}\n`;
        message += `💰 Сумма оплат: ${stat.total_payments_rub} руб\n`;
        message += `⭐ Сумма в stars: ${stat.total_payments_stars}\n`;
        message += `🎬 Успешных генераций: ${stat.completed_orders}\n`;
        message += `📈 Конверсия: ${stat.conversion_rate}%\n\n`;
        
        // Добавляем кнопку для детальной статистики по кампании
        inlineKeyboard.push([
          Markup.button.callback(`📊 Детали: ${stat.campaign_name}`, `campaign_stats_${stat.campaign_name}`)
        ]);
      }
      
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
      
      // Check status via RunwayML API
      const runwayService = new (await import('./runway')).RunwayService();
      const status = await runwayService.checkJobStatus(latestOrder.did_job_id);
      
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
      
      // Пакеты генераций со скидкой ~46.51% (финальная цена за 1 генерацию: 69 руб)
      // Текущие цены - это оригинальные, вычисляем цены со скидкой
      const packages = [
        { count: 1, originalPrice: 129 },
        { count: 3, originalPrice: 387 },
        { count: 5, originalPrice: 645 },
        { count: 10, originalPrice: 1290 }
      ];
      
      // Коэффициент скидки: 69/129 ≈ 0.5349 (скидка ~46.51%)
      const discountCoefficient = 69 / 129;
      
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
      
      const message = `💼 У вас осталось генераций: ${currentGenerations}

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
      
      // Добавляем кнопку оплаты звёздами (пока заглушка)
      keyboard.push([Markup.button.callback('⭐ Оплатить звёздами', 'buy_generations_stars')]);
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
      await this.sendMessage(ctx, '❌ Ошибка при загрузке меню покупки генераций');
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
      
      const message = `💳 Покупка генераций и обработка фото

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽
🆔 ID платежа: ${payment.id.slice(0, 8)}...

После оплаты:
✅ Генерации будут добавлены на ваш баланс
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
      const promptText = 'animate this image with subtle movements and breathing effect'; // Можно сохранять промпт отдельно
      
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId);
      
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
🎬 Промпт: стандартная анимация
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
      
      const message = `💳 Покупка генераций и обработка фото

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽

После оплаты генерации будут добавлены на баланс, и фото будет обработано автоматически.`;
      
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
      
      const message = `💳 Покупка генераций

📦 Пакет: ${generationsCount} ${this.getGenerationWord(generationsCount)}
💰 Сумма: ${price} ₽
🆔 ID платежа: ${payment.id.slice(0, 8)}...

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}

После оплаты генерации будут автоматически добавлены на ваш баланс.`;
      
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
        { count: 1, price: 69 },
        { count: 3, price: 207 },
        { count: 5, price: 345 },
        { count: 10, price: 690 }
      ];
      
      const message = `⭐ Оплата звёздами Telegram

💼 У вас осталось генераций: ${currentGenerations}

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
          description: `Пополнение баланса генераций для обработки фотографий`,
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
            `✅ Генерации успешно пополнены!\n\n➕ Начислено: ${generationsCount} ${this.getGenerationWord(generationsCount)}\n💼 Ваш баланс: ${newBalance} генераций\n⭐ Оплачено: ${starsAmount} звёзд`
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

  private getGenerationWord(count: number): string {
    if (count % 10 === 1 && count % 100 !== 11) {
      return 'генерация';
    } else if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
      return 'генерации';
    } else {
      return 'генераций';
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
