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
      const stats = await client.query(`
        SELECT 
          COUNT(DISTINCT u.id) as users_count,
          COALESCE(SUM(p.amount), 0) as total_payments_rub,
          COALESCE(SUM(CASE WHEN p.status = 'success' THEN p.amount * 7 ELSE 0 END), 0) as total_payments_stars
        FROM users u
        LEFT JOIN orders o ON u.id = o.user_id
        LEFT JOIN payments p ON o.id = p.order_id
        WHERE u.start_param = $1
      `, [campaignName]);

      const { users_count, total_payments_rub, total_payments_stars } = stats.rows[0];

      // Обновляем или создаем статистику за сегодня
      await client.query(`
        INSERT INTO campaign_stats (campaign_id, date, users_count, total_payments_rub, total_payments_stars)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (campaign_id, date) 
        DO UPDATE SET 
          users_count = EXCLUDED.users_count,
          total_payments_rub = EXCLUDED.total_payments_rub,
          total_payments_stars = EXCLUDED.total_payments_stars,
          updated_at = CURRENT_TIMESTAMP
      `, [campaign.id, today, users_count, total_payments_rub, total_payments_stars]);

    } finally {
      client.release();
    }
  }

  async getCampaignAnalytics(campaignName?: string): Promise<CampaignAnalytics[]> {
    const client = await pool.connect();
    
    try {
      let query = `
        SELECT 
          c.name as campaign_name,
          SUM(cs.users_count) as total_users,
          SUM(cs.total_payments_rub) as total_payments_rub,
          SUM(cs.total_payments_stars) as total_payments_stars,
          CASE 
            WHEN SUM(cs.users_count) > 0 
            THEN ROUND((SUM(cs.total_payments_rub) / SUM(cs.users_count)) * 100, 2)
            ELSE 0 
          END as conversion_rate
        FROM campaigns c
        LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
      `;

      const params: any[] = [];
      
      if (campaignName) {
        query += ' WHERE c.name = $1';
        params.push(campaignName);
      }

      query += ' GROUP BY c.id, c.name ORDER BY total_payments_rub DESC';

      const result = await client.query(query, params);
      
      return result.rows.map(row => ({
        campaign_name: row.campaign_name,
        total_users: parseInt(row.total_users) || 0,
        total_payments_rub: parseFloat(row.total_payments_rub) || 0,
        total_payments_stars: parseInt(row.total_payments_stars) || 0,
        conversion_rate: parseFloat(row.conversion_rate) || 0
      }));
    } finally {
      client.release();
    }
  }

  async getAllCampaigns(): Promise<Campaign[]> {
    const client = await pool.connect();
    
    try {
      const result = await client.query('SELECT * FROM campaigns ORDER BY created_at DESC');
      return result.rows;
    } finally {
      client.release();
    }
  }
}
