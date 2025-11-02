import express from 'express';
import path from 'path';
import { config } from 'dotenv';
import pool from '../config/database';

config();

const app = express();
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;
const ADMIN_USERNAMES = ['in_a_state_of_flux', 'pronewa'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для проверки аутентификации
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Простая проверка по username из заголовка или query параметра
  const username = (req.headers['x-username'] || req.query.username) as string;
  
  if (!username) {
    return res.status(401).json({ error: 'Unauthorized - username required' });
  }

  try {
    const client = await pool.connect();
    try {
      // Проверяем, есть ли пользователь с таким username в админах
      const result = await client.query(
        'SELECT * FROM users WHERE username = $1',
        [username]
      );
      
      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden - user not found' });
      }

      const user = result.rows[0];
      const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
      const isAdmin = ADMIN_USERNAMES.includes(user.username) || 
                     adminIds.includes(user.telegram_id);

      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden - not admin' });
      }

      (req as any).user = user;
      next();
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// API Routes
import apiRoutes from './routes/api';
app.use('/api', requireAuth, apiRoutes);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(ADMIN_PORT, () => {
  console.log(`Admin panel server started on port ${ADMIN_PORT}`);
});

