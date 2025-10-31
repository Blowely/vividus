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

  async generatePaymentUrl(paymentId: string, amount: number): Promise<string> {
    try {
      console.log('Generating payment URL for:', paymentId, amount);
      
      // Проверяем, есть ли доступ к YooMoney Checkout API
      const accessToken = process.env.YOOMONEY_ACCESS_TOKEN;
      const shopId = process.env.YOOMONEY_SHOP_ID || process.env.YOOMONEY_RECEIVER_ID;
      
      if (accessToken && shopId) {
        // Используем YooMoney Checkout API
        return await this.createCheckoutPayment(paymentId, amount, accessToken, shopId);
      } else {
        // Используем старый способ - простая ссылка на перевод
        const receiverId = process.env.YOOMONEY_RECEIVER_ID!;
        
        if (receiverId && receiverId.startsWith('4100')) {
          const url = `https://yoomoney.ru/to/${receiverId}?sum=${amount}&label=${paymentId}`;
          console.log('Generated transfer URL:', url);
          return url;
        } else {
          throw new Error('Не настроен YOOMONEY_RECEIVER_ID или YOOMONEY_ACCESS_TOKEN');
        }
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw new Error('Failed to generate payment URL');
    }
  }

  private async createCheckoutPayment(paymentId: string, amount: number, accessToken: string, shopId: string): Promise<string> {
    try {
      // Создаем платеж через YooMoney Checkout API
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
            payment_id: paymentId
          },
          capture: true,
          merchant_customer_id: shopId
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Idempotence-Key': paymentId
          }
        }
      );

      const yoomoneyOrderId = response.data.id;
      
      // Сохраняем orderId от YooMoney в базу данных
      const client = await pool.connect();
      try {
        await client.query(
          'UPDATE payments SET yoomoney_payment_id = $1 WHERE id = $2',
          [yoomoneyOrderId, paymentId]
        );
      } finally {
        client.release();
      }

      // Формируем ссылку на оплату
      // YooMoney API возвращает confirmation_url в формате для Checkout
      let paymentUrl = response.data.confirmation?.confirmation_url;
      
      // Если нет confirmation_url, формируем ссылку вручную
      if (!paymentUrl) {
        paymentUrl = `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${yoomoneyOrderId}`;
      }
      
      console.log('Generated Checkout API URL:', paymentUrl);
      return paymentUrl;
      
    } catch (error: any) {
      console.error('Error creating Checkout payment:', error.response?.data || error.message);
      
      // Если Checkout API недоступен, используем резервный способ
      const receiverId = process.env.YOOMONEY_RECEIVER_ID;
      if (receiverId && receiverId.startsWith('4100')) {
        console.log('Fallback to transfer URL');
        return `https://yoomoney.ru/to/${receiverId}?sum=${amount}&label=${paymentId}`;
      }
      
      throw new Error('Failed to create Checkout payment');
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

  async handlePaymentWebhook(paymentId: string, status: PaymentStatus): Promise<void> {
    await this.updatePaymentStatus(paymentId, status);
    
    // Если платеж успешный, обновляем статистику кампании
    if (status === PaymentStatus.SUCCESS) {
      try {
        const { AnalyticsService } = await import('./analytics');
        const analyticsService = new AnalyticsService();
        
        // Получаем информацию о пользователе через платеж и заказ
        const client = await pool.connect();
        try {
          const result = await client.query(`
            SELECT u.start_param 
            FROM payments p
            JOIN orders o ON p.order_id = o.id
            JOIN users u ON o.user_id = u.id
            WHERE p.id = $1
          `, [paymentId]);
          
          if (result.rows[0]?.start_param) {
            await analyticsService.updateCampaignStats(result.rows[0].start_param);
          }
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error updating campaign stats:', error);
      }
    }
  }
}