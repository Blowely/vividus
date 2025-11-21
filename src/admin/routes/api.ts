import express from 'express';
import pool from '../../config/database';

const router = express.Router();

// Получить список всех кампаний
router.get('/campaigns', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT start_param as name 
        FROM users 
        WHERE start_param IS NOT NULL AND start_param != ''
        ORDER BY start_param
      `);
      
      res.json(result.rows.map(row => row.name));
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить всех пользователей
router.get('/users', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = (page - 1) * limit;
      const search = req.query.search as string;
      const campaign = req.query.campaign as string;

      let query = 'SELECT * FROM users';
      const params: any[] = [];
      const conditions: string[] = [];
      let paramCount = 0;
      
      if (search) {
        paramCount++;
        conditions.push(`(username ILIKE $${paramCount} OR first_name ILIKE $${paramCount} OR telegram_id::text LIKE $${paramCount})`);
        params.push(`%${search}%`);
      }
      
      if (campaign) {
        paramCount++;
        conditions.push(`start_param = $${paramCount}`);
        params.push(campaign);
      }
      
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      
      query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);
      
      // Получаем общее количество
      let countQuery = 'SELECT COUNT(*) FROM users';
      const countParams: any[] = [];
      const countConditions: string[] = [];
      let countParamCount = 0;
      
      if (search) {
        countParamCount++;
        countConditions.push(`(username ILIKE $${countParamCount} OR first_name ILIKE $${countParamCount} OR telegram_id::text LIKE $${countParamCount})`);
        countParams.push(`%${search}%`);
      }
      
      if (campaign) {
        countParamCount++;
        countConditions.push(`start_param = $${countParamCount}`);
        countParams.push(campaign);
      }
      
      if (countConditions.length > 0) {
        countQuery += ' WHERE ' + countConditions.join(' AND ');
      }
      
      const countResult = await client.query(countQuery, countParams);

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
      const campaign = req.query.campaign as string;

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
          u.last_name,
          u.start_param
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
      `;
      const params: any[] = [];
      const conditions: string[] = [];
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        conditions.push(`o.user_id = $${paramCount}`);
        params.push(userId);
      } else if (userSearch) {
        // Если пользователь не найден, возвращаем пустой результат
        conditions.push('1=0');
      }

      if (campaign) {
        paramCount++;
        conditions.push(`u.start_param = $${paramCount}`);
        params.push(campaign);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ` ORDER BY o.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = `
        SELECT COUNT(*) 
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
      `;
      const countParams: any[] = [];
      const countConditions: string[] = [];
      let countParamCount = 0;
      
      if (userId !== null) {
        countParamCount++;
        countConditions.push(`o.user_id = $${countParamCount}`);
        countParams.push(userId);
      } else if (userSearch) {
        countConditions.push('1=0');
      }
      
      if (campaign) {
        countParamCount++;
        countConditions.push(`u.start_param = $${countParamCount}`);
        countParams.push(campaign);
      }
      
      if (countConditions.length > 0) {
        countQuery += ' WHERE ' + countConditions.join(' AND ');
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
      const campaign = req.query.campaign as string;

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
          u.start_param,
          o.status as order_status
        FROM payments p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN orders o ON p.order_id = o.id
      `;
      const params: any[] = [];
      const conditions: string[] = [];
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        conditions.push(`p.user_id = $${paramCount}`);
        params.push(userId);
      } else if (userSearch) {
        conditions.push('1=0');
      }

      if (campaign) {
        paramCount++;
        conditions.push(`u.start_param = $${paramCount}`);
        params.push(campaign);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ` ORDER BY p.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = `
        SELECT COUNT(*) 
        FROM payments p
        LEFT JOIN users u ON p.user_id = u.id
      `;
      const countParams: any[] = [];
      const countConditions: string[] = [];
      let countParamCount = 0;
      
      if (userId !== null) {
        countParamCount++;
        countConditions.push(`p.user_id = $${countParamCount}`);
        countParams.push(userId);
      } else if (userSearch) {
        countConditions.push('1=0');
      }
      
      if (campaign) {
        countParamCount++;
        countConditions.push(`u.start_param = $${countParamCount}`);
        countParams.push(campaign);
      }
      
      if (countConditions.length > 0) {
        countQuery += ' WHERE ' + countConditions.join(' AND ');
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
      const campaign = req.query.campaign as string;

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
          u.start_param,
          o.original_file_path,
          o.custom_prompt,
          o.status as order_status
        FROM did_jobs dj
        LEFT JOIN orders o ON dj.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
      `;
      const params: any[] = [];
      const conditions: string[] = [];
      let paramCount = 0;

      if (userId !== null) {
        paramCount++;
        conditions.push(`o.user_id = $${paramCount}`);
        params.push(userId);
      } else if (userSearch) {
        conditions.push('1=0');
      }

      if (campaign) {
        paramCount++;
        conditions.push(`u.start_param = $${paramCount}`);
        params.push(campaign);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ` ORDER BY dj.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = `
        SELECT COUNT(*) 
        FROM did_jobs dj 
        LEFT JOIN orders o ON dj.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
      `;
      const countParams: any[] = [];
      const countConditions: string[] = [];
      let countParamCount = 0;
      
      if (userId !== null) {
        countParamCount++;
        countConditions.push(`o.user_id = $${countParamCount}`);
        countParams.push(userId);
      } else if (userSearch) {
        countConditions.push('1=0');
      }
      
      if (campaign) {
        countParamCount++;
        countConditions.push(`u.start_param = $${countParamCount}`);
        countParams.push(campaign);
      }
      
      if (countConditions.length > 0) {
        countQuery += ' WHERE ' + countConditions.join(' AND ');
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
      const campaign = req.query.campaign as string | undefined;
      const params = campaign ? [campaign] : [];
      
      // Условие для фильтрации по кампании
      const campaignFilter = campaign ? 'AND u.start_param = $1' : '';
      
      const stats = await client.query(`
        SELECT 
          (SELECT COUNT(*) FROM users ${campaign ? 'WHERE start_param = $1' : ''}) as total_users,
          (SELECT COUNT(*) FROM orders o 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE 1=1 ${campaignFilter}) as total_orders,
          (SELECT COUNT(*) FROM orders o 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE o.status = 'completed' ${campaignFilter}) as completed_orders,
          (SELECT COUNT(*) FROM orders o 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE o.status = 'failed' ${campaignFilter}) as failed_orders,
          (SELECT COUNT(*) 
           FROM payments p 
           LEFT JOIN orders o ON p.order_id = o.id
           LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id)
           WHERE p.status = 'success' 
             AND u.id IS NOT NULL
             ${campaign ? 'AND u.start_param = $1' : ''}) as successful_payments,
          -- Выручка считается только из успешно оплаченных платежей (status = 'success')
          (SELECT COALESCE(SUM(p.amount), 0) 
           FROM payments p 
           LEFT JOIN orders o ON p.order_id = o.id
           LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id)
           WHERE p.status = 'success' 
             AND u.id IS NOT NULL
             ${campaign ? 'AND u.start_param = $1' : ''}) as total_revenue,
          (SELECT COALESCE(SUM(u.generations), 0) FROM users u ${campaign ? 'WHERE start_param = $1' : ''}) as total_generations,
          (SELECT COUNT(*) FROM did_jobs dj 
           INNER JOIN orders o ON o.id = dj.order_id 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE dj.status = 'completed' ${campaignFilter}) as completed_jobs,
          (SELECT COUNT(*) FROM did_jobs dj 
           INNER JOIN orders o ON o.id = dj.order_id 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE dj.status = 'failed' ${campaignFilter}) as failed_jobs,
          -- Воронка флоу
          (SELECT COUNT(DISTINCT o.user_id) FROM orders o 
           INNER JOIN users u ON u.id = o.user_id 
           WHERE 1=1 ${campaignFilter}) as users_with_orders,
          -- Пользователи, которые оплатили или использовали генерации
          (SELECT COUNT(DISTINCT o.user_id) 
           FROM orders o 
           INNER JOIN users u ON u.id = o.user_id
           LEFT JOIN payments p ON o.id = p.order_id
           WHERE (NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id) OR (p.status = 'success' AND p.order_id = o.id)) ${campaignFilter}) as users_paid_or_used_generations,
          -- Пользователи, которые завершили заказ
          (SELECT COUNT(DISTINCT o.user_id) 
           FROM orders o 
           INNER JOIN users u ON u.id = o.user_id
           LEFT JOIN payments p ON o.id = p.order_id
           WHERE o.status = 'completed' 
           AND (NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id) OR (p.status = 'success' AND p.order_id = o.id)) ${campaignFilter}) as users_completed_orders
      `, params);

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

// Получить краткую статистику по периодам (для главной страницы)
router.get('/stats/summary', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const campaign = req.query.campaign as string | undefined;
      
      // Фильтр по кампании для пользователей - работает с NULL
      const userCampaignFilter = `AND ((SELECT campaign_filter FROM filter_params) IS NULL OR start_param = (SELECT campaign_filter FROM filter_params))`;
      // Фильтр по кампании для заказов через JOIN с users
      const orderCampaignFilter = `INNER JOIN users u ON orders.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND`;
      // Фильтр по кампании для платежей
      const paymentCampaignJoin = `LEFT JOIN orders o ON p.order_id = o.id LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id) WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND`;
      
      // Всегда передаем параметр, но используем NULL если кампания не выбрана
      const params = [campaign || null];
      
      // Получаем список админов и пользователя vividusgosupp
      const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      
      // Получаем telegram_id пользователя vividusgosupp
      const vividusgosuppResult = await client.query(
        'SELECT telegram_id FROM users WHERE username = $1',
        ['vividusgosupp']
      );
      const vividusgosuppId = vividusgosuppResult.rows[0]?.telegram_id;
      
      // Формируем список ID для исключения (админы + vividusgosupp)
      const excludeUserIds = [...adminIds];
      if (vividusgosuppId) {
        excludeUserIds.push(parseInt(vividusgosuppId));
      }
      
      console.log('Fetching summary stats with params:', { campaign, params, excludeUserIds });
      
      // Получаем статистику за разные периоды
      // Если есть админы для исключения, добавляем их в параметры
      const queryParams: any[] = [campaign || null];
      let paramIndex = 2;
      let excludeUsersCondition = '';
      
      if (excludeUserIds.length > 0) {
        queryParams.push(excludeUserIds);
        excludeUsersCondition = `AND o.user_id IN (SELECT id FROM users WHERE telegram_id = ANY($${paramIndex}::bigint[]))`;
      }
      
      const result = await client.query(`
        WITH filter_params AS (
          SELECT NULLIF($1, '')::text as campaign_filter
        ),
        periods AS (
          SELECT 
            DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) as today_start,
            DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '2 days' as three_days_start,
            DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '6 days' as week_start
        )
        SELECT 
          -- Сегодня
          (SELECT COUNT(*) FROM users WHERE (users.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods) ${userCampaignFilter}) as users_today,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods)) as orders_today,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods) AND orders.status = 'completed') as generations_today,
          (SELECT COUNT(*) FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods) AND o.status = 'completed' ${excludeUsersCondition}) as admin_generations_today,
          (SELECT COUNT(*) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods) AND p.status = 'success') as payments_today,
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT today_start FROM periods) AND p.status = 'success') as revenue_today,
          
          -- За 3 дня
          (SELECT COUNT(*) FROM users WHERE (users.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods) ${userCampaignFilter}) as users_3d,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods)) as orders_3d,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods) AND orders.status = 'completed') as generations_3d,
          (SELECT COUNT(*) FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods) AND o.status = 'completed' ${excludeUsersCondition}) as admin_generations_3d,
          (SELECT COUNT(*) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods) AND p.status = 'success') as payments_3d,
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT three_days_start FROM periods) AND p.status = 'success') as revenue_3d,
          
          -- За неделю
          (SELECT COUNT(*) FROM users WHERE (users.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods) ${userCampaignFilter}) as users_week,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods)) as orders_week,
          (SELECT COUNT(*) FROM orders ${orderCampaignFilter} (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods) AND orders.status = 'completed') as generations_week,
          (SELECT COUNT(*) FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods) AND o.status = 'completed' ${excludeUsersCondition}) as admin_generations_week,
          (SELECT COUNT(*) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods) AND p.status = 'success') as payments_week,
          (SELECT COALESCE(SUM(p.amount), 0) FROM payments p ${paymentCampaignJoin} (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (SELECT week_start FROM periods) AND p.status = 'success') as revenue_week,
          
          -- Метрики возвращаемости
          (SELECT COUNT(*) FROM users WHERE (SELECT campaign_filter FROM filter_params) IS NULL OR start_param = (SELECT campaign_filter FROM filter_params)) as total_users,
          (SELECT COUNT(*) FROM (
            SELECT p.user_id 
            FROM payments p
            LEFT JOIN users u ON p.user_id = u.id
            WHERE p.status = 'success' AND ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params))
            GROUP BY p.user_id 
            HAVING COUNT(*) > 1
          ) as repeat_users) as repeat_customers,
          (SELECT COUNT(DISTINCT p.user_id) FROM payments p LEFT JOIN users u ON p.user_id = u.id WHERE p.status = 'success' AND ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params))) as paid_users,
          
          -- Активные пользователи (сделали заказ за последние 7 дней)
          (SELECT COUNT(DISTINCT o.user_id) FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (NOW() AT TIME ZONE 'Europe/Moscow') - INTERVAL '7 days') as active_7d,
          -- Активные пользователи (сделали заказ за последние 30 дней)
          (SELECT COUNT(DISTINCT o.user_id) FROM orders o INNER JOIN users u ON o.user_id = u.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)) AND (o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= (NOW() AT TIME ZONE 'Europe/Moscow') - INTERVAL '30 days') as active_30d
      `, params);
      
      console.log('Summary stats query completed successfully');
      
      const data = result.rows[0];
      
      // Считаем процент возвращаемости
      const paidUsers = parseInt(data.paid_users) || 0;
      const repeatCustomers = parseInt(data.repeat_customers) || 0;
      const repeatRate = paidUsers > 0 ? ((repeatCustomers / paidUsers) * 100).toFixed(1) : '0.0';
      
      res.json({
        today: {
          users: parseInt(data.users_today) || 0,
          orders: parseInt(data.orders_today) || 0,
          generations: parseInt(data.generations_today) || 0,
          admin_generations: parseInt(data.admin_generations_today) || 0,
          payments: parseInt(data.payments_today) || 0,
          revenue: parseFloat(data.revenue_today) || 0
        },
        three_days: {
          users: parseInt(data.users_3d) || 0,
          orders: parseInt(data.orders_3d) || 0,
          generations: parseInt(data.generations_3d) || 0,
          admin_generations: parseInt(data.admin_generations_3d) || 0,
          payments: parseInt(data.payments_3d) || 0,
          revenue: parseFloat(data.revenue_3d) || 0
        },
        week: {
          users: parseInt(data.users_week) || 0,
          orders: parseInt(data.orders_week) || 0,
          generations: parseInt(data.generations_week) || 0,
          admin_generations: parseInt(data.admin_generations_week) || 0,
          payments: parseInt(data.payments_week) || 0,
          revenue: parseFloat(data.revenue_week) || 0
        },
        retention: {
          total_users: parseInt(data.total_users) || 0,
          paid_users: paidUsers,
          repeat_customers: repeatCustomers,
          repeat_rate: parseFloat(repeatRate),
          active_7d: parseInt(data.active_7d) || 0,
          active_30d: parseInt(data.active_30d) || 0
        }
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error fetching summary stats:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      detail: error.detail,
      hint: error.hint,
      position: error.position
    });
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Получить детальную статистику по дням (для диаграммы "Общая")
router.get('/stats/summary-daily', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const campaign = req.query.campaign as string | undefined;
      const range = req.query.range as string || '7d';
      
      const params = [campaign || null];
      
      let startDateQuery = '';
      if (range === '7d') {
        // 7 полных дней (с начала дня 7 дней назад в МСК)
        startDateQuery = `DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '6 days'`;
      } else if (range === '30d') {
        // Для 30 дней: если проект младше 30 дней, показываем с начала, иначе ровно 30 дней (с начала дня 30 дней назад в МСК)
        startDateQuery = `(
          SELECT GREATEST(
            LEAST(
              (SELECT MIN(created_at) FROM users WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR start_param = (SELECT campaign_filter FROM filter_params))),
              (SELECT MIN(orders.created_at) FROM orders INNER JOIN users ON orders.user_id = users.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR users.start_param = (SELECT campaign_filter FROM filter_params))),
              (SELECT MIN(p.created_at) FROM payments p LEFT JOIN orders o ON p.order_id = o.id LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id) WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)))
            ),
            DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '29 days'
          )
        )`;
      } else if (range === 'all') {
        // Для "все время" находим самую раннюю дату создания
        startDateQuery = `(
          SELECT COALESCE(
            LEAST(
              (SELECT MIN(created_at) FROM users WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR start_param = (SELECT campaign_filter FROM filter_params))),
              (SELECT MIN(orders.created_at) FROM orders INNER JOIN users ON orders.user_id = users.id WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR users.start_param = (SELECT campaign_filter FROM filter_params))),
              (SELECT MIN(p.created_at) FROM payments p LEFT JOIN orders o ON p.order_id = o.id LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id) WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params)))
            ),
            DATE_TRUNC('day', (NOW() AT TIME ZONE 'Europe/Moscow')) - INTERVAL '30 days'
          )
        )`;
      }
      
      const result = await client.query(`
        WITH filter_params AS (
          SELECT NULLIF($1, '')::text as campaign_filter
        ),
        date_series AS (
          SELECT DATE(day) as date
          FROM generate_series(
            DATE(${startDateQuery}),
            DATE((NOW() AT TIME ZONE 'Europe/Moscow')),
            '1 day'::interval
          ) day
        )
        SELECT 
          ds.date,
          COALESCE(u.new_users, 0) as new_users,
          COALESCE(o.new_orders, 0) as new_orders,
          COALESCE(g.new_generations, 0) as new_generations,
          COALESCE(p.new_payments, 0) as new_payments,
          COALESCE(p.revenue, 0) as revenue
        FROM date_series ds
        LEFT JOIN (
          SELECT DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')) as date, COUNT(*) as new_users
          FROM users
          WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR start_param = (SELECT campaign_filter FROM filter_params))
            AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE(${startDateQuery})
          GROUP BY DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))
        ) u ON ds.date = u.date
        LEFT JOIN (
          SELECT DATE((orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')) as date, COUNT(*) as new_orders
          FROM orders
          INNER JOIN users ON orders.user_id = users.id
          WHERE ((SELECT campaign_filter FROM filter_params) IS NULL OR users.start_param = (SELECT campaign_filter FROM filter_params))
            AND (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE(${startDateQuery})
          GROUP BY DATE((orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))
        ) o ON ds.date = o.date
        LEFT JOIN (
          SELECT DATE((orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')) as date, COUNT(*) as new_generations
          FROM orders
          INNER JOIN users ON orders.user_id = users.id
          WHERE orders.status = 'completed'
            AND ((SELECT campaign_filter FROM filter_params) IS NULL OR users.start_param = (SELECT campaign_filter FROM filter_params))
            AND (orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE(${startDateQuery})
          GROUP BY DATE((orders.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))
        ) g ON ds.date = g.date
        LEFT JOIN (
          SELECT 
            DATE((p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')) as date, 
            COUNT(*) as new_payments,
            COALESCE(SUM(p.amount), 0) as revenue
          FROM payments p
          LEFT JOIN orders o ON p.order_id = o.id
          LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id)
          WHERE p.status = 'success'
            AND ((SELECT campaign_filter FROM filter_params) IS NULL OR u.start_param = (SELECT campaign_filter FROM filter_params))
            AND (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') >= DATE(${startDateQuery})
          GROUP BY DATE((p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))
        ) p ON ds.date = p.date
        ORDER BY ds.date
      `, params);
      
      res.json({ data: result.rows });
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error fetching summary daily stats:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Получить аналитику по кампаниям
router.get('/analytics/campaigns', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Выручка считается напрямую из таблицы payments с фильтром status = 'success'
      // чтобы избежать проблем со старыми данными в campaign_stats
      const result = await client.query(`
        SELECT 
          c.id as campaign_id,
          c.name as campaign_name,
          COUNT(DISTINCT cs.id) as stats_count,
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
          ) as completed_orders,
          CASE 
            WHEN (SELECT COUNT(DISTINCT u.id) FROM users u WHERE u.start_param = c.name) > 0 
            THEN ROUND((
              (SELECT COUNT(DISTINCT o.id) FROM orders o 
               INNER JOIN users u ON o.user_id = u.id 
               WHERE o.status = 'completed' AND u.start_param = c.name)::decimal / 
              (SELECT COUNT(DISTINCT u.id) FROM users u WHERE u.start_param = c.name)
            ) * 100, 2)
            ELSE 0 
          END as conversion_rate
        FROM campaigns c
        LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
        WHERE c.is_deleted = false
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

// Удалить кампанию (мягкое удаление)
router.delete('/campaigns/:name', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const campaignName = decodeURIComponent(req.params.name);
      
      // Мягкое удаление - устанавливаем флаг is_deleted = true
      const result = await client.query(
        'UPDATE campaigns SET is_deleted = true WHERE name = $1 RETURNING id', 
        [campaignName]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Кампания не найдена' });
      }
      
      res.json({ success: true, message: 'Кампания успешно удалена' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Восстановить кампанию
router.post('/campaigns/:name/restore', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const campaignName = decodeURIComponent(req.params.name);
      
      const result = await client.query(
        'UPDATE campaigns SET is_deleted = false WHERE name = $1 RETURNING id', 
        [campaignName]
      );
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Кампания не найдена' });
      }
      
      res.json({ success: true, message: 'Кампания успешно восстановлена' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error restoring campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить удаленные кампании
router.get('/campaigns/deleted', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          c.id as campaign_id,
          c.name as campaign_name,
          c.description,
          c.created_at,
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
          ) as total_payments_rub
        FROM campaigns c
        WHERE c.is_deleted = true
        ORDER BY c.created_at DESC
      `);
      
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching deleted campaigns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Сбросить статистику кампании
router.post('/campaigns/:name/reset', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const campaignName = decodeURIComponent(req.params.name);
      
      // Получаем ID кампании
      const campaignResult = await client.query('SELECT id FROM campaigns WHERE name = $1', [campaignName]);
      
      if (campaignResult.rows.length === 0) {
        return res.status(404).json({ error: 'Кампания не найдена' });
      }
      
      const campaignId = campaignResult.rows[0].id;
      
      // Удаляем всю статистику кампании
      await client.query('DELETE FROM campaign_stats WHERE campaign_id = $1', [campaignId]);
      
      res.json({ success: true, message: 'Статистика кампании успешно сброшена' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error resetting campaign stats:', error);
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
      const campaign = req.query.campaign as string;

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

      let query = `SELECT al.*, u.telegram_id, u.username, u.first_name, u.last_name, u.start_param 
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

      if (campaign) {
        paramCount++;
        query += ` AND u.start_param = $${paramCount}`;
        params.push(campaign);
      }
      
      query += ` ORDER BY al.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limit, offset);

      const result = await client.query(query, params);

      // Получаем общее количество
      let countQuery = `
        SELECT COUNT(*) 
        FROM activity_logs al
        LEFT JOIN users u ON al.user_id = u.id
        WHERE 1=1
      `;
      const countParams: any[] = [];
      let countParamCount = 0;

      if (tableName) {
        countParamCount++;
        countQuery += ` AND al.table_name = $${countParamCount}`;
        countParams.push(tableName);
      }

      if (action) {
        countParamCount++;
        countQuery += ` AND al.action = $${countParamCount}`;
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
          countQuery += ` AND al.user_id = $${countParamCount}`;
          countParams.push(userId);
        } else {
          countQuery += ` AND 1=0`; // Всегда false
        }
      }

      if (campaign) {
        countParamCount++;
        countQuery += ` AND u.start_param = $${countParamCount}`;
        countParams.push(campaign);
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

// Удалить все логи
router.delete('/logs', async (req, res) => {
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
        return res.status(404).json({ error: 'Таблица activity_logs не найдена' });
      }

      const result = await client.query('DELETE FROM activity_logs');
      
      res.json({ 
        message: 'Все логи успешно удалены',
        deletedCount: result.rowCount || 0
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error deleting logs:', error);
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
      // Выручка (total_spent) считается только из успешно оплаченных платежей (status = 'success')
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

      // Заказы, оплаченные генерациями (нет платежа в таблице payments)
      const generationsOrders = await client.query(`
        SELECT COUNT(*) as generations_orders
        FROM orders o
        WHERE o.user_id = $1 
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
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

// Получить данные о росте пользователей (общий рост)
router.get('/analytics/users-growth', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const range = req.query.range as string || '30d';
      
      // Определяем интервал и группировку (все в МСК)
      let interval = '30 days';
      let groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
      let dateFormat = 'date';
      
      if (range === '3h') {
        interval = '3 hours';
        groupBy = "DATE_TRUNC('minute', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') + INTERVAL '5 minutes') - INTERVAL '5 minutes' * FLOOR(EXTRACT(MINUTE FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))::int / 5)";
        dateFormat = 'datetime';
      } else if (range === '24h') {
        interval = '24 hours';
        groupBy = "DATE_TRUNC('hour', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'datetime';
      } else if (range === '7d') {
        interval = '7 days';
        groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      } else if (range === '30d') {
        interval = '30 days';
        groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      }
      
      const result = await client.query(`
        SELECT 
          ${groupBy} as date,
          COUNT(*) as new_users,
          SUM(COUNT(*)) OVER (ORDER BY ${groupBy}) as total_users
        FROM users
        WHERE (created_at + INTERVAL '3 hours') >= (NOW() + INTERVAL '3 hours') - INTERVAL '${interval}'
        GROUP BY ${groupBy}
        ORDER BY date
      `);
      
      res.json({ data: result.rows, format: dateFormat });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching users growth:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить данные о росте пользователей по кампаниям
router.get('/analytics/users-growth-by-campaign', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const range = req.query.range as string || '30d';
      const campaign = req.query.campaign as string;
      
      // Определяем интервал и группировку (все в МСК)
      let interval = '30 days';
      let groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
      let dateFormat = 'date';
      
      if (range === '3h') {
        interval = '3 hours';
        groupBy = "DATE_TRUNC('minute', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') + INTERVAL '5 minutes') - INTERVAL '5 minutes' * FLOOR(EXTRACT(MINUTE FROM (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))::int / 5)";
        dateFormat = 'datetime';
      } else if (range === '24h') {
        interval = '24 hours';
        groupBy = "DATE_TRUNC('hour', (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'datetime';
      } else if (range === '7d') {
        interval = '7 days';
        groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      } else if (range === '30d') {
        interval = '30 days';
        groupBy = "DATE((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      }
      
      let query = `
        SELECT 
          ${groupBy} as date,
          start_param as campaign,
          COUNT(*) as new_users,
          SUM(COUNT(*)) OVER (PARTITION BY start_param ORDER BY ${groupBy}) as total_users
        FROM users
        WHERE (created_at + INTERVAL '3 hours') >= (NOW() + INTERVAL '3 hours') - INTERVAL '${interval}'
          AND start_param IS NOT NULL AND start_param != ''
      `;
      
      if (campaign) {
        query += ` AND start_param = $1`;
      }
      
      query += `
        GROUP BY ${groupBy}, start_param
        ORDER BY date, start_param
      `;
      
      const result = campaign 
        ? await client.query(query, [campaign])
        : await client.query(query);
      
      res.json({ data: result.rows, format: dateFormat });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching users growth by campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить данные о платежах по времени
router.get('/analytics/payments-growth', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const range = req.query.range as string || '30d';
      
      // Определяем интервал и группировку (все в МСК)
      let interval = '30 days';
      let groupBy = "DATE((updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
      let dateFormat = 'date';
      
      if (range === '3h') {
        interval = '3 hours';
        groupBy = "DATE_TRUNC('minute', (updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') + INTERVAL '5 minutes') - INTERVAL '5 minutes' * FLOOR(EXTRACT(MINUTE FROM (updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))::int / 5)";
        dateFormat = 'datetime';
      } else if (range === '24h') {
        interval = '24 hours';
        groupBy = "DATE_TRUNC('hour', (updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'datetime';
      } else if (range === '7d') {
        interval = '7 days';
        groupBy = "DATE((updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      } else if (range === '30d') {
        interval = '30 days';
        groupBy = "DATE((updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      }
      
      const result = await client.query(`
        SELECT 
          ${groupBy} as date,
          COUNT(*) as new_payments,
          COALESCE(SUM(amount), 0) as total_amount,
          SUM(COUNT(*)) OVER (ORDER BY ${groupBy}) as total_payments
        FROM payments
        WHERE (updated_at + INTERVAL '3 hours') >= (NOW() + INTERVAL '3 hours') - INTERVAL '${interval}'
          AND status = 'success'
        GROUP BY ${groupBy}
        ORDER BY date
      `);
      
      res.json({ data: result.rows, format: dateFormat });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching payments growth:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Получить данные о платежах по кампаниям
router.get('/analytics/payments-growth-by-campaign', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const range = req.query.range as string || '30d';
      const campaign = req.query.campaign as string;
      
      // Определяем интервал и группировку (все в МСК)
      let interval = '30 days';
      let groupBy = "DATE((p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
      let dateFormat = 'date';
      
      if (range === '3h') {
        interval = '3 hours';
        groupBy = "DATE_TRUNC('minute', (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow') + INTERVAL '5 minutes') - INTERVAL '5 minutes' * FLOOR(EXTRACT(MINUTE FROM (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))::int / 5)";
        dateFormat = 'datetime';
      } else if (range === '24h') {
        interval = '24 hours';
        groupBy = "DATE_TRUNC('hour', (p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'datetime';
      } else if (range === '7d') {
        interval = '7 days';
        groupBy = "DATE((p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      } else if (range === '30d') {
        interval = '30 days';
        groupBy = "DATE((p.updated_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'))";
        dateFormat = 'date';
      }
      
      let query = `
        SELECT 
          ${groupBy} as date,
          COALESCE(u.start_param, 'Без кампании') as campaign,
          COUNT(*) as new_payments,
          COALESCE(SUM(p.amount), 0) as total_amount,
          SUM(COUNT(*)) OVER (PARTITION BY COALESCE(u.start_param, 'Без кампании') ORDER BY ${groupBy}) as total_payments
        FROM payments p
        LEFT JOIN orders o ON p.order_id = o.id
        LEFT JOIN users u ON (p.user_id = u.id OR o.user_id = u.id)
        WHERE (p.updated_at + INTERVAL '3 hours') >= (NOW() + INTERVAL '3 hours') - INTERVAL '${interval}'
          AND p.status = 'success'
          AND u.id IS NOT NULL
      `;
      
      if (campaign) {
        query += ` AND u.start_param = $1`;
      }
      
      query += `
        GROUP BY ${groupBy}, COALESCE(u.start_param, 'Без кампании')
        ORDER BY date, campaign
      `;
      
      const result = campaign 
        ? await client.query(query, [campaign])
        : await client.query(query);
      
      res.json({ data: result.rows, format: dateFormat });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error fetching payments growth by campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

