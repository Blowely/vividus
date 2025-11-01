import pool from '../config/database';
import { PaymentStatus } from '../types';
import { config } from 'dotenv';
import axios from 'axios';
import { Telegraf } from 'telegraf';

config();

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

  async generatePaymentUrl(paymentId: string, amount: number, telegramId?: number): Promise<string> {
    try {
      console.log('Generating payment URL for:', paymentId, amount);
      
      // Проверяем наличие настроек для ЮKassa API
      const shopId = process.env.YOOMONEY_SHOP_ID;
      const secretKey = process.env.YOOMONEY_SECRET_KEY;
      
      if (shopId && secretKey) {
        // Используем ЮKassa API с Basic Auth
        return await this.createCheckoutPayment(paymentId, amount, shopId, secretKey, telegramId);
      } else {
        throw new Error('Не настроены YOOMONEY_SHOP_ID и YOOMONEY_SECRET_KEY. Для работы с ЮKassa необходимо указать оба параметра.');
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw error;
    }
  }

  private async createCheckoutPayment(paymentId: string, amount: number, shopId: string, secretKey: string, telegramId?: number): Promise<string> {
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
      
      const receipt: any = {
        items: [
          {
            description: `Обработка фото и создание анимации`,
            quantity: '1.00',
            amount: {
              value: numericAmount.toFixed(2),
              currency: 'RUB'
            },
            vat_code: vatCode,
            payment_subject: 'service' // Предмет расчета: услуга (обязательно для продакшена)
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
          description: `Оплата заказа ${paymentId}`,
          receipt: receipt,
          metadata: {
            payment_id: paymentId,
            order_id: paymentId
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
        // Получаем информацию о заказе
        const client = await pool.connect();
        try {
          const paymentResult = await client.query(
            'SELECT order_id FROM payments WHERE id = $1',
            [paymentId]
          );
          
          if (paymentResult.rows[0]) {
            const orderId = paymentResult.rows[0].order_id;
            
          // Для тестовых платежей (без order_id) находим пользователя через user_id в платеже
          if (!orderId) {
            console.log(`✅ Test payment ${paymentId} succeeded (no order_id)`);
            
            // Получаем user_id из платежа и находим telegram_id
            const paymentWithUser = await client.query(`
              SELECT p.user_id, u.telegram_id 
              FROM payments p
              LEFT JOIN users u ON p.user_id = u.id
              WHERE p.id = $1
            `, [paymentId]);
            
            const userData = paymentWithUser.rows[0];
            
            if (userData?.telegram_id) {
              try {
                await this.bot.telegram.sendMessage(
                  userData.telegram_id,
                  '✅ Тестовая оплата успешно получена!\n\n🎉 Интеграция с ЮKassa работает корректно.'
                );
                console.log(`✅ Notification sent to test payment user ${userData.telegram_id}`);
              } catch (error) {
                console.error(`Error sending test payment notification to user ${userData.telegram_id}:`, error);
              }
            } else {
              // Fallback: пытаемся получить telegram_id из metadata (для старых платежей)
              const telegramId = metadata?.telegram_id;
              if (telegramId) {
                try {
                  const telegramIdNum = parseInt(telegramId, 10);
                  await this.bot.telegram.sendMessage(
                    telegramIdNum,
                    '✅ Тестовая оплата успешно получена!\n\n🎉 Интеграция с ЮKassa работает корректно.'
                  );
                  console.log(`✅ Notification sent to test payment user ${telegramIdNum} (from metadata)`);
                } catch (error) {
                  console.error(`Error sending test payment notification:`, error);
                }
              } else {
                console.log(`⚠️ Test payment ${paymentId} succeeded but no user_id or telegram_id found`);
              }
            }
            return;
          }
            
            // Получаем информацию о пользователе для отправки уведомления
            // Используем user_id напрямую из payments (идеальная архитектура)
            const userResult = await client.query(`
              SELECT u.telegram_id, u.start_param 
              FROM payments p
              JOIN users u ON p.user_id = u.id
              WHERE p.id = $1
            `, [paymentId]);
            
            const user = userResult.rows[0];
            
            if (user) {
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