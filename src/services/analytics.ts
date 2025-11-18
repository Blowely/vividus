import pool from '../config/database';
import { Campaign, CampaignStats, CampaignAnalytics } from '../types';

export class AnalyticsService {
  async createCampaign(name: string, description?: string): Promise<Campaign> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        `INSERT INTO campaigns (name, description) 
         VALUES ($1, $2) 
         RETURNING *`,
        [name, description]
      );
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  async getCampaignByName(name: string): Promise<Campaign | null> {
    const client = await pool.connect();
    
    try {
      const result = await client.query(
        'SELECT * FROM campaigns WHERE name = $1',
        [name]
      );
      
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async updateCampaignStats(campaignName: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      // Получаем или создаем кампанию
      let campaign = await this.getCampaignByName(campaignName);
      if (!campaign) {
        campaign = await this.createCampaign(campaignName);
      }

      const today = new Date().toISOString().split('T')[0];

      // Подсчитываем статистику
      // Выручка считается только из успешных платежей (status = 'success')
      // Включаем как платежи за заказы, так и платежи за покупку генераций (без order_id)
      // Используем отдельные подзапросы для избежания дублирования из-за JOIN'ов
      const stats = await client.query(`
        SELECT 
          (SELECT COUNT(DISTINCT id)::INTEGER FROM users WHERE start_param = $1) as users_count,
          (
            SELECT COALESCE(SUM(amount), 0)::DECIMAL(12,2)
            FROM payments
            WHERE status = 'success'
              AND (
                order_id IN (SELECT id FROM orders WHERE user_id IN (SELECT id FROM users WHERE start_param = $1))
                OR (order_id IS NULL AND user_id IN (SELECT id FROM users WHERE start_param = $1))
              )
          ) as total_payments_rub,
          0::INTEGER as total_payments_stars,
          (
            SELECT COUNT(DISTINCT id)::INTEGER
            FROM orders
            WHERE status = 'completed'
              AND user_id IN (SELECT id FROM users WHERE start_param = $1)
          ) as completed_orders
      `, [campaignName]);

      const { users_count, total_payments_rub, total_payments_stars, completed_orders } = stats.rows[0];

      // Обновляем или создаем статистику за сегодня
      await client.query(`
        INSERT INTO campaign_stats (campaign_id, date, users_count, total_payments_rub, total_payments_stars, completed_orders)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (campaign_id, date) 
        DO UPDATE SET 
          users_count = EXCLUDED.users_count,
          total_payments_rub = EXCLUDED.total_payments_rub,
          total_payments_stars = EXCLUDED.total_payments_stars,
          completed_orders = EXCLUDED.completed_orders,
          updated_at = CURRENT_TIMESTAMP
      `, [campaign.id, today, users_count, total_payments_rub, total_payments_stars, completed_orders]);

    } finally {
      client.release();
    }
  }

  async getCampaignAnalytics(campaignName?: string): Promise<CampaignAnalytics[]> {
    const client = await pool.connect();
    
    try {
      // Выручка считается напрямую из таблицы payments с фильтром status = 'success'
      // чтобы избежать проблем со старыми данными в campaign_stats
      let query = `
        SELECT 
          c.name as campaign_name,
          (SELECT COUNT(DISTINCT u.id)::INTEGER 
           FROM users u 
           WHERE u.start_param = c.name) as total_users,
          (
            SELECT COALESCE(SUM(p.amount), 0)::DECIMAL(12,2)
            FROM payments p
            WHERE p.status = 'success'
              AND (
                p.order_id IN (
                  SELECT o.id FROM orders o 
                  INNER JOIN users u ON o.user_id = u.id 
                  WHERE u.start_param = c.name
                )
                OR (p.order_id IS NULL AND p.user_id IN (
                  SELECT u.id FROM users u WHERE u.start_param = c.name
                ))
              )
          ) as total_payments_rub,
          0::INTEGER as total_payments_stars,
          (
            SELECT COUNT(DISTINCT o.id)::INTEGER
            FROM orders o
            INNER JOIN users u ON o.user_id = u.id
            WHERE o.status = 'completed'
              AND u.start_param = c.name
          ) as completed_orders
        FROM campaigns c
        WHERE c.is_deleted = false
      `;

      const params: any[] = [];
      
      if (campaignName) {
        query += ' AND c.name = $1';
        params.push(campaignName);
      }

      query += ' ORDER BY total_payments_rub DESC';

      const result = await client.query(query, params);
      
      return result.rows.map(row => {
        const totalUsers = parseInt(row.total_users) || 0;
        const completedOrders = parseInt(row.completed_orders) || 0;
        const conversionRate = totalUsers > 0 
          ? parseFloat(((completedOrders / totalUsers) * 100).toFixed(2))
          : 0;
        
        return {
          campaign_name: row.campaign_name,
          total_users: totalUsers,
          total_payments_rub: parseFloat(row.total_payments_rub) || 0,
          total_payments_stars: parseInt(row.total_payments_stars) || 0,
          completed_orders: completedOrders,
          conversion_rate: conversionRate
        };
      });
    } finally {
      client.release();
    }
  }

  async getAllCampaigns(): Promise<Campaign[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM campaigns WHERE is_deleted = false ORDER BY created_at DESC');
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getDeletedCampaigns(): Promise<Campaign[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM campaigns WHERE is_deleted = true ORDER BY created_at DESC');
      return result.rows;
    } finally {
      client.release();
    }
  }

  async deleteCampaign(campaignName: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE campaigns SET is_deleted = true WHERE name = $1',
        [campaignName]
      );
    } finally {
      client.release();
    }
  }

  async restoreCampaign(campaignName: string): Promise<void> {
    const client = await pool.connect();
    
    try {
      await client.query(
        'UPDATE campaigns SET is_deleted = false WHERE name = $1',
        [campaignName]
      );
    } finally {
      client.release();
    }
  }

  async getTodayStatsByCampaign(): Promise<Map<string, {
    users: number;
    payments_rub: number;
    payments_stars: number;
    completed_orders: number;
  }>> {
    const client = await pool.connect();
    
    try {
      // Получаем статистику за сегодня (московское время UTC+3)
      // Используем DATE_TRUNC для получения начала дня в московском времени
      const result = await client.query(`
        SELECT 
          c.name as campaign_name,
          (SELECT COUNT(DISTINCT u.id)::INTEGER 
           FROM users u 
           WHERE u.start_param = c.name
             AND (u.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow'))) as users_today,
          (
            SELECT COALESCE(SUM(p.amount), 0)::DECIMAL(12,2)
            FROM payments p
            WHERE p.status = 'success'
              AND (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow'))
              AND (
                p.order_id IN (
                  SELECT o.id FROM orders o 
                  INNER JOIN users u ON o.user_id = u.id 
                  WHERE u.start_param = c.name
                )
                OR (p.order_id IS NULL AND p.user_id IN (
                  SELECT u.id FROM users u WHERE u.start_param = c.name
                ))
              )
          ) as payments_rub_today,
          0::INTEGER as payments_stars_today,
          (
            SELECT COUNT(DISTINCT o.id)::INTEGER
            FROM orders o
            INNER JOIN users u ON o.user_id = u.id
            WHERE o.status = 'completed'
              AND u.start_param = c.name
              AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow'))
          ) as completed_orders_today
        FROM campaigns c
        WHERE c.is_deleted = false
      `);
      
      const statsMap = new Map<string, {
        users: number;
        payments_rub: number;
        payments_stars: number;
        completed_orders: number;
      }>();
      
      for (const row of result.rows) {
        statsMap.set(row.campaign_name, {
          users: parseInt(row.users_today) || 0,
          payments_rub: parseFloat(row.payments_rub_today) || 0,
          payments_stars: parseInt(row.payments_stars_today) || 0,
          completed_orders: parseInt(row.completed_orders_today) || 0
        });
      }
      
      return statsMap;
    } finally {
      client.release();
    }
  }
}
