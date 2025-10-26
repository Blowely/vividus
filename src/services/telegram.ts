import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { UserService } from './user';
import { OrderService } from './order';
import { PaymentService } from './payment';
import { RunwayService } from './runway';
import { FileService } from './file';
import { MockService } from './mock';
import { AnalyticsService } from './analytics';

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
  private pendingPrompts: Map<number, string> = new Map(); // userId -> filePath

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
    this.bot.catch((err, ctx) => {
      console.error('Bot error:', err);
      ctx.reply('Произошла ошибка. Попробуйте позже.');
    });
  }

  private async handleStart(ctx: Context) {
    // Получаем параметр из команды /start
    const startParam = ctx.message && 'text' in ctx.message ? 
      ctx.message.text.split(' ')[1] : null;
    
    // Логируем источник перехода
    if (startParam) {
      console.log(`User ${ctx.from?.id} started bot with parameter: ${startParam}`);
      // Обновляем статистику кампании
      await this.analyticsService.updateCampaignStats(startParam);
    }
    
    const user = await this.userService.getOrCreateUser(ctx.from!, startParam);
    
    const welcomeMessage = `
🎬 Добро пожаловать в Vividus Bot!

Я помогу оживить ваши фотографии с помощью нейросети.

📸 Отправьте мне фото, и я создам анимированное видео!

💰 Стоимость: 299 рублей за обработку

Для начала просто отправьте фото!`;
    
      // Создаем клавиатуру
      const keyboard = [
        [Markup.button.callback('📋 Мои заказы', 'my_orders')],
        [Markup.button.callback('❓ Помощь', 'help')],
        [Markup.button.callback('🎭 Тест оплаты', 'mock_payment')],
        [Markup.button.callback('🎬 Получить результат', 'get_result')]
      ];

      // Добавляем кнопку статистики для админов
      if (this.isAdmin(ctx.from!.id)) {
        keyboard.push([Markup.button.callback('📊 Статистика', 'show_stats')]);
      }

      await ctx.reply(welcomeMessage, {
        reply_markup: {
          inline_keyboard: keyboard
        }
      });
  }

  private async handleHelp(ctx: Context) {
    const helpMessage = `
❓ Помощь по использованию бота

📸 Как использовать:
1. Отправьте фото (JPG, PNG)
2. Дождитесь обработки
3. Получите анимированное видео!

💰 Стоимость: 299 рублей за обработку

⏱️ Время обработки: 2-5 минут

📞 Поддержка: @support_username

Для начала отправьте фото!`;
    
    await ctx.reply(helpMessage);
  }

  private async handlePhoto(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const photo = (ctx.message as any)['photo'];
      
      // Get the highest quality photo
      const fileId = photo[photo.length - 1].file_id;
      
      await ctx.reply('📸 Фото получено! Теперь опишите, как вы хотите анимировать изображение.\n\nНапример: "машет рукой", "улыбается", "моргает", "дышит" и т.д.\n\nИли отправьте "пропустить" для стандартной анимации.');
      
      // Store file ID for later processing (we'll upload to S3 when user provides prompt)
      this.pendingPrompts.set(user.telegram_id, fileId);
      
    } catch (error) {
      console.error('Error handling photo:', error);
      await ctx.reply('Произошла ошибка при обработке фото. Попробуйте позже.');
    }
  }

  private async handleDocument(ctx: Context) {
    const document = (ctx.message as any)['document'];
    const mimeType = document.mime_type;
    
    if (mimeType && mimeType.startsWith('image/')) {
      await this.handlePhoto(ctx);
    } else {
      await ctx.reply('Пожалуйста, отправьте изображение в формате JPG или PNG.');
    }
  }

  private async handleText(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      const text = (ctx.message as any).text;
      
      // Check if user has pending photo
      const fileId = this.pendingPrompts.get(user.telegram_id);
      if (!fileId) {
        // User doesn't have pending photo, treat as regular message
        await ctx.reply('Отправьте фото для создания анимации!');
        return;
      }
      
      // Remove from pending prompts
      this.pendingPrompts.delete(user.telegram_id);
      
      // Upload photo directly to S3
      await ctx.reply('📤 Загружаю фото в облако...');
      const s3Url = await this.fileService.downloadTelegramFileToS3(fileId);
      
      // Process the prompt
      let promptText = text.toLowerCase();
      
      if (promptText === 'пропустить' || promptText === 'skip') {
        promptText = 'animate this image with subtle movements and breathing effect';
      } else {
        // Translate Russian prompts to English for better AI understanding
        const translatedPrompt = this.translatePrompt(promptText);
        promptText = `animate this image with ${translatedPrompt}`;
      }
      
      await ctx.reply(`🎬 Отлично! Промпт: "${text}"\n\nСоздаю заказ...`);
      
      // Create order with custom prompt and S3 URL
      const order = await this.orderService.createOrder(user.id, s3Url, 299, promptText);
      
      // Store custom prompt in order metadata (we'll need to add this field)
      // For now, we'll pass it through the RunwayService
      
      // Send payment request
      await this.sendPaymentRequest(ctx, order, promptText);
      
    } catch (error) {
      console.error('Error handling text:', error);
      await ctx.reply('Произошла ошибка при обработке промпта. Попробуйте позже.');
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
      default:
        if (callbackData.startsWith('pay_')) {
          const orderId = callbackData.replace('pay_', '');
          await this.handlePayOrder(ctx, orderId);
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
    
    await ctx.reply(paymentMessage, {
      reply_markup: {
        inline_keyboard: [
          [Markup.button.callback('💳 Оплатить', `pay_${order.id}`)],
          [Markup.button.callback('❌ Отменить', 'cancel')]
        ]
      }
    });
  }

  private async showUserOrders(ctx: Context) {
    const user = await this.userService.getOrCreateUser(ctx.from!);
    const orders = await this.orderService.getUserOrders(user.id);
    
    if (orders.length === 0) {
      await ctx.reply('📋 У вас пока нет заказов. Отправьте фото для создания первого заказа!');
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
    
    await ctx.reply(message, {
      reply_markup: keyboard.length > 0 ? {
        inline_keyboard: keyboard
      } : undefined
    });
  }

  private isAdmin(userId: number): boolean {
    const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
    return adminIds.includes(userId);
  }

  private async showAnalytics(ctx: Context) {
    if (!this.isAdmin(ctx.from!.id)) {
      await ctx.reply('❌ У вас нет прав для просмотра статистики');
      return;
    }

    try {
      const analytics = await this.analyticsService.getCampaignAnalytics();
      
      if (analytics.length === 0) {
        await ctx.reply('📊 Статистика пока пуста');
        return;
      }

      let message = '📊 Статистика по кампаниям:\n\n';
      
      for (const stat of analytics) {
        message += `🏷️ **${stat.campaign_name}**\n`;
        message += `👥 Пользователи: ${stat.total_users}\n`;
        message += `💰 Сумма оплат: ${stat.total_payments_rub} руб\n`;
        message += `⭐ Сумма в stars: ${stat.total_payments_stars}\n`;
        message += `📈 Конверсия: ${stat.conversion_rate}%\n\n`;
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Error showing analytics:', error);
      await ctx.reply('❌ Ошибка при получении статистики');
    }
  }

  private async handlePayOrder(ctx: Context, orderId?: string) {
    if (!orderId) {
      await ctx.reply('Ошибка: не указан ID заказа');
      return;
    }
    
    try {
      const order = await this.orderService.getOrder(orderId);
      if (!order) {
        await ctx.reply('Заказ не найден');
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

Для оплаты перейдите по ссылке:
${paymentUrl}

После оплаты бот автоматически получит уведомление и начнет обработку.`;
      
      await ctx.reply(paymentMessage);
      
    } catch (error) {
      console.error('Error creating payment:', error);
      await ctx.reply('Ошибка при создании платежа. Попробуйте позже.');
    }
  }

  private async handleMockPayment(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Получаем последний заказ пользователя
      const orders = await this.orderService.getUserOrders(user.id);
      if (orders.length === 0) {
        await ctx.reply('У вас нет заказов для тестирования. Сначала отправьте фото!');
        return;
      }
      
      const lastOrder = orders[0];
      
      if (lastOrder.status !== 'payment_required') {
        await ctx.reply(`Заказ уже в статусе: ${this.getOrderStatusText(lastOrder.status)}`);
        return;
      }
      
      // Мокаем успешную оплату
      await this.mockService.mockSuccessfulPayment(lastOrder.id);
      
      await ctx.reply('🎭 Мок-платеж успешен! Заказ переведен в обработку.');
      
    } catch (error) {
      console.error('Error in mock payment:', error);
      await ctx.reply('Ошибка при мок-платеже. Попробуйте позже.');
    }
  }

  private async handleGetResult(ctx: Context) {
    try {
      const user = await this.userService.getOrCreateUser(ctx.from!);
      
      // Get user's completed orders
      const orders = await this.orderService.getUserOrders(user.id);
      const completedOrders = orders.filter(order => order.status === 'completed');
      
      if (completedOrders.length === 0) {
        await ctx.reply('❌ У вас пока нет готовых видео. Сначала отправьте фото для обработки!');
        return;
      }
      
      // Get the most recent completed order
      const latestOrder = completedOrders[0];
      
      if (!latestOrder.did_job_id) {
        await ctx.reply('❌ Информация о видео не найдена. Попробуйте позже.');
        return;
      }
      
      // Check status via RunwayML API
      const runwayService = new (await import('./runway')).RunwayService();
      const status = await runwayService.checkJobStatus(latestOrder.did_job_id);
      
      if (status.status === 'SUCCEEDED' && status.output && status.output.length > 0) {
        const videoUrl = status.output[0];
        
        await ctx.reply(`🎬 Ваше последнее видео готово!\n\n📹 Результат: ${videoUrl}\n\nСпасибо за использование Vividus Bot!`);
      } else {
        await ctx.reply(`⏳ Статус обработки: ${status.status}\n\nПопробуйте позже.`);
      }
      
    } catch (error) {
      console.error('Error getting result:', error);
      await ctx.reply('❌ Ошибка при получении результата');
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
        { command: 'mock_pay', description: '🎭 Тест оплаты (для разработки)' },
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
