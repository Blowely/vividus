import pool from '../config/database';
import { PaymentStatus } from '../types';
import { config } from 'dotenv';

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
      console.log('Receiver ID:', process.env.YOOMONEY_RECEIVER_ID);
      
      const receiverId = process.env.YOOMONEY_RECEIVER_ID!;
      
      if (receiverId.startsWith('4100')) {
        const url = `https://yoomoney.ru/to/${receiverId}?sum=${amount}&label=${paymentId}`;
        console.log('Generated transfer URL:', url);
        return url;
      } else {
        throw new Error('Client ID requires API setup. Please use wallet number (starts with 4100)');
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw new Error('Failed to generate payment URL');
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