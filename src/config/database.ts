import { Pool } from 'pg';
import { config } from 'dotenv';

config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'vividus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Увеличено с 2 до 10 секунд
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Обработка ошибок пула соединений
pool.on('error', (err, client) => {
  console.error('⚠️ Unexpected error on idle PostgreSQL client:', err.message);
  // Не завершаем процесс, просто логируем ошибку
  // Пул автоматически переподключится при следующем запросе
});

// Обработка ошибок при разрыве соединения
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('⚠️ PostgreSQL client error:', err.message);
    // Не завершаем процесс, пул обработает это автоматически
  });
  
  client.on('end', () => {
    console.log('ℹ️ PostgreSQL client connection ended');
  });
});

// Обработка необработанных ошибок процесса, связанных с PostgreSQL
process.on('unhandledRejection', (reason, promise) => {
  if (reason && typeof reason === 'object' && 'client' in reason) {
    const error = reason as any;
    if (error.message && error.message.includes('Connection terminated')) {
      console.error('⚠️ Unhandled PostgreSQL connection error (will retry on next query):', error.message);
      // Не завершаем процесс, пул обработает это автоматически
      return;
    }
  }
  // Для других ошибок логируем, но не завершаем процесс
  console.error('⚠️ Unhandled rejection:', reason);
});

export default pool;
