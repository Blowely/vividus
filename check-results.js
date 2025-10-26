import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import pool from './src/config/database';

config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

async function checkAndSendResults() {
  try {
    // Get all completed jobs that haven't been sent
    const result = await pool.query(`
      SELECT dj.*, o.user_id, u.telegram_id 
      FROM did_jobs dj
      JOIN orders o ON dj.order_id = o.id
      JOIN users u ON o.user_id = u.id
      WHERE dj.status = 'completed' 
      AND dj.result_url IS NOT NULL
      AND o.status = 'processing'
    `);
    
    console.log(`Found ${result.rows.length} completed jobs`);
    
    for (const job of result.rows) {
      try {
        // Send result to user
        await bot.telegram.sendMessage(
          job.telegram_id,
          `🎬 Ваше видео готово!\n\n📹 Результат: ${job.result_url}\n\nСпасибо за использование Vividus Bot!`
        );
        
        // Update order status
        await pool.query(
          'UPDATE orders SET status = $1 WHERE id = $2',
          ['completed', job.order_id]
        );
        
        console.log(`Sent result to user ${job.telegram_id} for job ${job.did_job_id}`);
      } catch (error) {
        console.error(`Error sending result to user ${job.telegram_id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error checking results:', error);
  }
}

checkAndSendResults().then(() => {
  console.log('Check completed');
  process.exit(0);
});
