import pool from '../config/database';
import { User } from '../types';

export class UserService {
  async getOrCreateUser(telegramUser: any): Promise<User> {
    const client = await pool.connect();
    
    try {
      // Try to find existing user
      const existingUser = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [telegramUser.id]
      );
      
      if (existingUser.rows.length > 0) {
        return existingUser.rows[0];
      }
      
      // Create new user
      const newUser = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, last_name) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [
          telegramUser.id,
          telegramUser.username,
          telegramUser.first_name,
          telegramUser.last_name
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
}
