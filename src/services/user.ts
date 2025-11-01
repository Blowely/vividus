import pool from '../config/database';
import { User } from '../types';

export class UserService {
  async getOrCreateUser(telegramUser: any, startParam?: string): Promise<User> {
    const client = await pool.connect();
    
    try {
      // Try to find existing user
      const existingUser = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [telegramUser.id]
      );
      
      if (existingUser.rows.length > 0) {
        // Update start_param if provided and not already set
        if (startParam && !existingUser.rows[0].start_param) {
          await client.query(
            'UPDATE users SET start_param = $1 WHERE telegram_id = $2',
            [startParam, telegramUser.id]
          );
          existingUser.rows[0].start_param = startParam;
        }
        return existingUser.rows[0];
      }
      
      // Create new user
      const newUser = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name, start_param) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING *`,
        [
          telegramUser.id,
          telegramUser.username,
          telegramUser.first_name,
          telegramUser.last_name,
          startParam || null
        ]
      );
      
      return newUser.rows[0];
      
    } finally {
      client.release();
    }
  }
  
  async getUserById(id: number): Promise<User | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM users WHERE id = $1', [id]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }
  
  async getUserByTelegramId(telegramId: number): Promise<User | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async updateUserEmail(telegramId: number, email: string | null): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $2',
        [email, telegramId]
      );
    } finally {
      client.release();
    }
  }

  async getUserGenerations(telegramId: number): Promise<number> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT generations FROM users WHERE telegram_id = $1',
        [telegramId]
      );
      return result.rows[0]?.generations || 0;
    } finally {
      client.release();
    }
  }

  async addGenerations(telegramId: number, amount: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE users SET generations = generations + $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $2',
        [amount, telegramId]
      );
    } finally {
      client.release();
    }
  }

  async deductGenerations(telegramId: number, amount: number): Promise<boolean> {
    const client = await pool.connect();
    
    try {
      // Проверяем баланс и списываем атомарно
      const result = await client.query(
        `UPDATE users 
         SET generations = generations - $1, updated_at = CURRENT_TIMESTAMP 
         WHERE telegram_id = $2 AND generations >= $1
         RETURNING generations`,
        [amount, telegramId]
      );
      
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  async returnGenerations(telegramId: number, amount: number): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE users SET generations = generations + $1, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $2',
        [amount, telegramId]
      );
    } finally {
      client.release();
    }
  }
}
