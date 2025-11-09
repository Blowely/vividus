import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { BroadcastService } from './service';

config();

const BROADCAST_BOT_TOKEN = process.env.BROADCAST_BOT_TOKEN || '7283880953:AAF3dUcktQOoe6zHurL9xpEPA8ImBc-MZGk';
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
    '🔍 /check - Проверить статус пользователей (кто заблокировал бота)'
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
    '✅ Проверка полностью невидима для пользователей - они не получат никаких уведомлений.'
  );

  await broadcastService.checkAllUsersStatus(ctx.chat!.id);
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
  
  previewText += '\n━━━━━━━━━━━━━━━━━━━━\n';
  previewText += 'Выберите действие:';
  
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Разослать всем', 'broadcast_all'),
      Markup.button.callback('🧪 Тест (мне)', 'broadcast_test')
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

bot.action('broadcast_cancel', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.answerCbQuery('❌ Нет доступа');
  }

  waitingForBroadcast.delete(ctx.from!.id);
  await ctx.answerCbQuery('❌ Отменено');
  await ctx.editMessageText('❌ Рассылка отменена.');
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

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
