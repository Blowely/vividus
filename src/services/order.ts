import pool from '../config/database';
import { Order, OrderStatus } from '../types';

export class OrderService {
  async createOrder(userId: number, filePath: string, price: number, customPrompt?: string): Promise<Order> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO orders (user_id, original_file_path, price, status, custom_prompt) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [userId, filePath, price, OrderStatus.PAYMENT_REQUIRED, customPrompt]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  async getOrder(orderId: string): Promise<Order | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }
  
  async getUserOrders(userId: number): Promise<Order[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }
  
  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, orderId]
      );
    } finally {
      client.release();
    }
  }
  
  async updateOrderResult(orderId: string, resultPath: string, didJobId?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `UPDATE orders 
         SET result_file_path = $1, did_job_id = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`,
        [resultPath, didJobId, orderId]
      );
    } finally {
      client.release();
    }
  }
  
  async getOrdersByStatus(status: OrderStatus): Promise<Order[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM orders WHERE status = $1 ORDER BY created_at ASC',
        [status]
      );
      
      return result.rows;
    } finally {
      client.release();
    }
  }
}
