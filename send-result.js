import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import pool from './src/config/database';

config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

async function sendResultToUser() {
  try {
    // Get the specific job
    const result = await pool.query(`
      SELECT dj.*, o.user_id, u.telegram_id 
      FROM did_jobs dj
      JOIN orders o ON dj.order_id = o.id
      JOIN users u ON o.user_id = u.id
      WHERE dj.did_job_id = 'f089a7c8-af5a-424c-abe6-3d601a5d3081'
    `);
    
    if (result.rows.length === 0) {
      console.log('Job not found');
      return;
    }
    
    const job = result.rows[0];
    console.log(`Sending result to user ${job.telegram_id}`);
    
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
    
    console.log(`Result sent successfully to user ${job.telegram_id}`);
  } catch (error) {
    console.error('Error sending result:', error);
  }
}

sendResultToUser().then(() => {
  console.log('Done');
  process.exit(0);
});
