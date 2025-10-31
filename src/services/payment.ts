import pool from '../config/database';
import { PaymentStatus } from '../types';
import { config } from 'dotenv';
import axios from 'axios';

config();

export class PaymentService {
  async createPayment(orderId: string, amount: number): Promise<any> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'INSERT INTO payments (order_id, amount, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [orderId, amount, PaymentStatus.PENDING]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async createTestPayment(amount: number = 109): Promise<any> {
    const client = await pool.connect();
    try {
      // Создаем тестовый платеж без order_id (NULL) для тестирования интеграции
      const result = await client.query(
        'INSERT INTO payments (order_id, amount, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
        [null, amount, PaymentStatus.PENDING]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async generatePaymentUrl(paymentId: string, amount: number): Promise<string> {
    try {
      console.log('Generating payment URL for:', paymentId, amount);
      
      // Проверяем наличие настроек для ЮKassa API
      const shopId = process.env.YOOMONEY_SHOP_ID;
      const secretKey = process.env.YOOMONEY_SECRET_KEY;
      
      if (shopId && secretKey) {
        // Используем ЮKassa API с Basic Auth
        return await this.createCheckoutPayment(paymentId, amount, shopId, secretKey);
      } else {
        throw new Error('Не настроены YOOMONEY_SHOP_ID и YOOMONEY_SECRET_KEY. Для работы с ЮKassa необходимо указать оба параметра.');
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw error;
    }
  }

  private async createCheckoutPayment(paymentId: string, amount: number, shopId: string, secretKey: string): Promise<string> {
    try {
      // Создаем платеж через ЮKassa API с Basic Auth
      // Формируем Basic Auth: base64(shopId:secretKey)
      const authString = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
      
      const response = await axios.post(
        'https://api.yookassa.ru/v3/payments',
        {
          amount: {
            value: amount.toFixed(2),
            currency: 'RUB'
          },
          confirmation: {
            type: 'redirect',
            return_url: process.env.YOOMONEY_SUCCESS_URL || `https://t.me/${process.env.TELEGRAM_BOT_TOKEN?.split(':')[0]}`
          },
          description: `Оплата заказа ${paymentId}`,
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
      await client.query(
        'UPDATE payments SET status = $1, yoomoney_id = $2, updated_at = NOW() WHERE id = $3',
        [status, yoomoneyId, paymentId]
      );
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

  async handlePaymentWebhook(paymentId: string, status: PaymentStatus, yoomoneyId?: string): Promise<void> {
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
            
            // Обновляем статус заказа на processing для запуска обработки
            const { OrderService } = await import('./order');
            const orderService = new OrderService();
            await orderService.updateOrderStatus(orderId, 'processing' as any);
            
            // Запускаем обработку заказа
            const { ProcessorService } = await import('./processor');
            const processorService = new ProcessorService();
            await processorService.processOrder(orderId);
            
            // Обновляем статистику кампании
            const result = await client.query(`
              SELECT u.start_param 
              FROM payments p
              JOIN orders o ON p.order_id = o.id
              JOIN users u ON o.user_id = u.id
              WHERE p.id = $1
            `, [paymentId]);
            
            if (result.rows[0]?.start_param) {
              const { AnalyticsService } = await import('./analytics');
              const analyticsService = new AnalyticsService();
              await analyticsService.updateCampaignStats(result.rows[0].start_param);
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