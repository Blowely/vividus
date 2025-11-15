import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { BroadcastService } from './service';
import pool from '../config/database';

config();

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '';
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));

interface BroadcastData {
  text?: string;
  mediaType?: string;
  mediaFileId?: string;
}

const bot = new Telegraf(BROADCAST_BOT_TOKEN);
const broadcastService = new BroadcastService();
const waitingForBroadcast = new Map<number, BroadcastData>();

// Проверка админа (такая же как в основном боте)
function isAdmin(userId: number): boolean {
  return ADMIN_TELEGRAM_IDS.includes(userId);
}

// Команда /start
bot.start(async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этому боту.');
  }

  await ctx.reply(
    '👋 Добро пожаловать в бот для массовой рассылки!\n\n' +
    '📨 Отправьте сообщение (текст, фото, видео или GIF), которое нужно разослать всем пользователям основного бота.\n\n' +
    '✅ После отправки вы увидите предпросмотр и кнопки для подтверждения.\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '🔍 /check - Проверить статус всех пользователей\n' +
    '🌱 /check_organic - Проверить статус органических пользователей (исключая unu, smm, task_pay)\n' +
    '💾 /dump_all - Создать полный дамп базы данных\n' +
    '📦 /dump - Создать дамп выбранных таблиц'
  );
});

// Команда /check - проверка статуса пользователей
bot.command('check', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }

  await ctx.reply(
    '🔍 Начинаю проверку статуса всех пользователей...\n\n' +
    'Это может занять некоторое время.\n\n' +
    '⚠️ Пользователи увидят индикатор "печатает..." на несколько секунд, но сообщения не получат.'
  );

  await broadcastService.checkAllUsersStatus(ctx.chat!.id);
});

// Команда /check_organic - проверка статуса только органических пользователей
bot.command('check_organic', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }

  await ctx.reply(
    '🌱 Начинаю проверку статуса органических пользователей...\n\n' +
    'Это может занять некоторое время.\n\n' +
    '⚠️ Пользователи увидят индикатор "печатает..." на несколько секунд, но сообщения не получат.\n\n' +
    'ℹ️ Исключены пользователи из кампаний: unu, smm, task_pay (купленные пользователи).'
  );

  await broadcastService.checkOrganicUsersStatus(ctx.chat!.id);
});

// Команда /dump_all - создать полный дамп базы данных
bot.command('dump_all', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }

  await ctx.reply(
    '💾 Начинаю создание полного дампа базы данных...\n\n' +
    'Это может занять некоторое время в зависимости от объема данных.'
  );

  await broadcastService.createFullDatabaseDump(ctx.chat!.id);
});

// Команда /dump - создать дамп выбранных таблиц
bot.command('dump', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этой команде.');
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('👥 users', 'dump_users'),
      Markup.button.callback('📦 orders', 'dump_orders')
    ],
    [
      Markup.button.callback('💳 payments', 'dump_payments'),
      Markup.button.callback('🎬 did_jobs', 'dump_did_jobs')
    ],
    [
      Markup.button.callback('📊 campaigns', 'dump_campaigns'),
      Markup.button.callback('📈 campaign_stats', 'dump_campaign_stats')
    ],
    [
      Markup.button.callback('📋 activity_logs', 'dump_activity_logs')
    ],
    [
      Markup.button.callback('❌ Отмена', 'dump_cancel')
    ]
  ]);

  await ctx.reply(
    '📦 Выберите таблицу для создания дампа:',
    keyboard
  );
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return;
  }

  const text = ctx.message.text;
  
  waitingForBroadcast.set(ctx.from!.id, { text });
  
  await showBroadcastPreview(ctx, { text });
});

// Обработка фото
bot.on('photo', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const caption = ctx.message.caption;

  waitingForBroadcast.set(ctx.from!.id, {
    text: caption,
    mediaType: 'photo',
    mediaFileId: photo.file_id
  });

  await showBroadcastPreview(ctx, {
    text: caption,
    mediaType: 'photo',
    mediaFileId: photo.file_id
  });
});

// Обработка видео
bot.on('video', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return;
  }

  const video = ctx.message.video;
  const caption = ctx.message.caption;

  waitingForBroadcast.set(ctx.from!.id, {
    text: caption,
    mediaType: 'video',
    mediaFileId: video.file_id
  });

  await showBroadcastPreview(ctx, {
    text: caption,
    mediaType: 'video',
    mediaFileId: video.file_id
  });
});

// Обработка GIF (анимаций)
bot.on('animation', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return;
  }

  const animation = ctx.message.animation;
  const caption = ctx.message.caption;

  waitingForBroadcast.set(ctx.from!.id, {
    text: caption,
    mediaType: 'animation',
    mediaFileId: animation.file_id
  });

  await showBroadcastPreview(ctx, {
    text: caption,
    mediaType: 'animation',
    mediaFileId: animation.file_id
  });
});

// Показать предпросмотр рассылки
async function showBroadcastPreview(ctx: Context, data: BroadcastData) {
  let previewText = '✅ Сообщение получено и обработано!\n\n';
  
  // Добавляем информацию о медиа
  if (data.mediaType && data.mediaFileId) {
    const mediaTypeNames: { [key: string]: string } = {
      'photo': '📷 Фото',
      'video': '🎥 Видео',
      'animation': '🎬 GIF/Анимация'
    };
    previewText += `${mediaTypeNames[data.mediaType] || '📎 Медиа'}\n`;
  }
  
  // Добавляем текст (если есть)
  if (data.text) {
    previewText += `\n📝 Текст:\n${data.text}\n`;
  } else if (!data.mediaType) {
    previewText += `\n📝 Текст: (пусто)\n`;
  }
  
  // Получаем количество неплатящих пользователей
  let nonPayingCount = 0;
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT COUNT(DISTINCT u.id) as count
      FROM users u
      LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'success'
      WHERE p.id IS NULL
    `);
    nonPayingCount = parseInt(result.rows[0]?.count || '0', 10);
  } catch (error) {
    console.error('Error getting non-paying users count:', error);
  } finally {
    client.release();
  }
  
  previewText += '\n━━━━━━━━━━━━━━━━━━━━\n';
  previewText += '📊 Статистика получателей:\n';
  previewText += `💸 Неплатящих пользователей: ${nonPayingCount}\n`;
  previewText += '\n━━━━━━━━━━━━━━━━━━━━\n';
  previewText += 'Выберите действие:';
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Разослать всем', 'broadcast_all'),
      Markup.button.callback('🧪 Тест (мне)', 'broadcast_test')
    ],
    [
      Markup.button.callback(`💸 Разослать неплатящим (${nonPayingCount})`, 'broadcast_non_paying')
    ],
    [Markup.button.callback('❌ Отменить', 'broadcast_cancel')]
  ]);

  await ctx.reply(previewText, keyboard);
}

// Обработка кнопок
bot.action('broadcast_test', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  const broadcastData = waitingForBroadcast.get(ctx.from!.id);
  if (!broadcastData) {
    return ctx.answerCbQuery('❌ Данные не найдены. Отправьте сообщение заново.');
  }

  await ctx.answerCbQuery('📤 Отправляю тестовое сообщение...');
  await ctx.editMessageText('🧪 Отправка тестового сообщения...');

  const result = await broadcastService.sendBroadcastToUser(ctx.from!.id, broadcastData);

  if (result.success) {
    await ctx.editMessageText(
      '✅ Тестовое сообщение успешно отправлено!\n\n' +
      '📬 Сообщение было получено в основном боте.\n\n' +
      'Проверьте основного бота, чтобы увидеть как выглядит рассылка.\n\n' +
      'Если всё хорошо, отправьте сообщение заново и выберите "Разослать всем".'
    );
  } else {
    await ctx.editMessageText(`❌ Ошибка при отправке: ${result.reason}`);
  }

  waitingForBroadcast.delete(ctx.from!.id);
});

bot.action('broadcast_all', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  const broadcastData = waitingForBroadcast.get(ctx.from!.id);
  if (!broadcastData) {
    return ctx.answerCbQuery('❌ Данные не найдены. Отправьте сообщение заново.');
  }

  await ctx.answerCbQuery('📢 Запускаю массовую рассылку...');
  await ctx.editMessageText('📢 Массовая рассылка началась...\n\nОжидайте обновлений...');

  // Запускаем рассылку
  await broadcastService.startMassBroadcast(broadcastData, ctx.from!.id, ctx.chat!.id);

  waitingForBroadcast.delete(ctx.from!.id);
});

bot.action('broadcast_non_paying', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  const broadcastData = waitingForBroadcast.get(ctx.from!.id);
  if (!broadcastData) {
    return ctx.answerCbQuery('❌ Данные не найдены. Отправьте сообщение заново.');
  }

  await ctx.answerCbQuery('💸 Запускаю рассылку неплатящим...');
  await ctx.editMessageText('💸 Рассылка неплатящим пользователям началась...\n\nОжидайте обновлений...');

  // Запускаем рассылку только неплатящим пользователям
  await broadcastService.sendBroadcastToNonPayingUsers(broadcastData, ctx.chat!.id);

  waitingForBroadcast.delete(ctx.from!.id);
});

bot.action('broadcast_cancel', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  waitingForBroadcast.delete(ctx.from!.id);
  await ctx.answerCbQuery('❌ Отменено');
  await ctx.editMessageText('❌ Рассылка отменена.');
});

// Обработчики для дампов таблиц
bot.action(/^dump_(users|orders|payments|did_jobs|campaigns|campaign_stats|activity_logs)$/, async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  const tableName = ctx.match![1];
  await ctx.answerCbQuery(`💾 Создаю дамп таблицы ${tableName}...`);
  await ctx.editMessageText(`💾 Создание дампа таблицы ${tableName}...\n\nОжидайте...`);

  await broadcastService.createTableDump(tableName, ctx.chat!.id);
});

bot.action('dump_cancel', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  await ctx.answerCbQuery('❌ Отменено');
  await ctx.editMessageText('❌ Создание дампа отменено.');
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// Настройка меню команд
bot.telegram.setMyCommands([
  { command: 'start', description: 'Начать работу с ботом' },
  { command: 'check', description: 'Проверить статус всех пользователей' },
  { command: 'check_organic', description: 'Проверить статус органических пользователей' },
  { command: 'dump_all', description: 'Создать полный дамп базы данных' },
  { command: 'dump', description: 'Создать дамп выбранных таблиц' }
]);

// Запуск бота
bot.launch()
  .then(() => {
    console.log('✅ Broadcast Bot запущен и готов к работе!');
    console.log(`👤 Админы: ${ADMIN_TELEGRAM_IDS.join(', ')}`);
  })
  .catch((error) => {
    console.error('❌ Ошибка запуска бота:', error);
    process.exit(1);
  });

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
