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
      const userSearch = req.query.user as string;

      // Поиск user_id по telegram_id, username или id
      let userId: number | null = null;
      if (userSearch) {
        const userSearchQuery = await client.query(`
          SELECT id FROM users 
          WHERE telegram_id::text ILIKE $1 OR username ILIKE $1 OR id::text = $1
          LIMIT 1
        `, [`%${userSearch}%`]);
        
        if (userSearchQuery.rows.length > 0) {
          userId = userSearchQuery.rows[0].id;
        }
      }

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
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        query += ` WHERE o.user_id = $${paramCount}`;
        params.push(userId);
      } else if (userSearch) {
        // Если пользователь не найден, возвращаем пустой результат
        query += ` WHERE 1=0`;
      }

      query += ` ORDER BY o.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = 'SELECT COUNT(*) FROM orders';
      const countParams: any[] = [];
      
      if (userId !== null) {
        countQuery += ' WHERE user_id = $1';
        countParams.push(userId);
      } else if (userSearch) {
        countQuery += ' WHERE 1=0';
      }
      
      const countResult = await client.query(countQuery, countParams);

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
      const userSearch = req.query.user as string;

      // Поиск user_id по telegram_id, username или id
      let userId: number | null = null;
      if (userSearch) {
        const userSearchQuery = await client.query(`
          SELECT id FROM users 
          WHERE telegram_id::text ILIKE $1 OR username ILIKE $1 OR id::text = $1
          LIMIT 1
        `, [`%${userSearch}%`]);
        
        if (userSearchQuery.rows.length > 0) {
          userId = userSearchQuery.rows[0].id;
        }
      }

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
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        query += ` WHERE p.user_id = $${paramCount}`;
        params.push(userId);
      } else if (userSearch) {
        query += ` WHERE 1=0`;
      }

      query += ` ORDER BY p.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = 'SELECT COUNT(*) FROM payments';
      const countParams: any[] = [];
      
      if (userId !== null) {
        countQuery += ' WHERE user_id = $1';
        countParams.push(userId);
      } else if (userSearch) {
        countQuery += ' WHERE 1=0';
      }
      
      const countResult = await client.query(countQuery, countParams);

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
      const userSearch = req.query.user as string;

      // Поиск user_id по telegram_id, username или id
      let userId: number | null = null;
      if (userSearch) {
        const userSearchQuery = await client.query(`
          SELECT id FROM users 
          WHERE telegram_id::text ILIKE $1 OR username ILIKE $1 OR id::text = $1
          LIMIT 1
        `, [`%${userSearch}%`]);
        
        if (userSearchQuery.rows.length > 0) {
          userId = userSearchQuery.rows[0].id;
        }
      }

      let query = `
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
      `;
      const params: any[] = [];
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        query += ` WHERE o.user_id = $${paramCount}`;
        params.push(userId);
      } else if (userSearch) {
        query += ` WHERE 1=0`;
      }

      query += ` ORDER BY dj.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = 'SELECT COUNT(*) FROM did_jobs dj LEFT JOIN orders o ON dj.order_id = o.id';
      const countParams: any[] = [];
      
      if (userId !== null) {
        countQuery += ' WHERE o.user_id = $1';
        countParams.push(userId);
      } else if (userSearch) {
        countQuery += ' WHERE 1=0';
      }
      
      const countResult = await client.query(countQuery, countParams);

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
          (SELECT COUNT(*) FROM did_jobs WHERE status = 'failed') as failed_jobs,
          -- Воронка флоу
          (SELECT COUNT(DISTINCT user_id) FROM orders) as users_with_orders,
          (SELECT COUNT(DISTINCT u.id) FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND (o.price = 0 OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'success')))) as users_paid_or_used_generations,
          (SELECT COUNT(DISTINCT user_id) FROM orders WHERE status = 'completed') as users_completed_orders
      `);

      const result = stats.rows[0];
      const totalUsers = parseInt(result.total_users) || 0;
      const usersWithOrders = parseInt(result.users_with_orders) || 0;
      const usersPaid = parseInt(result.users_paid_or_used_generations) || 0;
      const usersCompleted = parseInt(result.users_completed_orders) || 0;

      // Добавляем проценты конверсии
      const flow = {
        registered: totalUsers,
        created_order: usersWithOrders,
        paid_or_used_generations: usersPaid,
        completed_order: usersCompleted,
        conversion_registered_to_order: totalUsers > 0 ? ((usersWithOrders / totalUsers) * 100).toFixed(1) : '0.0',
        conversion_order_to_paid: usersWithOrders > 0 ? ((usersPaid / usersWithOrders) * 100).toFixed(1) : '0.0',
        conversion_paid_to_completed: usersPaid > 0 ? ((usersCompleted / usersPaid) * 100).toFixed(1) : '0.0',
        overall_conversion: totalUsers > 0 ? ((usersCompleted / totalUsers) * 100).toFixed(1) : '0.0'
      };

      res.json({
        ...result,
        flow
      });
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

      // Поиск по пользователю: сначала пытаемся найти user_id по telegram_id или username
      let userId: number | null = null;
      if (userSearch) {
        const userSearchQuery = await client.query(`
          SELECT id FROM users 
          WHERE telegram_id::text ILIKE $1 OR username ILIKE $1 OR id::text = $1
          LIMIT 1
        `, [`%${userSearch}%`]);
        
        if (userSearchQuery.rows.length > 0) {
          userId = userSearchQuery.rows[0].id;
        }
      }

      let query = `SELECT al.*, u.telegram_id, u.username, u.first_name, u.last_name 
                   FROM activity_logs al 
                   LEFT JOIN users u ON al.user_id = u.id 
                   WHERE 1=1`;
      const params: any[] = [];
      let paramCount = 0;

      if (tableName) {
        paramCount++;
        query += ` AND al.table_name = $${paramCount}`;
        params.push(tableName);
      }

      if (action) {
        paramCount++;
        query += ` AND al.action = $${paramCount}`;
        params.push(action.toUpperCase());
      }

      if (userSearch && userId !== null) {
        paramCount++;
        query += ` AND al.user_id = $${paramCount}`;
        params.push(userId);
      } else if (userSearch) {
        // Если пользователь не найден, возвращаем пустой результат
        query += ` AND 1=0`; // Всегда false
      }
      
      query += ` ORDER BY al.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
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

      // Поиск по пользователю для подсчета (используем тот же user_id что в основном запросе)
      if (userSearch) {
        // Находим user_id аналогично основному запросу
        const userSearchQuery = await client.query(`
          SELECT id FROM users 
          WHERE telegram_id::text ILIKE $1 OR username ILIKE $1 OR id::text = $1
          LIMIT 1
        `, [`%${userSearch}%`]);
        
        if (userSearchQuery.rows.length > 0) {
          const userId = userSearchQuery.rows[0].id;
          countParamCount++;
          countQuery += ` AND user_id = $${countParamCount}`;
          countParams.push(userId);
        } else {
          countQuery += ` AND 1=0`; // Всегда false
        }
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

// Получить статистику по пользователю (прохождение флоу)
router.get('/analytics/user/:userId', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const userId = parseInt(req.params.userId);
      
      if (isNaN(userId)) {
        return res.status(400).json({ error: 'Invalid user ID' });
      }

      // Получаем информацию о пользователе
      const userResult = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
      
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Статистика по заказам
      const ordersStats = await client.query(`
        SELECT 
          COUNT(*) as total_orders,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_orders,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_orders,
          COUNT(CASE WHEN status = 'payment_required' THEN 1 END) as pending_orders
        FROM orders
        WHERE user_id = $1
      `, [userId]);

      // Статистика по платежам
      const paymentsStats = await client.query(`
        SELECT 
          COUNT(*) as total_payments,
          COUNT(CASE WHEN status = 'success' THEN 1 END) as successful_payments,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_payments,
          COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0) as total_spent
        FROM payments
        WHERE user_id = $1
      `, [userId]);

      // Статистика по генерациям (did_jobs)
      const jobsStats = await client.query(`
        SELECT 
          COUNT(*) as total_jobs,
          COUNT(CASE WHEN dj.status = 'completed' THEN 1 END) as completed_jobs,
          COUNT(CASE WHEN dj.status = 'failed' THEN 1 END) as failed_jobs,
          COUNT(CASE WHEN dj.status = 'processing' THEN 1 END) as processing_jobs
        FROM did_jobs dj
        LEFT JOIN orders o ON dj.order_id = o.id
        WHERE o.user_id = $1
      `, [userId]);

      // Заказы, оплаченные генерациями (price = 0)
      const generationsOrders = await client.query(`
        SELECT COUNT(*) as generations_orders
        FROM orders
        WHERE user_id = $1 AND price = 0
      `, [userId]);

      const stats = {
        user: {
          id: user.id,
          telegram_id: user.telegram_id,
          username: user.username,
          first_name: user.first_name,
          last_name: user.last_name,
          generations: user.generations,
          created_at: user.created_at
        },
        orders: {
          total: parseInt(ordersStats.rows[0].total_orders) || 0,
          completed: parseInt(ordersStats.rows[0].completed_orders) || 0,
          failed: parseInt(ordersStats.rows[0].failed_orders) || 0,
          pending: parseInt(ordersStats.rows[0].pending_orders) || 0,
          generations_orders: parseInt(generationsOrders.rows[0].generations_orders) || 0
        },
        payments: {
          total: parseInt(paymentsStats.rows[0].total_payments) || 0,
          successful: parseInt(paymentsStats.rows[0].successful_payments) || 0,
          pending: parseInt(paymentsStats.rows[0].pending_payments) || 0,
          total_spent: parseFloat(paymentsStats.rows[0].total_spent) || 0
        },
        jobs: {
          total: parseInt(jobsStats.rows[0].total_jobs) || 0,
          completed: parseInt(jobsStats.rows[0].completed_jobs) || 0,
          failed: parseInt(jobsStats.rows[0].failed_jobs) || 0,
          processing: parseInt(jobsStats.rows[0].processing_jobs) || 0
        },
        flow: {
          registered: true,
          has_orders: (parseInt(ordersStats.rows[0].total_orders) || 0) > 0,
          has_payments: (parseInt(paymentsStats.rows[0].total_payments) || 0) > 0 || (parseInt(ordersStats.rows[0].total_orders) || 0) > 0,
          has_completed: (parseInt(ordersStats.rows[0].completed_orders) || 0) > 0,
          completion_rate: ordersStats.rows[0].total_orders > 0 
            ? ((parseInt(ordersStats.rows[0].completed_orders) || 0) / parseInt(ordersStats.rows[0].total_orders) * 100).toFixed(1)
            : '0.0'
        }
      };

      res.json(stats);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching user analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

