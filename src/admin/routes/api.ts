import express from 'express';
import pool from '../../config/database';

const router = express.Router();

// Получить всех пользователей
router.get('/users', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;
      const search = req.query.search as string;

      let query = 'SELECT * FROM users';
      const params: any[] = [];
      
      if (search) {
        query += ' WHERE username ILIKE $1 OR first_name ILIKE $1 OR telegram_id::text LIKE $1';
        params.push(`%${search}%`);
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
      } else {
        query += ` ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
        params.push(limit, offset);
      }

      const result = await client.query(query, params);
      
      // Получаем общее количество
      const countQuery = search 
        ? 'SELECT COUNT(*) FROM users WHERE username ILIKE $1 OR first_name ILIKE $1 OR telegram_id::text LIKE $1'
        : 'SELECT COUNT(*) FROM users';
      const countResult = await client.query(
        search ? countQuery : countQuery,
        search ? [`%${search}%`] : []
      );

      res.json({
        users: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить конкретного пользователя
router.get('/users/:id', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Обновить количество генераций у пользователя
router.patch('/users/:id/generations', async (req, res) => {
  try {
    const { generations } = req.body;
    
    if (typeof generations !== 'number') {
      return res.status(400).json({ error: 'Generations must be a number' });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        'UPDATE users SET generations = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [generations, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error updating generations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Удалить пользователя
router.delete('/users/:id', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('DELETE FROM users WHERE id = $1 RETURNING *', [req.params.id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ message: 'User deleted successfully', user: result.rows[0] });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить все заказы
router.get('/orders', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;
      const userId = req.query.user_id as string;

      let query = `
        SELECT 
          o.*,
          u.telegram_id,
          u.username,
          u.first_name,
          u.last_name
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
      `;
      const params: any[] = [];

      if (userId) {
        query += ' WHERE o.user_id = $1';
        params.push(userId);
        query += ` ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
      } else {
        query += ` ORDER BY o.created_at DESC LIMIT $1 OFFSET $2`;
        params.push(limit, offset);
      }

      const result = await client.query(query, params);

      // Получаем общее количество
      const countQuery = userId 
        ? 'SELECT COUNT(*) FROM orders WHERE user_id = $1'
        : 'SELECT COUNT(*) FROM orders';
      const countResult = await client.query(
        countQuery,
        userId ? [userId] : []
      );

      res.json({
        orders: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить все платежи
router.get('/payments', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;
      const userId = req.query.user_id as string;

      let query = `
        SELECT 
          p.*,
          u.telegram_id,
          u.username,
          u.first_name,
          u.last_name,
          o.status as order_status
        FROM payments p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN orders o ON p.order_id = o.id
      `;
      const params: any[] = [];

      if (userId) {
        query += ' WHERE p.user_id = $1';
        params.push(userId);
        query += ` ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
      } else {
        query += ` ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`;
        params.push(limit, offset);
      }

      const result = await client.query(query, params);

      // Получаем общее количество
      const countQuery = userId 
        ? 'SELECT COUNT(*) FROM payments WHERE user_id = $1'
        : 'SELECT COUNT(*) FROM payments';
      const countResult = await client.query(
        countQuery,
        userId ? [userId] : []
      );

      res.json({
        payments: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить все задания генерации
router.get('/did-jobs', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;

      const query = `
        SELECT 
          dj.*,
          o.user_id,
          u.telegram_id,
          u.username,
          u.first_name,
          u.last_name,
          o.original_file_path,
          o.custom_prompt,
          o.status as order_status
        FROM did_jobs dj
        LEFT JOIN orders o ON dj.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY dj.created_at DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await client.query(query, [limit, offset]);

      // Получаем общее количество
      const countResult = await client.query('SELECT COUNT(*) FROM did_jobs');

      res.json({
        jobs: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching did-jobs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить статистику
router.get('/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const stats = await client.query(`
        SELECT 
          (SELECT COUNT(*) FROM users) as total_users,
          (SELECT COUNT(*) FROM orders) as total_orders,
          (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders,
          (SELECT COUNT(*) FROM orders WHERE status = 'failed') as failed_orders,
          (SELECT COUNT(*) FROM payments WHERE status = 'success') as successful_payments,
          (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'success') as total_revenue,
          (SELECT COALESCE(SUM(generations), 0) FROM users) as total_generations,
          (SELECT COUNT(*) FROM did_jobs WHERE status = 'completed') as completed_jobs,
          (SELECT COUNT(*) FROM did_jobs WHERE status = 'failed') as failed_jobs
      `);

      res.json(stats.rows[0]);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить аналитику по кампаниям
router.get('/analytics/campaigns', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          c.name as campaign_name,
          COUNT(DISTINCT cs.id) as stats_count,
          SUM(cs.users_count) as total_users,
          SUM(cs.total_payments_rub) as total_payments_rub,
          SUM(cs.total_payments_stars) as total_payments_stars,
          SUM(cs.completed_orders) as completed_orders,
          CASE 
            WHEN SUM(cs.users_count) > 0 
            THEN ROUND((SUM(cs.completed_orders)::decimal / SUM(cs.users_count)) * 100, 2)
            ELSE 0 
          END as conversion_rate
        FROM campaigns c
        LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
        GROUP BY c.id, c.name
        ORDER BY total_payments_rub DESC NULLS LAST
      `);

      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить историю пользователя
router.get('/users/:id/history', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const userId = req.params.id;

      // Получаем все данные пользователя
      const [user, orders, payments, jobs] = await Promise.all([
        client.query('SELECT * FROM users WHERE id = $1', [userId]),
        client.query(`
          SELECT o.*, dj.status as job_status, dj.result_url, dj.error_message
          FROM orders o
          LEFT JOIN did_jobs dj ON o.id = dj.order_id
          WHERE o.user_id = $1
          ORDER BY o.created_at DESC
        `, [userId]),
        client.query(`
          SELECT p.*, o.status as order_status
          FROM payments p
          LEFT JOIN orders o ON p.order_id = o.id
          WHERE p.user_id = $1
          ORDER BY p.created_at DESC
        `, [userId]),
        client.query(`
          SELECT dj.*, o.original_file_path, o.custom_prompt
          FROM did_jobs dj
          LEFT JOIN orders o ON dj.order_id = o.id
          WHERE o.user_id = $1
          ORDER BY dj.created_at DESC
        `, [userId])
      ]);

      res.json({
        user: user.rows[0] || null,
        orders: orders.rows,
        payments: payments.rows,
        jobs: jobs.rows
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching user history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить логи активности
router.get('/logs', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Проверяем, существует ли таблица activity_logs
      const tableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'activity_logs'
        );
      `);
      
      if (!tableExists.rows[0].exists) {
        return res.json({
          logs: [],
          total: 0,
          page: 1,
          limit: 100,
          message: 'Таблица activity_logs не найдена. Примените миграцию базы данных.'
        });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = (page - 1) * limit;
      const tableName = req.query.table as string;
      const action = req.query.action as string;
      const userSearch = req.query.user as string;

      let query = `SELECT * FROM activity_logs WHERE 1=1`;
      const params: any[] = [];
      let paramCount = 0;

      if (tableName) {
        paramCount++;
        query += ` AND table_name = $${paramCount}`;
        params.push(tableName);
      }

      if (action) {
        paramCount++;
        query += ` AND action = $${paramCount}`;
        params.push(action.toUpperCase());
      }

      // Поиск по пользователю: ищем в JSONB данных по telegram_id, username или user_id
      if (userSearch) {
        paramCount++;
        // Поиск в new_data или old_data по telegram_id, username, user_id
        // Используем ILIKE для частичного совпадения
        query += ` AND (
          (new_data->>'telegram_id')::text ILIKE $${paramCount}
          OR (old_data->>'telegram_id')::text ILIKE $${paramCount}
          OR new_data->>'username' ILIKE $${paramCount}
          OR old_data->>'username' ILIKE $${paramCount}
          OR (new_data->>'user_id')::text ILIKE $${paramCount}
          OR (old_data->>'user_id')::text ILIKE $${paramCount}
        )`;
        params.push(`%${userSearch}%`);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = 'SELECT COUNT(*) FROM activity_logs WHERE 1=1';
      const countParams: any[] = [];
      let countParamCount = 0;

      if (tableName) {
        countParamCount++;
        countQuery += ` AND table_name = $${countParamCount}`;
        countParams.push(tableName);
      }

      if (action) {
        countParamCount++;
        countQuery += ` AND action = $${countParamCount}`;
        countParams.push(action.toUpperCase());
      }

      // Поиск по пользователю для подсчета
      if (userSearch) {
        countParamCount++;
        countQuery += ` AND (
          (new_data->>'telegram_id')::text ILIKE $${countParamCount}
          OR (old_data->>'telegram_id')::text ILIKE $${countParamCount}
          OR new_data->>'username' ILIKE $${countParamCount}
          OR old_data->>'username' ILIKE $${countParamCount}
          OR (new_data->>'user_id')::text ILIKE $${countParamCount}
          OR (old_data->>'user_id')::text ILIKE $${countParamCount}
        )`;
        countParams.push(`%${userSearch}%`);
      }

      const countResult = await client.query(countQuery, countParams);

      res.json({
        logs: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        limit
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error fetching logs:', error);
    // Если таблица не существует, возвращаем понятное сообщение
    if (error.code === '42P01') { // undefined_table
      return res.json({
        logs: [],
        total: 0,
        page: 1,
        limit: 100,
        message: 'Таблица activity_logs не найдена. Примените миграцию базы данных.'
      });
    }
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Получить список доступных таблиц для фильтрации
router.get('/logs/tables', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Проверяем, существует ли таблица activity_logs
      const tableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'activity_logs'
        );
      `);
      
      if (!tableExists.rows[0].exists) {
        return res.json([]);
      }

      const result = await client.query(`
        SELECT DISTINCT table_name 
        FROM activity_logs 
        ORDER BY table_name
      `);
      res.json(result.rows.map(row => row.table_name));
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error fetching log tables:', error);
    // Если таблица не существует, возвращаем пустой массив
    if (error.code === '42P01') { // undefined_table
      return res.json([]);
    }
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

export default router;

