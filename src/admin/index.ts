import express from 'express';
import path from 'path';
import cookieParser from 'cookie-parser';
import { config } from 'dotenv';
import crypto from 'crypto';
import axios from 'axios';
import pool from '../config/database';

config();

const app = express();
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;
const ADMIN_USERNAMES = ['in_a_state_of_flux', 'pronewa'];
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Простое хранилище сессий в памяти (для продакшена лучше использовать Redis)
const sessions: Map<string, any> = new Map();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для чтения сессии из cookie
function getSession(req: express.Request): any | null {
  const sessionId = req.cookies?.sessionId || req.headers['x-session-id'];
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

// Middleware для установки сессии
function setSession(res: express.Response, data: any): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, data);
  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 86400000 // 24 часа
  });
  return sessionId;
}

// Проверка подписи Telegram Widget Login
function verifyTelegramAuth(authData: any): boolean {
  if (!authData || !authData.hash) {
    return false;
  }

  const { hash, ...data } = authData;
  
  // Создаём строку для проверки подписи
  const dataCheckString = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('\n');

  // Создаём секретный ключ из bot token
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(BOT_TOKEN)
    .digest();

  // Вычисляем хеш
  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // Проверяем подпись
  if (calculatedHash !== hash) {
    return false;
  }

  // Проверяем, что данные не старше 24 часов
  const authDate = parseInt(data.auth_date);
  const currentTime = Math.floor(Date.now() / 1000);
  if (currentTime - authDate > 86400) {
    return false;
  }

  return true;
}

// Endpoint для авторизации через Telegram (БЕЗ requireAuth - нужен для входа)
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const authData = req.body;

    // Проверяем подпись
    if (!verifyTelegramAuth(authData)) {
      return res.status(401).json({ error: 'Invalid Telegram authentication' });
    }

    const telegramId = parseInt(authData.id);
    const username = authData.username;

    // Проверяем, является ли пользователь админом
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [telegramId]
      );

      let user;
      if (result.rows.length === 0) {
        // Создаём нового пользователя если его нет
        const newUser = await client.query(
          `INSERT INTO users (telegram_id, username, first_name, last_name) 
           VALUES ($1, $2, $3, $4) 
           RETURNING *`,
          [telegramId, username, authData.first_name, authData.last_name]
        );
        user = newUser.rows[0];
      } else {
        user = result.rows[0];
      }

      const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
      const isAdmin = ADMIN_USERNAMES.includes(user.username || '') || 
                     adminIds.includes(user.telegram_id);

      if (!isAdmin) {
        return res.status(403).json({ error: 'Forbidden - not admin' });
      }

      // Сохраняем данные пользователя в сессии
      const sessionData = { user, telegramId, isAuthenticated: true };
      setSession(res, sessionData);

      res.json({ 
        success: true, 
        user: {
          id: user.id,
          telegram_id: user.telegram_id,
          username: user.username,
          first_name: user.first_name
        }
      });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint для проверки авторизации (БЕЗ requireAuth - нужен для проверки статуса)
app.get('/api/auth/check', async (req, res) => {
  const session = getSession(req);
  if (!session || !session.isAuthenticated) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: session.user });
});

// Endpoint для выхода (БЕЗ requireAuth - нужен для выхода)
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies?.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('sessionId');
  res.json({ success: true });
});

// Middleware для проверки аутентификации
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session = getSession(req);
  
  if (!session || !session.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM users WHERE telegram_id = $1',
        [session.telegramId]
      );
      
      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden - user not found' });
      }

      const user = result.rows[0];
      const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map(id => parseInt(id)) || [];
      const isAdmin = ADMIN_USERNAMES.includes(user.username || '') || 
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

// Кеш для bot username
let cachedBotUsername: string | null = null;

// Endpoint для получения bot username (для Telegram Widget)
// Должен быть ДО авторизации, так как нужен для входа
app.get('/api/bot-username', async (req, res) => {
  try {
    // Если есть кеш, используем его
    if (cachedBotUsername) {
      console.log('Using cached bot username:', cachedBotUsername);
      return res.json({ botUsername: cachedBotUsername });
    }

    // Пытаемся получить из переменной окружения
    let botUsername = process.env.TELEGRAM_BOT_USERNAME;
    console.log('TELEGRAM_BOT_USERNAME from env:', botUsername ? 'found' : 'not found');
    console.log('BOT_TOKEN exists:', !!BOT_TOKEN);

    // Если нет в env, получаем автоматически через Bot API
    if (!botUsername && BOT_TOKEN) {
      try {
        console.log('Fetching bot username from Telegram API...');
        const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, {
          timeout: 5000
        });
        console.log('Telegram API response:', response.data);
        if (response.data && response.data.ok && response.data.result && response.data.result.username) {
          botUsername = response.data.result.username;
          cachedBotUsername = botUsername || null; // Кешируем
          console.log('Bot username from API:', botUsername);
        } else {
          console.error('Invalid response from Telegram API:', response.data);
        }
      } catch (error: any) {
        console.error('Error getting bot username from API:', error.message);
        if (error.response) {
          console.error('API response:', error.response.data);
        }
      }
    }

    if (!botUsername) {
      const errorMsg = 'Bot username not found. Set TELEGRAM_BOT_USERNAME in .env or ensure BOT_TOKEN is valid.';
      console.error(errorMsg);
      return res.status(500).json({ error: errorMsg });
    }

    res.json({ botUsername });
  } catch (error: any) {
    console.error('Error in /api/bot-username:', error.message);
    res.status(500).json({ error: 'Failed to get bot username: ' + error.message });
  }
});

// API Routes (требуют авторизацию)
import apiRoutes from './routes/api';
app.use('/api', requireAuth, apiRoutes);

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(ADMIN_PORT, () => {
  console.log(`Admin panel server started on port ${ADMIN_PORT}`);
});

