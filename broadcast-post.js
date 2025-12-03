const { Telegraf, Input } = require('telegraf');
const { config } = require('dotenv');
const fs = require('fs');
const path = require('path');
const https = require('https');

config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Ошибка: TELEGRAM_BOT_TOKEN не установлен в .env файле');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
// Broadcast-бот для получения файлов (если используется file_id из broadcast-bot)
const broadcastBot = process.env.BROADCAST_BOT_TOKEN 
  ? new Telegraf(process.env.BROADCAST_BOT_TOKEN) 
  : null;

// Текст для рассылки
const MESSAGE_TEXT = `✨ Новая функция — 🧩 Объединить и оживить!

Теперь вы можете совместить два фото —
будь то старое и современное или два одинаковых,
и нейросеть создаст современный живой кадр 🎞️

💡 Например, вы можете объединить своё текущее фото
с фотографией бабушки из прошлого —
и увидеть, как будто вы стоите рядом ❤️

⚠️ Важно знать:
• Нейросеть рисует сцену с нуля, поэтому лицо или выражение
могут немного отличаться от оригинала.
• Чем лучше качество и освещение исходных фото,
тем реалистичнее результат.
• Если лицо размыто или плохо видно —
нейросеть может интерпретировать его по-своему.

Чтобы попробовать — просто напишите в боте /start,
и у вас появится новая кнопка в меню
👉 🧩 Объединить и оживить
Следуйте инструкциям прямо в боте 💫`;

// URL видео
const VIDEO_URL = 'https://storage.yandexcloud.net/vividus/service/broadcast05.mp4';
const VIDEO_CACHE_PATH = path.join(__dirname, 'uploads', 'temp', 'broadcast05.mp4');
// file_id видео (если видео уже загружено в Telegram, используйте этот ID вместо URL)
// Получить file_id можно, загрузив видео один раз и сохранив file_id из ответа
const VIDEO_FILE_ID = process.env.VIDEO_FILE_ID || null;

// Проверка на блокировку бота
function isBlockedError(error) {
  return error?.response?.error_code === 403 && 
         (error?.response?.description?.includes('bot was blocked') || 
          error?.response?.description?.includes('Forbidden: bot was blocked') ||
          error?.response?.description?.includes('Forbidden'));
}

// Проверка на удаленный аккаунт или другие ошибки
function isDeletedAccountError(error) {
  const errorCode = error?.response?.error_code;
  const description = error?.response?.description?.toLowerCase() || '';
  
  // 400 - Bad Request (часто означает удаленный аккаунт или неверный chat_id)
  // 403 - Forbidden (блокировка)
  // 404 - Not Found (часто означает удаленный аккаунт)
  return (errorCode === 400 && description.includes('chat not found')) ||
         (errorCode === 404) ||
         (description.includes('chat not found')) ||
         (description.includes('user not found'));
}

// Парсинг SQL файла и извлечение telegram_id
function extractTelegramIds(sqlFilePath) {
  const content = fs.readFileSync(sqlFilePath, 'utf-8');
  const telegramIds = new Set();
  
  // Регулярное выражение для поиска VALUES и извлечения второго значения (telegram_id)
  // Формат: VALUES (id, 'telegram_id', ...)
  const regex = /VALUES\s*\([^,]+,\s*['"](\d+)['"]/g;
  let match;
  
  while ((match = regex.exec(content)) !== null) {
    const telegramId = match[1];
    if (telegramId) {
      telegramIds.add(telegramId);
    }
  }
  
  return Array.from(telegramIds).map(id => parseInt(id, 10));
}

// Поиск telegram_id админа по username в SQL файле
function findAdminTelegramId(sqlFilePath, username) {
  const content = fs.readFileSync(sqlFilePath, 'utf-8');
  
  // Ищем строку с username и извлекаем telegram_id
  // Формат: VALUES (id, 'telegram_id', 'username', ...)
  // Или: VALUES (id, 'telegram_id', NULL, ...) где username может быть в другом месте
  // Более гибкий поиск: ищем строку с username и извлекаем telegram_id из той же строки
  const lines = content.split('\n');
  
  for (const line of lines) {
    if (line.includes(`'${username}'`) || line.includes(`"${username}"`)) {
      // Нашли строку с username, теперь извлекаем telegram_id (второе значение в VALUES)
      const regex = /VALUES\s*\([^,]+,\s*['"](\d+)['"]/;
      const match = line.match(regex);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }
  }
  
  return null;
}

// Скачивание видео, если его нет локально
async function ensureVideoDownloaded() {
  if (fs.existsSync(VIDEO_CACHE_PATH)) {
    console.log('Видео уже скачано локально');
    return;
  }
  
  console.log('Скачиваю видео...');
  const dir = path.dirname(VIDEO_CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(VIDEO_CACHE_PATH);
    https.get(VIDEO_URL, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Ошибка скачивания: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        const sizeMB = (fs.statSync(VIDEO_CACHE_PATH).size / 1024 / 1024).toFixed(2);
        console.log(`Видео скачано (${sizeMB} МБ)`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlinkSync(VIDEO_CACHE_PATH);
      reject(err);
    });
  });
}

// Получение file_id видео (загрузить один раз и сохранить file_id)
async function getVideoFileId(telegramId) {
  try {
    console.log('Загружаю видео для получения file_id...');
    const videoInput = Input.fromLocalFile(VIDEO_CACHE_PATH);
    const result = await bot.telegram.sendVideo(telegramId, videoInput, {
      caption: 'Тестовая загрузка для получения file_id'
    });
    
    if (result.video && result.video.file_id) {
      console.log(`\n✅ file_id получен: ${result.video.file_id}`);
      console.log('Добавьте эту строку в .env файл:');
      console.log(`VIDEO_FILE_ID=${result.video.file_id}\n`);
      return result.video.file_id;
    }
    return null;
  } catch (error) {
    console.error('Ошибка при получении file_id:', error?.response?.description || error?.message);
    return null;
  }
}

// Скачивание файла через broadcast-bot по file_id
async function downloadFileFromBroadcastBot(fileId) {
  if (!broadcastBot) {
    throw new Error('BROADCAST_BOT_TOKEN не установлен');
  }
  
  try {
    const fileLink = await broadcastBot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    throw new Error(`Ошибка скачивания файла через broadcast-bot: ${error.message}`);
  }
}

// Отправка видео пользователю
async function sendVideoToUser(telegramId, cachedBuffer = null) {
  try {
    // Если есть кэшированный буфер (скачанный через broadcast-bot), используем его
    if (cachedBuffer) {
      await bot.telegram.sendVideo(telegramId, { source: cachedBuffer }, {
        caption: MESSAGE_TEXT,
        parse_mode: 'HTML'
      });
      return { success: true };
    }
    
    // ВСЕГДА используем URL для отправки (приоритет URL над file_id)
    // Telegram автоматически скачает файл по URL и отправит пользователю
    try {
      await bot.telegram.sendVideo(telegramId, VIDEO_URL, {
        caption: MESSAGE_TEXT,
        parse_mode: 'HTML'
      });
      return { success: true };
    } catch (urlError) {
      // Если URL не работает, пробуем file_id как fallback (только если есть)
      if (VIDEO_FILE_ID) {
        try {
          // Пробуем отправить напрямую (если file_id из основного бота)
          await bot.telegram.sendVideo(telegramId, VIDEO_FILE_ID, {
            caption: MESSAGE_TEXT,
            parse_mode: 'HTML'
          });
          return { success: true };
        } catch (fileIdError) {
          // Если не получилось, возможно file_id из broadcast-bot
          // Скачиваем файл через broadcast-bot и отправляем через основной бот
          if (broadcastBot && fileIdError?.response?.description?.includes('wrong file identifier')) {
            const fileBuffer = await downloadFileFromBroadcastBot(VIDEO_FILE_ID);
            await bot.telegram.sendVideo(telegramId, { source: fileBuffer }, {
              caption: MESSAGE_TEXT,
              parse_mode: 'HTML'
            });
            return { success: true };
          }
          // Если и file_id не работает, пробрасываем ошибку URL
          throw urlError;
        }
      } else {
        // Если нет file_id, пробрасываем ошибку URL
        throw urlError;
      }
    }
  } catch (error) {
    if (isBlockedError(error)) {
      return { success: false, reason: 'blocked' };
    } else if (isDeletedAccountError(error)) {
      return { success: false, reason: 'deleted' };
    } else {
      const errorMsg = error?.response?.description || error?.message || 'Unknown error';
      return { success: false, reason: 'error', error: errorMsg };
    }
  }
}

// Основная функция рассылки
async function broadcastPost(sqlFilePath, testMode = false, adminUsernames = null, getFileId = false) {
  // Показываем, какой метод используется для отправки видео
  console.log('✅ Используется прямая отправка по URL');
  console.log(`📋 URL: ${VIDEO_URL}`);
  console.log('ℹ️  Telegram автоматически скачает файл по URL (до 50 МБ)');
  if (VIDEO_FILE_ID) {
    console.log(`ℹ️  VIDEO_FILE_ID найден в .env, но будет использоваться URL (новое видео)`);
  }
  console.log('');
  
  // Если нужно получить file_id, делаем это и выходим
  if (getFileId) {
    try {
      await ensureVideoDownloaded();
      if (!testMode) {
        console.error('Для получения file_id необходимо использовать тестовый режим с указанием админа');
        process.exit(1);
      }
      const usernames = adminUsernames || 'vividusgosupp';
      const usernameList = usernames.split(',').map(u => u.trim()).filter(u => u);
      const adminId = findAdminTelegramId(sqlFilePath, usernameList[0]);
      if (!adminId) {
        console.error(`Админ "${usernameList[0]}" не найден`);
        process.exit(1);
      }
      await getVideoFileId(adminId);
      return;
    } catch (error) {
      console.error('Ошибка:', error.message);
      process.exit(1);
    }
  }
  
  // Скачиваем видео перед началом рассылки (только если используется file_id из broadcast-bot)
  let cachedVideoBuffer = null;
  
  if (VIDEO_FILE_ID && broadcastBot) {
    // Если используется file_id из broadcast-bot, скачиваем файл один раз
    try {
      console.log('Скачиваю видео через broadcast-bot (один раз для всех пользователей)...');
      cachedVideoBuffer = await downloadFileFromBroadcastBot(VIDEO_FILE_ID);
      const sizeMB = (cachedVideoBuffer.length / 1024 / 1024).toFixed(2);
      console.log(`✅ Видео скачано (${sizeMB} МБ)`);
    } catch (error) {
      console.error('Ошибка при скачивании видео через broadcast-bot:', error.message);
      console.log('Попробую использовать file_id напрямую...');
    }
  }
  // Если нет file_id, используем прямую отправку по URL - не нужно ничего скачивать
  
  if (testMode) {
    console.log('🧪 ТЕСТОВЫЙ РЕЖИМ - отправка тестовым пользователям');
    
    // Если username не указаны, используем значения по умолчанию
    let usernames = adminUsernames;
    if (!usernames) {
      usernames = 'in_a_state_of_flux,vividusgosupp';
    }
    
    // Разделяем по запятой, если указано несколько
    const usernameList = usernames.split(',').map(u => u.trim()).filter(u => u);
    
    console.log(`Ищу пользователей с username: ${usernameList.join(', ')}`);
    
    const results = [];
    
    for (const username of usernameList) {
      const adminId = findAdminTelegramId(sqlFilePath, username);
      if (!adminId) {
        console.error(`❌ Пользователь с username "${username}" не найден в SQL файле`);
        results.push({ username, success: false, error: 'Not found' });
        continue;
      }
      
      console.log(`✓ Найден ${username} с telegram_id: ${adminId}`);
      console.log(`Отправляю тестовое сообщение ${username}...`);
      
      const result = await sendVideoToUser(adminId, cachedVideoBuffer);
      if (result.success) {
        console.log(`✅ Тестовое сообщение успешно отправлено ${username}!`);
        results.push({ username, success: true });
      } else {
        console.error(`❌ Ошибка отправки ${username}: ${result.reason} - ${result.error || ''}`);
        results.push({ username, success: false, error: result.reason, details: result.error });
      }
      
      // Небольшая задержка между отправками
      if (usernameList.indexOf(username) < usernameList.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log('\n=== Результаты тестовой отправки ===');
    results.forEach(({ username, success, error, details }) => {
      if (success) {
        console.log(`✅ ${username}: успешно`);
      } else {
        console.log(`❌ ${username}: ${error}${details ? ` (${details})` : ''}`);
      }
    });
    
    return;
  }
  
  console.log('Начинаю рассылку...');
  console.log(`Читаю файл: ${sqlFilePath}`);
  
  const telegramIds = extractTelegramIds(sqlFilePath);
  console.log(`Найдено пользователей: ${telegramIds.length}`);
  
  if (telegramIds.length === 0) {
    console.error('Не найдено ни одного пользователя в SQL файле');
    return;
  }
  
  let successCount = 0;
  let blockedCount = 0;
  let deletedCount = 0;
  let errorCount = 0;
  const errors = [];
  const blockedUsers = [];
  const deletedUsers = [];
  
  // Задержка между отправками (чтобы не превысить лимиты API)
  // Telegram позволяет до 30 сообщений в секунду, используем 20 для безопасности
  const DELAY_MS = 50; // 50ms между отправками = ~20 сообщений в секунду
  const PROGRESS_INTERVAL = 100; // Показывать прогресс каждые 100 сообщений
  
  console.log('Начинаю отправку...\n');
  
  for (let i = 0; i < telegramIds.length; i++) {
    const telegramId = telegramIds[i];
    const result = await sendVideoToUser(telegramId, cachedVideoBuffer);
    
    if (result.success) {
      successCount++;
    } else if (result.reason === 'blocked') {
      blockedCount++;
      blockedUsers.push(telegramId);
    } else if (result.reason === 'deleted') {
      deletedCount++;
      deletedUsers.push(telegramId);
    } else {
      errorCount++;
      errors.push({ telegramId, error: result.error });
    }
    
    // Показываем прогресс каждые PROGRESS_INTERVAL сообщений или на последнем
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === telegramIds.length - 1) {
      const processed = i + 1;
      const progress = `[${processed}/${telegramIds.length}]`;
      const percent = ((processed / telegramIds.length) * 100).toFixed(1);
      console.log(`${progress} (${percent}%) Отправлено: ${successCount} из ${processed} | Заблокировали: ${blockedCount} | Удалены: ${deletedCount} | Ошибок: ${errorCount}`);
    }
    
    // Задержка между отправками (кроме последней)
    if (i < telegramIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }
  
  const totalFailed = blockedCount + deletedCount + errorCount;
  
  console.log('\n=== Результаты рассылки ===');
  console.log(`Всего пользователей: ${telegramIds.length}`);
  console.log(`✅ Успешно отправлено: ${successCount} (${((successCount / telegramIds.length) * 100).toFixed(2)}%)`);
  console.log(`🚫 Заблокировали бота: ${blockedCount} (${((blockedCount / telegramIds.length) * 100).toFixed(2)}%)`);
  console.log(`🗑️  Удаленные аккаунты: ${deletedCount} (${((deletedCount / telegramIds.length) * 100).toFixed(2)}%)`);
  console.log(`❌ Другие ошибки: ${errorCount} (${((errorCount / telegramIds.length) * 100).toFixed(2)}%)`);
  console.log(`\n📊 Всего неуспешно: ${totalFailed} (${((totalFailed / telegramIds.length) * 100).toFixed(2)}%)`);
  
  if (blockedUsers.length > 0 && blockedUsers.length <= 20) {
    console.log(`\nЗаблокировавшие пользователи (первые ${blockedUsers.length}):`);
    blockedUsers.slice(0, 20).forEach(id => console.log(`  - ${id}`));
  } else if (blockedUsers.length > 20) {
    console.log(`\nЗаблокировавшие пользователи (первые 20 из ${blockedUsers.length}):`);
    blockedUsers.slice(0, 20).forEach(id => console.log(`  - ${id}`));
  }
  
  if (deletedUsers.length > 0 && deletedUsers.length <= 20) {
    console.log(`\nУдаленные аккаунты (первые ${deletedUsers.length}):`);
    deletedUsers.slice(0, 20).forEach(id => console.log(`  - ${id}`));
  } else if (deletedUsers.length > 20) {
    console.log(`\nУдаленные аккаунты (первые 20 из ${deletedUsers.length}):`);
    deletedUsers.slice(0, 20).forEach(id => console.log(`  - ${id}`));
  }
  
  if (errors.length > 0) {
    console.log('\nДругие ошибки:');
    errors.slice(0, 20).forEach(({ telegramId, error }) => {
      console.log(`  ${telegramId}: ${error}`);
    });
    if (errors.length > 20) {
      console.log(`  ... и еще ${errors.length - 20} ошибок`);
    }
  }
}

// Запуск скрипта
const args = process.argv.slice(2);
let sqlFilePath = './users_2025-11-22T15-20-08.sql';
let testMode = false;
let adminUsernames = null;

let getFileId = false;

// Парсинг аргументов
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--test' || args[i] === '-t') {
    testMode = true;
    // Следующий аргумент может быть username админа (можно несколько через запятую)
    if (i + 1 < args.length && !args[i + 1].startsWith('--') && !args[i + 1].startsWith('-')) {
      adminUsernames = args[i + 1];
      i++;
    }
    // Если username не указан, используем значения по умолчанию (оба админа)
  } else if (args[i] === '--admin' || args[i] === '-a') {
    testMode = true;
    if (i + 1 < args.length && !args[i + 1].startsWith('--') && !args[i + 1].startsWith('-')) {
      adminUsernames = args[i + 1];
      i++;
    }
  } else if (args[i] === '--get-file-id' || args[i] === '-f') {
    getFileId = true;
    testMode = true;
  } else if (!args[i].startsWith('--') && !args[i].startsWith('-')) {
    // Это путь к SQL файлу
    sqlFilePath = args[i];
  }
}

if (!fs.existsSync(sqlFilePath)) {
  console.error(`Файл не найден: ${sqlFilePath}`);
  process.exit(1);
}

broadcastPost(sqlFilePath, testMode, adminUsernames, getFileId)
  .then(() => {
    console.log('\nРассылка завершена');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Критическая ошибка:', error);
    process.exit(1);
  });

