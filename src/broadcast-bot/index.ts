import { Telegraf, Context, Markup } from 'telegraf';
import { config } from 'dotenv';
import { BroadcastService } from './service';
import pool from '../config/database';
import { UserService } from '../services/user';
import { OrderService } from '../services/order';
import { FileService } from '../services/file';

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

// Состояние для режима "объединить и оживить"
const combineAndAnimatePhotos = new Map<number, string[]>(); // userId -> fileId[]
const combineAndAnimateState = new Map<number, { animationPrompt?: string; waitingForAnimationPrompt?: boolean }>(); // userId -> состояние

// Состояние для режима "Оживить фото v2"
const animateV2State = new Map<number, { photoFileId?: string; waitingForPrompt?: boolean; prompt?: string }>(); // userId -> состояние

const userService = new UserService();
const orderService = new OrderService();
const fileService = new FileService();

// Проверка админа (такая же как в основном боте)
function isAdmin(userId: number): boolean {
  return ADMIN_TELEGRAM_IDS.includes(userId);
}

// Команда /start
bot.start(async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return ctx.reply('❌ У вас нет доступа к этому боту.');
  }

  const keyboard = Markup.keyboard([
    [Markup.button.text('🎬 Оживить фото v2')],
    [Markup.button.text('🔀 Объединить и оживить')],
    [Markup.button.text('📨 Рассылка')]
  ]).resize();

  await ctx.reply(
    '👋 Добро пожаловать в бот для массовой рассылки!\n\n' +
    '📨 Отправьте сообщение (текст, фото, видео или GIF), которое нужно разослать всем пользователям основного бота.\n\n' +
    '✅ После отправки вы увидите предпросмотр и кнопки для подтверждения.\n\n' +
    '━━━━━━━━━━━━━━━━━━━━\n' +
    '🔍 /check - Проверить статус всех пользователей\n' +
    '🌱 /check_organic - Проверить статус органических пользователей (исключая unu, smm, task_pay)\n' +
    '💾 /dump_all - Создать полный дамп базы данных\n' +
    '📦 /dump - Создать дамп выбранных таблиц',
    keyboard
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
  
  // Обработка кнопки "Оживить фото v2"
  if (text === '🎬 Оживить фото v2') {
    await handleAnimateV2(ctx);
    return;
  }
  
  // Обработка кнопки "Объединить и оживить"
  if (text === '🔀 Объединить и оживить') {
    await handleCombineAndAnimate(ctx);
    return;
  }
  
  // Обработка кнопки "Рассылка" - возвращаемся к обычному режиму
  if (text === '📨 Рассылка') {
    await ctx.reply('📨 Режим рассылки активен. Отправьте сообщение для рассылки.');
    return;
  }
  
  // Проверяем, ожидает ли пользователь промпт для анимации v2
  const v2State = animateV2State.get(ctx.from!.id);
  if (v2State && v2State.waitingForPrompt) {
    if (!v2State.photoFileId) {
      await ctx.reply('❌ Фото не найдено. Начните заново.');
      animateV2State.delete(ctx.from!.id);
      return;
    }
    
    v2State.prompt = text;
    v2State.waitingForPrompt = false;
    animateV2State.set(ctx.from!.id, v2State);
    
    await ctx.reply('Готовлю видео, это займет до 5 минут...');
    await createAnimateV2Order(ctx, v2State.photoFileId, v2State.prompt);
    return;
  }
  
  // Проверяем, ожидает ли пользователь промпт для анимации в режиме combine_and_animate
  const combineState = combineAndAnimateState.get(ctx.from!.id);
  if (combineState && combineState.waitingForAnimationPrompt) {
    const photos = combineAndAnimatePhotos.get(ctx.from!.id) || [];
    
    if (photos.length < 2) {
      await ctx.reply('❌ Нужно отправить 2 фото. Начните заново.');
      combineAndAnimatePhotos.delete(ctx.from!.id);
      combineAndAnimateState.delete(ctx.from!.id);
      return;
    }
    
    // Берем только первые 2 фото
    const twoPhotos = photos.slice(0, 2);
    
    combineState.animationPrompt = text;
    combineState.waitingForAnimationPrompt = false;
    combineAndAnimateState.set(ctx.from!.id, combineState);
    
    await ctx.reply('Объединяю фото и готовлю видео, это займет до 5 минут...');
    await createCombineAndAnimateOrder(ctx, twoPhotos, combineState);
    return;
  }
  
  waitingForBroadcast.set(ctx.from!.id, { text });
  
  await showBroadcastPreview(ctx, { text });
});

// Обработка фото
bot.on('photo', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) {
    return;
  }

  // Проверяем, находимся ли мы в режиме "Оживить фото v2"
  const v2State = animateV2State.get(ctx.from!.id);
  if (v2State && !v2State.photoFileId) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    
    v2State.photoFileId = fileId;
    animateV2State.set(ctx.from!.id, v2State);
    
    const promptInstructions = `✅ Фото принято!

✍️ Теперь напишите, как оживить фото:

Примеры:
• Люди на фото улыбаются и обнимаются 🤗
• Мужчина слегка кивает и улыбается 😊
• Девушка моргает и слегка поворачивает голову 💫

📌 Важно:
• Используйте описания «мужчина слева», «женщина справа», «ребёнок в центре»
• Не пишите «я», «мы», «сестра» и т.п.
• Если на фото нет человека — не указывайте его

📏 Требования к фото:
• Минимальный размер: 300x300 пикселей
• Формат: JPG или PNG`;

    await ctx.reply(promptInstructions);
    
    v2State.waitingForPrompt = true;
    animateV2State.set(ctx.from!.id, v2State);
    return;
  }
  
  // Проверяем, находимся ли мы в режиме объединить и оживить
  const combinePhotos = combineAndAnimatePhotos.get(ctx.from!.id);
  if (combinePhotos !== undefined) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileId = photo.file_id;
    
    // Добавляем фото в список (ровно 2 фото)
    if (combinePhotos.length < 2) {
      combinePhotos.push(fileId);
      combineAndAnimatePhotos.set(ctx.from!.id, combinePhotos);
      
      if (combinePhotos.length === 1) {
        await ctx.reply('Принял 1/2. Пришлите ещё одно изображение.');
      } else if (combinePhotos.length === 2) {
        // Оба фото получены, запрашиваем промпт для анимации
        await requestAnimationPrompt(ctx);
      }
      return;
    } else {
      // Уже есть 2 фото, игнорируем остальные
      await ctx.reply('ℹ️ Уже получено 2 фото. Если случайно отправили больше — бот возьмёт первые два.');
      return;
    }
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

  // Логируем file_id для получения
  console.log('\n========================================');
  console.log('📹 ВИДЕО ПОЛУЧЕНО');
  console.log('========================================');
  console.log(`📋 file_id: ${video.file_id}`);
  console.log(`📏 Размер: ${video.file_size ? (video.file_size / 1024 / 1024).toFixed(2) + ' МБ' : 'неизвестно'}`);
  console.log(`⏱️  Длительность: ${video.duration ? video.duration + ' сек' : 'неизвестно'}`);
  console.log(`📝 Подпись: ${caption || '(нет)'}`);
  console.log('========================================\n');

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

// Обработчик для режима "Оживить фото v2"
async function handleAnimateV2(ctx: Context) {
  animateV2State.set(ctx.from!.id, {});
  
  const instructions = `🎬 ОЖИВИТЬ ФОТО V2

Используется новая нейросеть fal.ai (MiniMax Hailuo 2.3 Fast) для генерации видео из фото.

📸 КАК ЭТО РАБОТАЕТ:
1. Отправьте одно фото
2. Опишите, как оживить фото (или используйте базовую анимацию)
3. Получите видео через 2-5 минут!

📤 ОТПРАВЬТЕ ФОТО:`;
  
  await ctx.reply(instructions);
}

// Обработчик для режима "Объединить и оживить"
async function handleCombineAndAnimate(ctx: Context) {
  combineAndAnimatePhotos.set(ctx.from!.id, []);
  combineAndAnimateState.set(ctx.from!.id, {});
  
  const instructions = `🔀 ОБЪЕДИНИТЬ И ОЖИВИТЬ

ВАЖНО:
Функция совмещает 2 фотографии и рисует сцену с нуля, чтобы создать современный общий кадр или видео.

⚠️ Возможны небольшие неточности: лицо, выражение или детали внешности могут слегка измениться.

📸 ТРЕБОВАНИЯ К ФОТО:
• Фото в нормальном положении — не перевёрнутые и не боком
• Без рамок и без лишних элементов (текста, логотипов, фонов)
• Лицо должно быть чётко видно, хорошо освещено, без сильных теней
• Если на фото больше одного человека — нейросеть иногда может добавить лишнее лицо
• Рекомендуется: на каждом фото 1 человек — так соединение получится точнее

📤 КАК ОТПРАВЛЯТЬ:
• РОВНО 2 изображения
• Можно отправить одним альбомом из 2 фото или по одному сообщению
• Принимаются как фото, так и документ
• Форматы: JPG/JPEG/PNG

ℹ️ Если случайно пришлёте больше 2 — бот автоматически возьмёт первые два, а остальные проигнорирует.`;
  
  await ctx.reply(instructions);
}

async function requestAnimationPrompt(ctx: Context) {
  const message = `Теперь напишите, как оживить фото:

Примеры:
• "Люди на фото улыбаются и обнимаются 🤗"
• "Мужчина слегка кивает и улыбается 😊"
• "Девушка моргает и слегка поворачивает голову 💫"

📌 Важно:
• Используйте описания «мужчина слева», «женщина справа», «ребёнок в центре».
• Не пишите «я», «мы», «сестра» и т.п.
• Если на фото нет человека — не указывайте его.`;

  await ctx.reply(message);
  
  // Устанавливаем флаг ожидания промпта
  const state = combineAndAnimateState.get(ctx.from!.id) || {};
  state.waitingForAnimationPrompt = true;
  combineAndAnimateState.set(ctx.from!.id, state);
}

function translateAnimationPrompt(russianPrompt: string): string {
  const translations: { [key: string]: string } = {
    'улыбаются': 'smiling',
    'обнимаются': 'hugging',
    'кивает': 'nodding',
    'моргает': 'blinking',
    'поворачивает голову': 'turning head',
    'идут навстречу': 'walking towards each other',
    'идут': 'walking',
    'танцует': 'dancing',
    'бегает': 'running',
    'говорит': 'speaking',
    'машет': 'waving',
    'дышит': 'breathing',
    'мужчина слева': 'man on the left',
    'женщина справа': 'woman on the right',
    'ребёнок в центре': 'child in the center',
    'люди на фото': 'people in the photo'
  };
  
  let translated = russianPrompt.toLowerCase();
  
  // Заменяем фразы
  for (const [russian, english] of Object.entries(translations)) {
    if (translated.includes(russian)) {
      translated = translated.replace(russian, english);
    }
  }
  
  // Добавляем базовую часть если нужно
  if (!translated.includes('animate')) {
    translated = `animate this image with ${translated}`;
  }
  
  return translated;
}

async function createAnimateV2Order(
  ctx: Context,
  photoFileId: string,
  prompt?: string
) {
  try {
    // Получаем или создаем пользователя (админа)
    const user = await userService.getOrCreateUser(ctx.from!);
    
    // Получаем ссылку на файл через broadcast-bot (используем правильный токен)
    const fileLink = await bot.telegram.getFileLink(photoFileId);
    
    // Загружаем фото в S3 через URL
    const s3Url = await fileService.downloadFileFromUrlAndUploadToS3(fileLink.toString());
    
    // Переводим промпт на английский, если нужно
    let englishPrompt = prompt;
    if (prompt) {
      englishPrompt = translateAnimationPrompt(prompt);
    }
    
    // Создаем заказ
    const order = await orderService.createAnimateV2Order(
      user.id,
      s3Url,
      englishPrompt
    );
    
    // Очищаем состояние
    animateV2State.delete(ctx.from!.id);
    
    // Обновляем статус на processing для немедленной обработки
    await orderService.updateOrderStatus(order.id, 'processing' as any);
    
    // Отправляем сообщение о создании заказа (без прогресс-бара)
    await ctx.reply(`✅ Заказ создан! ID: ${order.id.slice(0, 8)}...\n\n🎬 Начинаю обработку...`);
    
    // Сразу отправляем прогресс-бар отдельным сообщением
    const createProgressBar = (percent: number): string => {
      const totalBlocks = 10;
      const filledBlocks = Math.round((percent / 100) * totalBlocks);
      const emptyBlocks = totalBlocks - filledBlocks;
      const filled = '█'.repeat(filledBlocks);
      const empty = '░'.repeat(emptyBlocks);
      return `[${filled}${empty}]`;
    };
    
    const progressBar = createProgressBar(0);
    const progressMessage = await ctx.reply(`🔄 Генерация видео...\n\n${progressBar} 0%`);
    
    // Сохраняем message_id прогресс-бара в базе данных для последующего обновления
    const progressMessageId = progressMessage && 'message_id' in progressMessage 
      ? (progressMessage as any).message_id 
      : null;
    
    if (progressMessageId) {
      // Сохраняем message_id в метаданных заказа вместе с промптом пользователя
      try {
        const client = await (await import('../config/database')).default.connect();
        try {
          // Сохраняем и промпт, и message_id, и startTime в JSON формате
          const metadata = {
            prompt: englishPrompt || null,
            progressMessageId: progressMessageId,
            startTime: Date.now() // Запоминаем время начала для фейкового прогресса
          };
          await client.query(
            `UPDATE orders SET custom_prompt = $1 WHERE id = $2`,
            [JSON.stringify(metadata), order.id]
          );
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Error saving progress message_id:', error);
      }
      
      // Сразу обновляем прогресс до 1%, чтобы пользователь видел движение немедленно
      setTimeout(async () => {
        try {
          const progressBar1 = createProgressBar(1);
          await bot.telegram.editMessageText(
            ctx.from!.id,
            progressMessageId,
            undefined,
            `🔄 Генерация видео...\n\n${progressBar1} 1%`
          );
        } catch (error) {
          console.error('Error updating initial progress:', error);
        }
      }, 500); // Через полсекунды обновляем до 1%
      
      // Запускаем таймер для фейкового прогресса, который будет работать независимо от API
      const startFakeProgress = async () => {
        const startTime = Date.now();
        const updateInterval = setInterval(async () => {
          try {
            // Проверяем, не завершился ли заказ
            const client = await (await import('../config/database')).default.connect();
            let orderStatus;
            try {
              const result = await client.query('SELECT status FROM orders WHERE id = $1', [order.id]);
              orderStatus = result.rows[0]?.status;
            } finally {
              client.release();
            }
            
            // Если заказ завершен, останавливаем таймер
            if (orderStatus === 'completed' || orderStatus === 'failed') {
              clearInterval(updateInterval);
              return;
            }
            
            // Вычисляем фейковый прогресс
            const elapsed = Date.now() - startTime;
            let fakeProgress = 1;
            
            if (elapsed < 120000) {
              // Первые 2 минуты - плавный рост от 1 до 70%
              fakeProgress = 1 + Math.min(69, Math.round((elapsed / 120000) * 69));
            } else if (elapsed < 150000) {
              // Следующие 30 секунд - рост от 70% до 85%
              const extraTime = elapsed - 120000;
              fakeProgress = 70 + Math.round((extraTime / 30000) * 15);
            } else if (elapsed < 180000) {
              // Следующие 30 секунд - медленный рост от 85% до 95%
              const extraTime = elapsed - 150000;
              fakeProgress = 85 + Math.round((extraTime / 30000) * 10);
            } else {
              // После 3 минут - держим на 95% до завершения
              fakeProgress = 95;
            }
            
            // Обновляем прогресс-бар
            const progressBarFake = createProgressBar(fakeProgress);
            await bot.telegram.editMessageText(
              ctx.from!.id,
              progressMessageId,
              undefined,
              `🔄 Генерация видео...\n\n${progressBarFake} ${fakeProgress}%`
            );
          } catch (error: any) {
            // Игнорируем ошибки редактирования (например, если сообщение уже изменено)
            if (error?.response?.error_code !== 400) {
              console.error('Error updating fake progress:', error);
            }
          }
        }, 3000); // Обновляем каждые 3 секунды
      };
      
      // Запускаем фейковый прогресс асинхронно
      startFakeProgress().catch(console.error);
    }
    
    // Запускаем обработку заказа
    try {
      const { ProcessorService } = await import('../services/processor');
      const processorService = new ProcessorService();
      // Запускаем асинхронно, чтобы не блокировать ответ
      processorService.processOrder(order.id).catch((processError) => {
        console.error('Error processing order:', processError);
      });
    } catch (processError) {
      console.error('Error starting order processing:', processError);
      await ctx.reply('⚠️ Заказ создан, но произошла ошибка при запуске обработки. Заказ будет обработан автоматически позже.');
    }
    
  } catch (error) {
    console.error('Error creating animate v2 order:', error);
    await ctx.reply('❌ Произошла ошибка при создании заказа. Попробуйте позже.');
  }
}

async function createCombineAndAnimateOrder(
  ctx: Context, 
  photos: string[], 
  state: { animationPrompt?: string }
) {
  try {
    // Получаем или создаем пользователя (админа)
    const user = await userService.getOrCreateUser(ctx.from!);
    
    // Получаем ссылки на файлы через broadcast-bot
    const photoUrls: string[] = [];
    for (const fileId of photos) {
      const fileLink = await bot.telegram.getFileLink(fileId);
      const s3Url = await fileService.downloadFileFromUrlAndUploadToS3(fileLink.toString());
      photoUrls.push(s3Url);
    }
    
    // Формируем промпты
    const combinePrompt = 'combine two reference images into one modern scene, drawing a new scene from scratch to create a cohesive common frame, merge the people from both images naturally into one composition';
    
    let animationPrompt = state.animationPrompt || 'everyone in the photo is waving hand, subtle movements and breathing effect';
    animationPrompt = translateAnimationPrompt(animationPrompt);
    
    // Создаем заказ
    // Сохраняем оригинальный промпт до перевода
    const originalAnimationPrompt = state.animationPrompt || animationPrompt;
    const order = await orderService.createCombineAndAnimateOrder(
      user.id,
      photoUrls,
      combinePrompt,
      animationPrompt,
      'processing' as any,
      originalAnimationPrompt // Передаем оригинальный промпт для сохранения в custom_prompt
    );
    
    // Очищаем состояние
    combineAndAnimatePhotos.delete(ctx.from!.id);
    combineAndAnimateState.delete(ctx.from!.id);
    
    // Обновляем статус на processing для немедленной обработки (для админа без оплаты)
    await orderService.updateOrderStatus(order.id, 'processing' as any);
    
    await ctx.reply(`✅ Заказ создан! ID: ${order.id.slice(0, 8)}...\n\n🎬 Начинаю обработку...\n\nШаг 1/2: Объединение фото через face-swap\nШаг 2/2: Анимация результата`);
    
    // Запускаем обработку заказа асинхронно
    try {
      const { ProcessorService } = await import('../services/processor');
      const processorService = new ProcessorService();
      processorService.processOrder(order.id).catch((processError) => {
        console.error('Error processing combine order:', processError);
      });
    } catch (processError) {
      console.error('Error starting order processing:', processError);
      await ctx.reply('⚠️ Заказ создан, но произошла ошибка при запуске обработки. Заказ будет обработан автоматически позже.');
    }
    
  } catch (error) {
    console.error('Error creating combine and animate order:', error);
    await ctx.reply('❌ Произошла ошибка при создании заказа. Попробуйте позже.');
  }
}

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
