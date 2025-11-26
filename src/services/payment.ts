import pool from '../config/database';
import { PaymentStatus } from '../types';
import { config } from 'dotenv';
import axios from 'axios';
import { Telegraf } from 'telegraf';

config();

// Глобальное хранилище для покупок генераций с автообработкой фото
if (typeof (global as any).pendingGenerationPurchases === 'undefined') {
  (global as any).pendingGenerationPurchases = new Map<string, { fileId: string; prompt: string; telegramId: number }>();
}

export class PaymentService {
  private bot: Telegraf;
  
  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
  }
  async createPayment(orderId: string, amount: number): Promise<any> {
    const client = await pool.connect();
    try {
      // Получаем user_id из заказа
      const orderResult = await client.query(
        'SELECT user_id FROM orders WHERE id = $1',
        [orderId]
      );
      
      if (!orderResult.rows[0]) {
        throw new Error(`Order ${orderId} not found`);
      }
      
      const userId = orderResult.rows[0].user_id;
      
      // Сохраняем платеж с user_id для прямой связи с пользователем
      const result = await client.query(
        'INSERT INTO payments (order_id, user_id, amount, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [orderId, userId, amount, PaymentStatus.PENDING]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async createTestPayment(amount: number = 109, telegramId?: number): Promise<any> {
    const client = await pool.connect();
    try {
      // Получаем user_id по telegram_id если передан
      let userId = null;
      if (telegramId) {
        const userResult = await client.query(
          'SELECT id FROM users WHERE telegram_id = $1',
          [telegramId]
        );
        if (userResult.rows[0]) {
          userId = userResult.rows[0].id;
        }
      }
      
      // Создаем тестовый платеж без order_id (NULL), но с user_id для связи с пользователем
      const result = await client.query(
        'INSERT INTO payments (order_id, user_id, amount, status, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
        [null, userId, amount, PaymentStatus.PENDING]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async createGenerationPurchase(telegramId: number, generationsCount: number, amount: number, fileId?: string, prompt?: string): Promise<any> {
    const client = await pool.connect();
    try {
      // Получаем user_id по telegram_id
      const userResult = await client.query(
        'SELECT id FROM users WHERE telegram_id = $1',
        [telegramId]
      );
      
      if (!userResult.rows[0]) {
        throw new Error(`User with telegram_id ${telegramId} not found`);
      }
      
      const userId = userResult.rows[0].id;
      
      // Сохраняем file_id и prompt в metadata платежа (если они есть)
      // Используем JSONB для хранения дополнительных данных
      let paymentMetadata = null;
      if (fileId || prompt) {
        paymentMetadata = JSON.stringify({ file_id: fileId, prompt: prompt });
      }
      
      // Создаем платеж для покупки генераций (без order_id)
      // Добавляем metadata через JSONB (если поле есть) или через отдельное поле
      const result = await client.query(
        `INSERT INTO payments (order_id, user_id, amount, status, created_at) 
         VALUES ($1, $2, $3, $4, NOW()) 
         RETURNING *`,
        [null, userId, amount, PaymentStatus.PENDING]
      );
      
      // Сохраняем file_id и prompt в глобальном хранилище для использования в webhook
      if (fileId || prompt) {
        const paymentId = result.rows[0].id;
        (global as any).pendingGenerationPurchases.set(paymentId, { fileId: fileId!, prompt: prompt!, telegramId });
        console.log(`💾 Saved file_id and prompt for payment ${paymentId}`);
      }
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async generatePaymentUrl(paymentId: string, amount: number, telegramId?: number, metadata?: any): Promise<string> {
    try {
      console.log('Generating payment URL for:', paymentId, amount);
      
      // Проверяем наличие настроек для ЮKassa API
      const shopId = process.env.YOOMONEY_SHOP_ID;
      const secretKey = process.env.YOOMONEY_SECRET_KEY;
      
      if (shopId && secretKey) {
        // Используем ЮKassa API с Basic Auth
        return await this.createCheckoutPayment(paymentId, amount, shopId, secretKey, telegramId, metadata);
      } else {
        throw new Error('Не настроены YOOMONEY_SHOP_ID и YOOMONEY_SECRET_KEY. Для работы с ЮKassa необходимо указать оба параметра.');
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw error;
    }
  }

  async generateGenerationPurchaseUrl(paymentId: string, amount: number, generationsCount: number, telegramId: number, fileId?: string, prompt?: string): Promise<string> {
    const metadata: any = {
      purchase_type: 'generations',
      generations_count: generationsCount.toString()
    };
    
    // Добавляем fileId и prompt для автоматической обработки после оплаты
    if (fileId) {
      metadata.file_id = fileId;
    }
    if (prompt) {
      metadata.prompt = prompt;
    }
    
    return await this.generatePaymentUrl(paymentId, amount, telegramId, metadata);
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

  private async createCheckoutPayment(paymentId: string, amount: number, shopId: string, secretKey: string, telegramId?: number, metadata?: any): Promise<string> {
    try {
      // Преобразуем amount в число (может быть строкой или Decimal из БД)
      const numericAmount = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
      
      if (isNaN(numericAmount)) {
        throw new Error(`Неверное значение суммы: ${amount}`);
      }
      
      // Создаем платеж через ЮKassa API с Basic Auth
      // Формируем Basic Auth: base64(shopId:secretKey)
      const authString = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
      
      // Получаем данные пользователя для чека
      // ЮKassa требует email или телефон покупателя для чека
      let customerEmail: string | undefined;
      const dbClient = await pool.connect();
      
      try {
        // Получаем user_id из платежа
        const paymentResult = await dbClient.query(
          'SELECT user_id FROM payments WHERE id = $1',
          [paymentId]
        );
        
        if (paymentResult.rows[0]?.user_id) {
          // Получаем email пользователя (если указан) или telegram_id для fallback
          const userResult = await dbClient.query(
            'SELECT email, telegram_id FROM users WHERE id = $1',
            [paymentResult.rows[0].user_id]
          );
          
          if (userResult.rows[0]) {
            // Используем реальный email если он есть, иначе создаем сгенерированный
            if (userResult.rows[0].email) {
              customerEmail = userResult.rows[0].email;
            } else if (userResult.rows[0].telegram_id) {
              // Fallback: создаем email на основе telegram_id
              customerEmail = `user_${userResult.rows[0].telegram_id}@telegram.local`;
            }
          }
        } else if (telegramId) {
          // Fallback для тестовых платежей: получаем email пользователя по telegram_id
          const userResult = await dbClient.query(
            'SELECT email FROM users WHERE telegram_id = $1',
            [telegramId]
          );
          
          if (userResult.rows[0]?.email) {
            customerEmail = userResult.rows[0].email;
          } else {
            // Используем сгенерированный email
            customerEmail = `user_${telegramId}@telegram.local`;
          }
        }
      } finally {
        dbClient.release();
      }

      // Формируем чек для продакшена (требование 54-ФЗ)
      // tax_system_code: 1 - УСН "доходы", 2 - УСН "доходы-расходы", 3 - ОСН, 4 - ЕНВД, 5 - ПСН, 6 - НПД
      // vat_code: 1 - без НДС, 2 - НДС 0%, 3 - НДС 10%, 4 - НДС 20%, 5 - НДС расч. 10/110, 6 - НДС расч. 20/120, 7 - НДС 5%, 8 - НДС 7%
      const taxSystemCode = parseInt(process.env.YOOKASSA_TAX_SYSTEM_CODE || '1', 10);
      const vatCode = parseInt(process.env.YOOKASSA_VAT_CODE || '1', 10);
      
      // Определяем описание для чека в зависимости от типа покупки
      let receiptDescription = `Обработка фото и создание анимации`;
      if (metadata?.purchase_type === 'generations') {
        const generationsCount = metadata?.generations_count || '0';
        receiptDescription = `Покупка ${generationsCount} ${this.getGenerationWord(parseInt(generationsCount))}`;
      }
      
      const receipt: any = {
        items: [
          {
            description: receiptDescription,
            quantity: '1.00',
            amount: {
              value: numericAmount.toFixed(2),
              currency: 'RUB'
            },
            vat_code: vatCode,
            payment_subject: 'service', // Предмет расчета: услуга (обязательно для продакшена)
            payment_mode: 'full_prepayment' // Способ расчета: полная предоплата (обязательно для продакшена)
          }
        ],
        tax_system_code: taxSystemCode
      };
      
      // Добавляем информацию о покупателе (обязательно для продакшена)
      if (customerEmail) {
        receipt.customer = {
          email: customerEmail
        };
      }

      const response = await axios.post(
        'https://api.yookassa.ru/v3/payments',
        {
          amount: {
            value: numericAmount.toFixed(2),
            currency: 'RUB'
          },
          confirmation: {
            type: 'redirect',
            return_url: process.env.YOOMONEY_SUCCESS_URL || `https://t.me/${process.env.TELEGRAM_BOT_TOKEN?.split(':')[0]}`
          },
          description: metadata?.purchase_type === 'generations' 
            ? `Покупка генераций ${metadata?.generations_count || ''} шт`
            : `Оплата заказа ${paymentId}`,
          receipt: receipt,
          metadata: {
            payment_id: paymentId,
            order_id: paymentId,
            ...(metadata || {})
          },
          capture: true
        },
        {
          headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/json',
            'Idempotence-Key': paymentId
          }
        }
      );

      const yookassaPaymentId = response.data.id;
      const confirmationUrl = response.data.confirmation?.confirmation_url;
      
      if (!confirmationUrl) {
        throw new Error('ЮKassa не вернул confirmation_url в ответе');
      }
      
      // Сохраняем payment_id от ЮKassa в базу данных
      const client = await pool.connect();
      try {
        await client.query(
          'UPDATE payments SET yoomoney_payment_id = $1 WHERE id = $2',
          [yookassaPaymentId, paymentId]
        );
      } finally {
        client.release();
      }

      console.log('Generated ЮKassa payment URL:', confirmationUrl);
      return confirmationUrl;
      
    } catch (error: any) {
      console.error('Error creating ЮKassa payment:', error.response?.data || error.message);
      if (error.response?.data) {
        console.error('ЮKassa API error details:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`Ошибка создания платежа в ЮKassa: ${error.response?.data?.description || error.message}`);
    }
  }

  async updatePaymentStatus(paymentId: string, status: PaymentStatus, yoomoneyId?: string): Promise<void> {
    const client = await pool.connect();
    try {
      if (yoomoneyId) {
        // Обновляем и статус, и yoomoney_payment_id
      await client.query(
          'UPDATE payments SET status = $1, yoomoney_payment_id = $2, updated_at = NOW() WHERE id = $3',
        [status, yoomoneyId, paymentId]
      );
      } else {
        // Обновляем только статус
        await client.query(
          'UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2',
          [status, paymentId]
        );
      }
    } finally {
      client.release();
    }
  }

  async verifyPayment(paymentId: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT status FROM payments WHERE id = $1',
        [paymentId]
      );
      return result.rows[0]?.status === PaymentStatus.SUCCESS;
    } finally {
      client.release();
    }
  }

  async getPaymentByYooMoneyId(yoomoneyPaymentId: string): Promise<any | null> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM payments WHERE yoomoney_payment_id = $1',
        [yoomoneyPaymentId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getPaymentByMetadata(metadataPaymentId: string): Promise<any | null> {
    const client = await pool.connect();
    try {
      // Ищем по id платежа (который мы передаем в metadata.payment_id)
      const result = await client.query(
        'SELECT * FROM payments WHERE id = $1',
        [metadataPaymentId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async handlePaymentWebhook(paymentId: string, status: PaymentStatus, yoomoneyId?: string, metadata?: any): Promise<void> {
    await this.updatePaymentStatus(paymentId, status, yoomoneyId);
    
    // Если платеж успешный, запускаем обработку заказа и обновляем статистику
    if (status === PaymentStatus.SUCCESS) {
      try {
        // Получаем информацию о платеже
        const client = await pool.connect();
        try {
          const paymentResult = await client.query(
            'SELECT order_id, user_id FROM payments WHERE id = $1',
            [paymentId]
          );
          
          if (!paymentResult.rows[0]) {
            console.error(`Payment ${paymentId} not found`);
            return;
          }
          
          const orderId = paymentResult.rows[0].order_id;
          const userId = paymentResult.rows[0].user_id;
          
          // Получаем информацию о пользователе
          const userResult = await client.query(`
            SELECT u.telegram_id, u.start_param 
            FROM users u
            WHERE u.id = $1
          `, [userId]);
          
          const user = userResult.rows[0];
          
          if (!user) {
            console.error(`User not found for payment ${paymentId}`);
            return;
          }
          
          // Проверяем, является ли это покупкой генераций (проверяем metadata и отсутствие order_id)
          console.log('📦 Checking if payment is generation purchase...');
          console.log('   Metadata:', JSON.stringify(metadata, null, 2));
          console.log('   Payment order_id:', orderId);
          
          const hasGenerationMetadata = metadata?.generations_count || metadata?.purchase_type === 'generations';
          const isGenerationPurchase = !orderId && hasGenerationMetadata;
          
          if (isGenerationPurchase) {
            console.log('✅ This is a generation purchase!');
            const generationsCount = parseInt(metadata?.generations_count || '0', 10);
            
            if (generationsCount > 0) {
              const { UserService } = await import('./user');
              const userService = new UserService();
              
              console.log(`➕ Adding ${generationsCount} generations to user ${user.telegram_id}`);
              await userService.addGenerations(user.telegram_id, generationsCount);
              
              const newBalance = await userService.getUserGenerations(user.telegram_id);
              console.log(`✅ New balance: ${newBalance} generations`);
              
              await this.bot.telegram.sendMessage(
                user.telegram_id,
                `✅ Оживления успешно пополнены!\n\n➕ Начислено: ${generationsCount} ${this.getGenerationWord(generationsCount)}\n💼 Ваш баланс: ${newBalance} оживлений фото`
              );
              
              // Проверяем, нужно ли автоматически обработать фото после покупки
              // Получаем file_id и prompt из metadata (они передаются через ЮKassa)
              // или из глобального хранилища (если metadata не вернула данные)
              let fileId = metadata?.file_id;
              let prompt = metadata?.prompt;
              
              // Обновляем статистику кампании после покупки генераций (после получения fileId/prompt, чтобы не блокировать автообработку)
              if (user.start_param) {
                try {
                  const { AnalyticsService } = await import('./analytics');
                  const analyticsService = new AnalyticsService();
                  await analyticsService.updateCampaignStats(user.start_param);
                } catch (error) {
                  console.error('Error updating campaign stats after generation purchase:', error);
                  // Не блокируем автообработку при ошибке обновления статистики
                }
              }
              
              // Если в metadata нет, пытаемся получить из глобального хранилища
              if ((!fileId || !prompt) && typeof (global as any).pendingGenerationPurchases !== 'undefined') {
                const pendingData = (global as any).pendingGenerationPurchases.get(paymentId);
                if (pendingData && pendingData.telegramId === user.telegram_id) {
                  if (!fileId) fileId = pendingData.fileId;
                  if (!prompt) prompt = pendingData.prompt;
                  console.log('📋 Retrieved file_id and prompt from global storage');
                }
              }
              
              console.log('🔍 Checking for auto-processing:', {
                hasFileId: !!fileId,
                hasPrompt: !!prompt,
                metadataKeys: Object.keys(metadata || {}),
                fileIdPreview: fileId?.substring(0, 30) || 'none',
                promptPreview: prompt?.substring(0, 30) || 'none'
              });
              
              if (fileId && prompt) {
                console.log('🔄 Auto-processing photo after generation purchase...');
                console.log('   File ID:', fileId);
                console.log('   Prompt:', prompt);
                
                try {
                  const { TelegramService } = await import('./telegram');
                  const telegramService = new TelegramService();
                  
                  // Получаем user object для processPrompt
                  const userForProcessing = await client.query(
                    'SELECT * FROM users WHERE id = $1',
                    [userId]
                  );
                  
                  if (userForProcessing.rows[0]) {
                    // Импортируем FileService для загрузки файла
                    const { FileService } = await import('./file');
                    const fileService = new FileService();
                    
                    // Загружаем файл из Telegram в S3
                    const s3Url = await fileService.downloadTelegramFileToS3(fileId);
                    
                    // Обрабатываем промпт (используем ту же логику что и в TelegramService)
                    let processedPrompt = (prompt as string).toLowerCase().trim();
                    if (processedPrompt === 'пропустить' || processedPrompt === 'skip') {
                      processedPrompt = 'everyone in the photo is waving hand, subtle movements and breathing effect';
                    } else {
                      // Переводим русский промпт на английский
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
                        'пьет': 'drinking',
                        'бежит': 'running'
                      };
                      
                      let translatedPrompt = translations[processedPrompt] || processedPrompt;
                      translatedPrompt = translatedPrompt.replace(/^animate this image with\s*/i, '');
                      processedPrompt = `animate this image with ${translatedPrompt}`;
                    }
                    
                    // Создаем заказ
                    const { OrderService } = await import('./order');
                    const orderService = new OrderService();
                    const order = await orderService.createOrder(userId, s3Url, processedPrompt);
                    await orderService.updateOrderStatus(order.id, 'processing' as any);
                    
                    // Запускаем обработку
                    const { ProcessorService } = await import('./processor');
                    const processorService = new ProcessorService();
                    await processorService.processOrder(order.id);
                    
                    await this.bot.telegram.sendMessage(
                      user.telegram_id,
                      `🎬 Начинаю обработку вашего фото...\n\n⏳ Это займет 2-5 минут.`
                    );
                    
                    // Удаляем из глобального хранилища после успешной обработки
                    if (typeof (global as any).pendingGenerationPurchases !== 'undefined') {
                      (global as any).pendingGenerationPurchases.delete(paymentId);
                      console.log('✅ Removed payment from global storage after successful processing');
                    }
                    
                    // Проверяем, нужно ли автоматически обработать объединение и оживление
                    if (typeof (global as any).pendingCombineAndAnimatePurchases !== 'undefined') {
                      const combineData = (global as any).pendingCombineAndAnimatePurchases.get(paymentId);
                      if (combineData && combineData.telegramId === user.telegram_id) {
                        console.log('🔄 Auto-processing combine and animate after generation purchase...');
                        console.log('   Photos count:', combineData.photos?.length);
                        console.log('   Animation prompt:', combineData.state?.animationPrompt);
                        
                        try {
                          const { FileService } = await import('./file');
                          const fileService = new FileService();
                          
                          // Загружаем все фото в S3
                          const photoUrls: string[] = [];
                          for (const fileId of combineData.photos) {
                            const s3Url = await fileService.downloadTelegramFileToS3(fileId, true);
                            photoUrls.push(s3Url);
                          }
                          
                          // Формируем промпты
                          const combinePrompt = 'combine two reference images into one modern scene, drawing a new scene from scratch to create a cohesive common frame, merge the people from both images naturally into one composition';
                          
                          let animationPrompt = combineData.state?.animationPrompt || 'everyone in the photo is waving hand, subtle movements and breathing effect';
                          
                          // Переводим русский промпт на английский
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
                            'пьет': 'drinking',
                            'бежит': 'running'
                          };
                          
                          let processedPrompt = animationPrompt.toLowerCase().trim();
                          if (processedPrompt !== 'пропустить' && processedPrompt !== 'skip') {
                            let translatedPrompt = translations[processedPrompt] || processedPrompt;
                            translatedPrompt = translatedPrompt.replace(/^animate this image with\s*/i, '');
                            animationPrompt = `animate this image with ${translatedPrompt}`;
                          } else {
                            animationPrompt = 'everyone in the photo is waving hand, subtle movements and breathing effect';
                          }
                          
                          // Создаем заказ
                          const { OrderService } = await import('./order');
                          const { OrderStatus } = await import('../types');
                          const orderService = new OrderService();
                          // Сохраняем оригинальный промпт до перевода
                          const originalAnimationPrompt = combineData.state?.animationPrompt || animationPrompt;
                          const order = await orderService.createCombineAndAnimateOrder(
                            userId,
                            photoUrls,
                            combinePrompt,
                            animationPrompt,
                            OrderStatus.PROCESSING,
                            originalAnimationPrompt // Передаем оригинальный промпт для сохранения в custom_prompt
                          );
                          
                          // Запускаем обработку
                          const { ProcessorService } = await import('./processor');
                          const processorService = new ProcessorService();
                          await processorService.processOrder(order.id);
                          
                          await this.bot.telegram.sendMessage(
                            user.telegram_id,
                            `🔀 Объединяю фото и готовлю видео...\n\n🎬 Начинаю обработку...\n\n⏳ Это займет до 5 минут.`
                          );
                          
                          // Удаляем из глобального хранилища после успешной обработки
                          (global as any).pendingCombineAndAnimatePurchases.delete(paymentId);
                          console.log('✅ Removed combine_and_animate payment from global storage after successful processing');
                        } catch (error) {
                          console.error('Error auto-processing combine and animate after payment:', error);
                          // Не блокируем основной процесс при ошибке
                        }
                      }
                    }
                    
                    // Также удаляем из TelegramService pendingPromptsData
                    try {
                      const { TelegramService } = await import('./telegram');
                      const telegramService = new (TelegramService as any)();
                      if ((telegramService as any).pendingPromptsData) {
                        (telegramService as any).pendingPromptsData.delete(user.telegram_id);
                        (telegramService as any).pendingPrompts.delete(user.telegram_id);
                      }
                    } catch (e) {
                      console.log('⚠️ Could not clean TelegramService data:', e);
                    }
                  }
                } catch (error) {
                  console.error('Error auto-processing photo after generation purchase:', error);
                  // Не блокируем успешную покупку генераций, если обработка фото не удалась
                }
              } else {
                console.log('⚠️ Auto-processing skipped: file_id or prompt missing');
                console.log('   Metadata:', JSON.stringify(metadata || {}, null, 2));
              }
            } else {
              console.log('⚠️ Generations count is 0 or not found in metadata');
              await this.bot.telegram.sendMessage(
                user.telegram_id,
                '✅ Тестовая оплата успешно получена!\n\n🎉 Интеграция с ЮKassa работает корректно.'
              );
            }
            return;
          }
          
          // Если есть order_id, это обычный платеж за заказ
          if (orderId) {
            // Отправляем уведомление об успешной оплате
            try {
              await this.bot.telegram.sendMessage(
                user.telegram_id,
                '✅ Оплата успешно получена!\n\n🎬 Начинаю обработку вашего фото...\n\n⏳ Это займет 2-5 минут.'
              );
            } catch (error) {
              console.error(`Error sending payment success notification to user ${user.telegram_id}:`, error);
            }
            
            // Обновляем статус заказа на processing для запуска обработки
            const { OrderService } = await import('./order');
            const orderService = new OrderService();
            await orderService.updateOrderStatus(orderId, 'processing' as any);
            
            // Запускаем обработку заказа
            const { ProcessorService } = await import('./processor');
            const processorService = new ProcessorService();
            await processorService.processOrder(orderId);
            
            // Обновляем статистику кампании
            if (user.start_param) {
              const { AnalyticsService } = await import('./analytics');
              const analyticsService = new AnalyticsService();
              await analyticsService.updateCampaignStats(user.start_param);
            }
          }
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error handling payment webhook:', error);
      }
    }
  }
}