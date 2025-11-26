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

// Текст для рассылки
const MESSAGE_TEXT = `✨ До Дня матери осталось всего несколько дней.
Это лучший момент подготовить подарок, который остаётся в сердце.

Теперь у нас есть новая услуга — ролик под ключ.
Вам не нужно ничего оживлять или обрабатывать самим — мы сделаем всё за вас.

Мы создадим трогательное видео полностью под ключ —
вам нужно только прислать фотографии.

🎥 Что входит:
• оживление старых фотографий
• восстановление качества
• монтаж красивого ролика с музыкой
• добавление ваших тёплых слов

📌 От вас нужно:
• 10 или 20 фото
• музыка
• текст поздравления (по желанию)

❤️ Почему лучше заранее:
• будет время выбрать лучшие фото
• ближе к празднику растёт загрузка

Люди, которые уже заказывали, пишут:
«Мама заплакала от счастья…»

🎁 Тарифы:
10 фото — 2990 ₽
20 фото — 4990 ₽

Для заказа: @vividusgosupp
Пример ролика — прикрепили выше.`;

// URL видео
const VIDEO_URL = 'https://storage.yandexcloud.net/vividus/service/broadcast03.mp4';
const VIDEO_CACHE_PATH = path.join(__dirname, 'uploads', 'temp', 'broadcast03.mp4');
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

// Отправка видео пользователю
async function sendVideoToUser(telegramId) {
  try {
    // Если есть file_id, используем его (самый надежный способ для больших файлов)
    if (VIDEO_FILE_ID) {
      await bot.telegram.sendVideo(telegramId, VIDEO_FILE_ID, {
        caption: MESSAGE_TEXT,
        parse_mode: 'HTML'
      });
    } else {
      // Пытаемся отправить через локальный файл (работает только для файлов < 50 МБ)
      const videoInput = Input.fromLocalFile(VIDEO_CACHE_PATH);
      await bot.telegram.sendVideo(telegramId, videoInput, {
        caption: MESSAGE_TEXT,
        parse_mode: 'HTML'
      });
    }
    return { success: true };
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
  
  // Скачиваем видео перед началом рассылки (только если нет file_id)
  if (!VIDEO_FILE_ID) {
    try {
      await ensureVideoDownloaded();
    } catch (error) {
      console.error('Ошибка при скачивании видео:', error.message);
      process.exit(1);
    }
  }
  
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
      
      const result = await sendVideoToUser(adminId);
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
    const result = await sendVideoToUser(telegramId);
    
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

