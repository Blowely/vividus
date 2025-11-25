import pool from '../config/database';
import { Order, OrderStatus } from '../types';

export class OrderService {
  async createOrder(userId: number, filePath: string, customPrompt?: string): Promise<Order> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO orders (user_id, original_file_path, status, custom_prompt, order_type) 
         VALUES ($1, $2, $3, $4, 'single') 
         RETURNING *`,
        [userId, filePath, OrderStatus.PAYMENT_REQUIRED, customPrompt]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async createMergeOrder(userId: number, firstFilePath: string, secondFilePath: string, customPrompt?: string): Promise<Order> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO orders (user_id, original_file_path, second_file_path, status, custom_prompt, order_type) 
         VALUES ($1, $2, $3, $4, $5, 'merge') 
         RETURNING *`,
        [userId, firstFilePath, secondFilePath, OrderStatus.PAYMENT_REQUIRED, customPrompt]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }
  
  async createCombineAndAnimateOrder(
    userId: number, 
    referenceImages: string[], 
    combinePrompt?: string, 
    animationPrompt?: string,
    status: OrderStatus = OrderStatus.PAYMENT_REQUIRED
  ): Promise<Order> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO orders (
          user_id, original_file_path, status, order_type, 
          combine_prompt, animation_prompt, reference_images
        ) 
         VALUES ($1, $2, $3, 'combine_and_animate', $4, $5, $6) 
         RETURNING *`,
        [
          userId, 
          referenceImages[0] || '', // Первое фото как original_file_path для совместимости
          status, 
          combinePrompt,
          animationPrompt,
          JSON.stringify(referenceImages)
        ]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async createAnimateV2Order(userId: number, filePath: string, customPrompt?: string): Promise<Order> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO orders (user_id, original_file_path, status, custom_prompt, order_type) 
         VALUES ($1, $2, $3, $4, 'animate_v2') 
         RETURNING *`,
        [userId, filePath, OrderStatus.PAYMENT_REQUIRED, customPrompt]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async updateOrderCombinedImage(orderId: string, combinedImagePath: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `UPDATE orders 
         SET combined_image_path = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [combinedImagePath, orderId]
      );
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
  
  async updateOrderResult(orderId: string, didJobId?: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        `UPDATE orders 
         SET did_job_id = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [didJobId, orderId]
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

  async hasPayment(orderId: string): Promise<boolean> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT COUNT(*) as count FROM payments WHERE order_id = $1',
        [orderId]
      );
      
      return parseInt(result.rows[0].count) > 0;
    } finally {
      client.release();
    }
  }
}
