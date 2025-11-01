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
  private userMessages: Map<number, { messageId: number; chatId: number }> = new Map(); // userId -> {messageId, chatId}
  private waitingForEmail: Set<number> = new Set(); // userId -> waiting for email input

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

  private async editOrSendMessage(ctx: Context, text: string, extra?: any): Promise<void> {
    const userId = ctx.from!.id;
    const chatId = ctx.chat!.id;
    const userMessage = this.userMessages.get(userId);

    // Убеждаемся, что reply-клавиатура сохраняется, если не указано явное удаление
    const extraWithKeyboard = this.ensureReplyKeyboard(ctx, extra);

    try {
      if (userMessage && userMessage.chatId === chatId) {
        // Редактируем существующее сообщение
        await ctx.telegram.editMessageText(
          chatId,
          userMessage.messageId,
          undefined,
          text,
          extraWithKeyboard
        );
      } else {
        // Отправляем новое сообщение
        const message = await ctx.reply(text, extraWithKeyboard);
        if (message && 'message_id' in message) {
          this.userMessages.set(userId, {
            messageId: (message as any).message_id,
            chatId: chatId
          });
        }
      }
    } catch (error: any) {
      // Если не можем отредактировать (сообщение не найдено или слишком старое), отправляем новое
      if (error.code === 400 || error.description?.includes('message') || error.description?.includes('not found')) {
        const message = await ctx.reply(text, extraWithKeyboard);
        if (message && 'message_id' in message) {
          this.userMessages.set(userId, {
            messageId: (message as any).message_id,
            chatId: chatId
          });
        }
      } else {
        throw error;
      }
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

  private async deleteUserMessage(ctx: Context): Promise<void> {
    const userId = ctx.from!.id;
    const userMessage = this.userMessages.get(userId);

    if (userMessage) {
      try {
        await ctx.telegram.deleteMessage(userMessage.chatId, userMessage.messageId);
        this.userMessages.delete(userId);
      } catch (error) {
        // Игнорируем ошибки при удалении (сообщение может быть уже удалено)
        console.error('Error deleting message:', error);
      }
    }
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
    } catch (error) {
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
    
    // Document handler (for other image formats)
    this.bot.on('document', this.handleDocument.bind(this));
    
    // Text handler for prompts
    this.bot.on('text', this.handleText.bind(this));
    
    // Callback query handler
    this.bot.on('callback_query', this.handleCallbackQuery.bind(this));
    
    // Error handler
    this.bot.catch(async (err, ctx) => {
      console.error('Bot error:', err);
      if (ctx.from && ctx.chat) {
        await this.editOrSendMessage(ctx, 'Произошла ошибка. Попробуйте позже.');
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
    
    // Удаляем сообщение /start пользователя
    if (ctx.message && 'message_id' in ctx.message && ctx.chat) {
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id);
      } catch (error) {
        // Игнорируем ошибки при удалении (сообщение может быть уже удалено или права недостаточны)
        console.error('Error deleting /start message:', error);
      }
    }
  }

  private async showMainMenu(ctx: Context) {
    const welcomeMessage = `
🎬 Добро пожаловать в Vividus Bot!

Я помогу оживить ваши фотографии с помощью нейросети.

📸 Как это работает:
1️⃣ Отправьте фото прямо сейчас (можно с подписью-промптом)
2️⃣ Опишите анимацию или нажмите "Пропустить"
3️⃣ Оплатите заказ
4️⃣ Получите готовое видео через 2-5 минут!

💰 Стоимость: 1 рубль за обработку

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
      keyboard.push([Markup.button.text('📊 Статистика')]);
    }

    // Для приветствия всегда отправляем новое сообщение (не редактируем)
    const message = await ctx.reply(welcomeMessage, {
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: true
      }
    });
    // Сохраняем message_id для последующих сообщений
    if (message && 'message_id' in message) {
      this.userMessages.set(ctx.from!.id, {
        messageId: (message as any).message_id,
        chatId: ctx.chat!.id
      });
    }
  }

  private async handleHelp(ctx: Context) {
    const helpMessage = `
❓ Помощь по использованию бота

📸 Как использовать:
1. Отправьте фото (JPG, PNG)
2. Дождитесь обработки
3. Получите анимированное видео!

💰 Стоимость: 109 рублей за обработку

⏱️ Время обработки: 2-5 минут

📞 Поддержка: @in_a_state_of_flux

Для начала отправьте фото!`;
    
        await this.editOrSendMessage(ctx, helpMessage, {
          reply_markup: {
            inline_keyboard: [this.getBackButton()]
          }
        });
  }

  private async handlePhoto(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const photo = (ctx.message as any)['photo'];
      
      // Get the highest quality photo
      const fileId = photo[photo.length - 1].file_id;
      
      // Проверяем наличие caption (текста, прикрепленного к фото)
      const caption = (ctx.message as any)['caption'];
      
      // Удаляем предыдущее сообщение, если есть
      await this.deleteUserMessage(ctx);
      
      if (caption) {
        // Если есть caption, сразу обрабатываем его как промпт
        this.pendingPrompts.set(user.telegram_id, fileId);
        await this.processPrompt(ctx, user, caption);
      } else {
        // Если нет caption, просим ввести промпт
        const promptMessage = '📸 Фото получено!\n\n✍️ Опишите, как вы хотите анимировать изображение.\n\nНапример: "машет рукой", "улыбается", "моргает", "дышит" и т.д.';
        
        await this.editOrSendMessage(ctx, promptMessage, {
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('⏭️ Пропустить промпт', 'skip_prompt')],
              this.getBackButton()
            ]
          }
        });
        
        // Store file ID for later processing
        this.pendingPrompts.set(user.telegram_id, fileId);
      }
      
    } catch (error) {
      console.error('Error handling photo:', error);
      await this.editOrSendMessage(ctx, '❌ Произошла ошибка при обработке фото. Попробуйте позже.');
    }
  }

  private async handleDocument(ctx: Context) {
    const document = (ctx.message as any)['document'];
    const mimeType = document.mime_type;
    
    if (mimeType && mimeType.startsWith('image/')) {
      await this.handlePhoto(ctx);
    } else {
      await this.editOrSendMessage(ctx, '❌ Пожалуйста, отправьте изображение в формате JPG или PNG.');
    }
  }

  private async processPrompt(ctx: Context, user: any, promptText: string): Promise<void> {
    try {
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        await this.editOrSendMessage(ctx, '❌ Фото не найдено. Отправьте фото заново!');
        return;
      }
      
      // Remove from pending prompts
      this.pendingPrompts.delete(user.telegram_id);
      
      // Обновляем сообщение о загрузке
      await this.editOrSendMessage(ctx, '📤 Загружаю фото в облако...');
      
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
      
      // Удаляем сообщение и создаем новое
      await this.deleteUserMessage(ctx);
      
      await this.editOrSendMessage(ctx, `🎬 Отлично! Промпт: "${originalPrompt}"\n\n⏳ Создаю заказ...`);
      
      // Проверяем баланс генераций пользователя
      const userGenerations = await this.userService.getUserGenerations(user.telegram_id);
      
      if (userGenerations >= 1) {
        // У пользователя есть генерации - списываем их и создаем заказ без оплаты
        const deducted = await this.userService.deductGenerations(user.telegram_id, 1);
        
        if (!deducted) {
          await this.editOrSendMessage(ctx, '❌ Недостаточно генераций для обработки.\n\n✨ Вы можете купить генерации в меню.');
          return;
        }
        
        // Создаем заказ со статусом processing (без оплаты)
        const order = await this.orderService.createOrder(user.id, s3Url, 0, processedPrompt);
        await this.orderService.updateOrderStatus(order.id, 'processing' as any);
        
        const remainingGenerations = await this.userService.getUserGenerations(user.telegram_id);
        
        await this.deleteUserMessage(ctx);
        await this.editOrSendMessage(ctx, `✅ Генерация использована! Осталось: ${remainingGenerations}\n\n🎬 Начинаю обработку вашего фото...\n\n⏳ Это займет 2-5 минут.`);
        
        // Запускаем обработку заказа
        const { ProcessorService } = await import('./processor');
        const processorService = new ProcessorService();
        await processorService.processOrder(order.id);
      } else {
        // У пользователя нет генераций - предлагаем купить генерации
        await this.deleteUserMessage(ctx);
        
        // Сохраняем fileId для повторной обработки после покупки генераций
        // Используем pendingPrompts для сохранения информации о фото
        const tempOrderId = `temp_${Date.now()}_${user.telegram_id}`;
        this.pendingPrompts.set(user.telegram_id, fileId); // Сохраняем для повторной обработки
        
        const noGenerationsMessage = `💼 У вас нет генераций для обработки фото

📸 Ваше фото сохранено и готово к обработке
🎬 Промпт: "${originalPrompt ? originalPrompt : 'стандартная анимация'}"

Выберите способ оплаты:`;
        
        // Пакеты генераций
        const packages = [
          { count: 1, originalPrice: 105 },
          { count: 3, originalPrice: 315 },
          { count: 5, originalPrice: 525 },
          { count: 10, originalPrice: 950 }
        ];
        
        const keyboard = packages.map(pkg => {
          // Вычисляем цену со скидкой 33% (оригинальная * 0.67)
          const discountedPrice = Math.round(pkg.originalPrice * 0.67);
          // Используем combining strikethrough (U+0336) для визуального зачеркивания
          const strikethroughOriginal = `${pkg.originalPrice}₽`.split('').join('\u0336') + '\u0336';
          const buttonText = `${strikethroughOriginal} ${discountedPrice}₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)}`;
          return [
            Markup.button.callback(
              buttonText,
              `buy_and_process_${pkg.count}_${discountedPrice}`
            )
          ];
        });
        
        keyboard.push(this.getBackButton());
        
        await this.editOrSendMessage(ctx, noGenerationsMessage, {
          reply_markup: {
            inline_keyboard: keyboard
          }
        });
      }
      
    } catch (error) {
      console.error('Error processing prompt:', error);
      await this.editOrSendMessage(ctx, '❌ Произошла ошибка при обработке промпта. Попробуйте позже.');
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
      
      // Обрабатываем команды от reply кнопок
      if (text === '🎬 Оживить фото') {
        await this.editOrSendMessage(ctx, '📸 Отправьте фото для создания анимации!');
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
      
      // Check if user has pending photo
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        // User doesn't have pending photo, treat as regular message
        await this.editOrSendMessage(ctx, '📸 Отправьте фото для создания анимации!');
        return;
      }
      
      // Обрабатываем промпт
      await this.processPrompt(ctx, user, text);
      
    } catch (error) {
      console.error('Error handling text:', error);
      await this.editOrSendMessage(ctx, '❌ Произошла ошибка при обработке промпта. Попробуйте позже.');
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
      case 'back_to_menu':
        // Удаляем inline клавиатуру и показываем главное меню с reply клавиатурой
        try {
          await ctx.reply('◀️ Возвращаюсь в главное меню...', {
            reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
          });
        } catch (e) {
          // Игнорируем ошибки
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
      default:
        if (callbackData.startsWith('pay_')) {
          const orderId = callbackData.replace('pay_', '');
          await this.handlePayOrder(ctx, orderId);
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
💰 Стоимость: ${order.price} рублей

Для оплаты нажмите кнопку ниже:`;
    
    await this.editOrSendMessage(ctx, paymentMessage, {
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
      await this.editOrSendMessage(ctx, '📋 У вас пока нет заказов. Отправьте фото для создания первого заказа!');
      return;
    }
    
    let message = '📋 Ваши заказы:\n\n';
    const completedOrders = orders.filter(order => order.status === 'completed');
    
    for (const order of orders) {
      const status = this.getOrderStatusText(order.status);
      message += `🆔 ${order.id.slice(0, 8)}...\n`;
      message += `📊 Статус: ${status}\n`;
      message += `💰 Стоимость: ${order.price} руб\n`;
      message += `📅 Дата: ${new Date(order.created_at).toLocaleDateString()}\n\n`;
    }
    
    // Add buttons for completed orders
    const keyboard = [];
    if (completedOrders.length > 0) {
      keyboard.push([Markup.button.callback('🎬 Получить последний результат', 'get_result')]);
    }
    keyboard.push(this.getBackButton());
    
    await this.editOrSendMessage(ctx, message, {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  }

  private isAdmin(userId: number): boolean {
    const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
    return adminIds.includes(userId);
  }

  private async showAnalytics(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await this.editOrSendMessage(ctx, '❌ У вас нет прав для просмотра статистики');
      return;
    }

    try {
      const analytics = await this.analyticsService.getCampaignAnalytics();
      
      if (analytics.length === 0) {
        await this.editOrSendMessage(ctx, '📊 Статистика пока пуста');
        return;
      }

      let message = '📊 Статистика по кампаниям:\n\n';
      
      for (const stat of analytics) {
        message += `🏷️ **${stat.campaign_name}**\n`;
        message += `👥 Пользователи: ${stat.total_users}\n`;
        message += `💰 Сумма оплат: ${stat.total_payments_rub} руб\n`;
        message += `⭐ Сумма в stars: ${stat.total_payments_stars}\n`;
        message += `🎬 Успешных генераций: ${stat.completed_orders}\n`;
        message += `📈 Конверсия: ${stat.conversion_rate}%\n\n`;
      }

      await this.editOrSendMessage(ctx, message, { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [this.getBackButton()]
        }
      });
    } catch (error) {
      console.error('Error showing analytics:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при получении статистики');
    }
  }

  private async handlePayOrder(ctx: Context, orderId?: string) {
    if (!orderId) {
      await this.editOrSendMessage(ctx, '❌ Ошибка: не указан ID заказа');
      return;
    }
    
    try {
      const order = await this.orderService.getOrder(orderId);
      if (!order) {
        await this.editOrSendMessage(ctx, '❌ Заказ не найден');
        return;
      }
      
      // Create payment
      const payment = await this.paymentService.createPayment(order.id, order.price);
      
      // Generate YooMoney payment URL
      const paymentUrl = await this.paymentService.generatePaymentUrl(payment.id, order.price);
      
      const paymentMessage = `
💳 Оплата заказа

🆔 Заказ: ${order.id.slice(0, 8)}...
💰 Сумма: ${order.price} рублей

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}

После оплаты бот автоматически получит уведомление и начнет обработку.`;
      
      await this.editOrSendMessage(ctx, paymentMessage, {
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
      await this.editOrSendMessage(ctx, '❌ Ошибка при создании платежа. Попробуйте позже.');
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

      await this.editOrSendMessage(ctx, testMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [this.getBackButton()]
        }
      });
      
    } catch (error) {
      console.error('Error creating test payment:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при создании тестового платежа. Попробуйте позже.');
    }
  }

  private async handleMockPayment(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Получаем последний заказ пользователя
      const orders = await this.orderService.getUserOrders(user.id);
      if (orders.length === 0) {
        await this.editOrSendMessage(ctx, 'У вас нет заказов для тестирования. Сначала отправьте фото!');
        return;
      }
      
      const lastOrder = orders[0];
      
      if (lastOrder.status !== 'payment_required') {
        await this.editOrSendMessage(ctx, `Заказ уже в статусе: ${this.getOrderStatusText(lastOrder.status)}`);
        return;
      }
      
      // Мокаем успешную оплату
      await this.mockService.mockSuccessfulPayment(lastOrder.id);
      
      await this.editOrSendMessage(ctx, '🎭 Мок-платеж успешен! Заказ переведен в обработку.');
      
    } catch (error) {
      console.error('Error in mock payment:', error);
      await this.editOrSendMessage(ctx, 'Ошибка при мок-платеже. Попробуйте позже.');
    }
  }

  private async handleGetResult(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Get user's completed orders
      const orders = await this.orderService.getUserOrders(user.id);
      const completedOrders = orders.filter(order => order.status === 'completed');
      
      if (completedOrders.length === 0) {
        await this.editOrSendMessage(ctx, '❌ У вас пока нет готовых видео. Сначала отправьте фото для обработки!');
        return;
      }
      
      // Get the most recent completed order
      const latestOrder = completedOrders[0];
      
      if (!latestOrder.did_job_id) {
        await this.editOrSendMessage(ctx, '❌ Информация о видео не найдена. Попробуйте позже.');
        return;
      }
      
      // Check status via RunwayML API
      const runwayService = new (await import('./runway')).RunwayService();
      const status = await runwayService.checkJobStatus(latestOrder.did_job_id);
      
      if (status.status === 'SUCCEEDED' && status.output && status.output.length > 0) {
        const videoUrl = status.output[0];
        
        await this.editOrSendMessage(ctx, `🎬 Ваше последнее видео готово!\n\n📹 Результат: ${this.formatLink(videoUrl, 'Ссылка')}\n\nСпасибо за использование Vividus Bot!`, {
          parse_mode: 'HTML'
        });
        
        // Сообщение о возможности отправить следующее фото (отправляем новое сообщение, не редактируем)
        setTimeout(async () => {
          await ctx.reply('📸 Вы можете сразу отправить следующее фото для создания нового видео!', {
            reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
          });
        }, 2000);
      } else {
        await this.editOrSendMessage(ctx, `⏳ Статус обработки: ${status.status}\n\nПопробуйте позже.`);
      }
      
    } catch (error) {
      console.error('Error getting result:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при получении результата');
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

      await this.editOrSendMessage(ctx, settingsMessage, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
    } catch (error) {
      console.error('Error showing settings:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при открытии настроек');
    }
  }

  private async handleSetEmail(ctx: Context) {
    this.waitingForEmail.add(ctx.from!.id);
    await this.editOrSendMessage(ctx, '📧 Пожалуйста, отправьте ваш email адрес:\n\nПример: example@mail.ru', {
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
      await this.editOrSendMessage(ctx, '✅ Email удален из настроек');
      await ctx.answerCbQuery();
      // Обновляем меню настроек
      setTimeout(() => this.handleSettings(ctx), 500);
    } catch (error) {
      console.error('Error clearing email:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при удалении email');
    }
  }

  private async processEmailInput(ctx: Context, emailText: string) {
    try {
      // Простая валидация email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      
      if (!emailRegex.test(emailText.trim())) {
        await this.editOrSendMessage(ctx, '❌ Некорректный формат email. Попробуйте еще раз:\n\nПример: example@mail.ru', {
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
      
      await this.deleteUserMessage(ctx);
      await this.editOrSendMessage(ctx, `✅ Email успешно сохранен: ${email}\n\nТеперь кассовые чеки будут приходить на этот адрес.`);
      
      // Возвращаемся в меню настроек через 2 секунды
      setTimeout(() => this.handleSettings(ctx), 2000);
      
    } catch (error) {
      console.error('Error processing email:', error);
      this.waitingForEmail.delete(ctx.from!.id);
      await this.editOrSendMessage(ctx, '❌ Ошибка при сохранении email. Попробуйте позже.');
    }
  }

  private async handleBuyGenerations(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const currentGenerations = await this.userService.getUserGenerations(ctx.from!.id);
      
      // Пакеты генераций со скидкой 33%
      // Текущие цены - это оригинальные, вычисляем цены со скидкой
      const packages = [
        { count: 7, price: 1, isTest: true }, // Тестовый пакет
        { count: 1, originalPrice: 105 },
        { count: 3, originalPrice: 315 },
        { count: 5, originalPrice: 525 },
        { count: 10, originalPrice: 950 }
      ];
      
      const message = `💼 У вас осталось генераций: ${currentGenerations}

Выберите пакет 👇`;
      
      const keyboard = packages.map(pkg => {
        let buttonText: string;
        let actualPrice: number;
        
        if (pkg.isTest) {
          actualPrice = pkg.price;
          buttonText = `🧪 ${actualPrice} ₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)} (тест)`;
        } else {
          // Вычисляем цену со скидкой 33% (оригинальная * 0.67)
          actualPrice = Math.round((pkg.originalPrice as number) * 0.67);
          const originalPrice = pkg.originalPrice as number;
          // Используем combining strikethrough (U+0336) для визуального зачеркивания
          const strikethroughOriginal = `${originalPrice}₽`.split('').join('\u0336') + '\u0336';
          buttonText = `${strikethroughOriginal} ${actualPrice}₽ → ${pkg.count} ${this.getGenerationWord(pkg.count)}`;
        }
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
      await ctx.reply(message, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
      
      // Отправляем отдельное сообщение с reply-клавиатурой, чтобы она всегда была видна
      // (после inline-сообщений reply-клавиатура может пропасть)
      setTimeout(async () => {
        try {
          await ctx.reply('💡 Используйте кнопки ниже для навигации', {
            reply_markup: this.getMainReplyKeyboard(ctx.from!.id)
          });
        } catch (e) {
          // Игнорируем ошибки (клавиатура уже может быть видна)
        }
      }, 500);
    } catch (error) {
      console.error('Error showing buy generations menu:', error);
      await this.editOrSendMessage(ctx, '❌ Ошибка при загрузке меню покупки генераций');
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
      
      await this.editOrSendMessage(ctx, message, {
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
      await this.editOrSendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
    }
  }

  private async handleSingleOrderPayment(ctx: Context) {
    try {
      await ctx.answerCbQuery();
      
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const fileId = this.pendingPrompts.get(user.telegram_id);
      
      if (!fileId) {
        await this.editOrSendMessage(ctx, '❌ Фото не найдено. Отправьте фото заново!');
        return;
      }
      
      // Получаем промпт (если был сохранен)
      const promptText = 'animate this image with subtle movements and breathing effect'; // Можно сохранять промпт отдельно
      
      await this.editOrSendMessage(ctx, '📤 Загружаю фото в облако...');
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId);
      
      // Создаем заказ с оплатой
      const order = await this.orderService.createOrder(user.id, s3Url, 1, promptText);
      
      // Создаем платеж
      const payment = await this.paymentService.createPayment(order.id, order.price);
      const paymentUrl = await this.paymentService.generatePaymentUrl(payment.id, order.price);
      
      // Удаляем из pending
      this.pendingPrompts.delete(user.telegram_id);
      
      const paymentMessage = `
💳 Оплата заказа

📸 Фото: готово к обработке
🎬 Промпт: стандартная анимация
💰 Стоимость: ${order.price} рублей

Для оплаты нажмите кнопку ниже или перейдите по ${this.formatLink(paymentUrl, 'ссылке')}`;
      
      await this.editOrSendMessage(ctx, paymentMessage, {
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
      await this.editOrSendMessage(ctx, '❌ Ошибка при создании платежа. Попробуйте позже.');
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
      
      await this.editOrSendMessage(ctx, message, {
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
      await this.editOrSendMessage(ctx, `❌ Ошибка при создании платежа: ${errorMessage}\n\nПопробуйте позже.`);
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
