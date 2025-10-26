import pool from '../config/database';
import { Payment, PaymentStatus } from '../types';
import axios from 'axios';
import { config } from 'dotenv';

config();

export class PaymentService {
  async createPayment(orderId: string, amount: number): Promise<Payment> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO payments (order_id, amount, status) 
         VALUES ($1, $2, $3) 
         RETURNING *`,
        [orderId, amount, PaymentStatus.PENDING]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  async getPayment(paymentId: string): Promise<Payment | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }
  
  async updatePaymentStatus(paymentId: string, status: PaymentStatus, yoomoneyPaymentId?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `UPDATE payments 
         SET status = $1, yoomoney_payment_id = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`,
        [status, yoomoneyPaymentId, paymentId]
      );
    } finally {
      client.release();
    }
  }
  
  async generatePaymentUrl(paymentId: string, amount: number): Promise<string> {
    try {
      console.log('Generating payment URL for:', paymentId, amount);
      console.log('Receiver ID:', process.env.YOOMONEY_RECEIVER_ID);
      
      // Check if receiver ID is a wallet number (starts with 4100) or client ID
      const receiverId = process.env.YOOMONEY_RECEIVER_ID!;
      
      if (receiverId.startsWith('4100')) {
        // Wallet number - use direct transfer
        const params = new URLSearchParams({
          receiver: receiverId,
          sum: amount.toString(),
          label: paymentId,
          quickpay_form: 'donate'
        });
        
        const url = `https://yoomoney.ru/to/${receiverId}?sum=${amount}&label=${paymentId}`;
        console.log('Generated transfer URL:', url);
        return url;
      } else {
        // Client ID - use API (this requires additional setup)
        throw new Error('Client ID requires API setup. Please use wallet number (starts with 4100)');
      }
    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw new Error('Failed to generate payment URL');
    }
  }
  
  async verifyPayment(paymentId: string): Promise<boolean> {
    try {
      // For YooMoney QuickPay, we'll use webhook notifications
      // This method is kept for compatibility but webhook is preferred
      console.log(`Payment verification requested for: ${paymentId}`);
      return true; // Will be updated via webhook
    } catch (error) {
      console.error('Error verifying payment:', error);
      return false;
    }
  }
  
  async handlePaymentWebhook(paymentId: string, yoomoneyPaymentId: string): Promise<void> {
    try {
      // Update payment status
      await this.updatePaymentStatus(paymentId, PaymentStatus.SUCCESS, yoomoneyPaymentId);
      
      // Update order status
      const payment = await this.getPayment(paymentId);
      if (payment) {
        const { OrderService } = await import('./order');
        const orderService = new OrderService();
        await orderService.updateOrderStatus(payment.order_id, 'processing' as any);
      }
    } catch (error) {
      console.error('Error handling payment webhook:', error);
    }
  }
}
