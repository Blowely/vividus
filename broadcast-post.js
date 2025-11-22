const { Telegraf } = require('telegraf');
const { config } = require('dotenv');
const fs = require('fs');
const path = require('path');

config();

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Ошибка: TELEGRAM_BOT_TOKEN не установлен в .env файле');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Текст для рассылки
const MESSAGE_TEXT = `Сюрприз от которого замирает сердце🥹

Самое бесценное, что есть у каждого человека - это ВОСПОМНИНАНИЯ❤️

Удивите своих близких, они будут счастливы🫶🏻`;

// URL видео
const VIDEO_URL = 'https://storage.yandexcloud.net/vividus/service/broadcast01.mp4';

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

// Отправка видео пользователю
async function sendVideoToUser(telegramId) {
  try {
    await bot.telegram.sendVideo(telegramId, VIDEO_URL, {
      caption: MESSAGE_TEXT,
      parse_mode: 'HTML'
    });
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
async function broadcastPost(sqlFilePath, testMode = false, adminUsernames = null) {
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
  } else if (!args[i].startsWith('--') && !args[i].startsWith('-')) {
    // Это путь к SQL файлу
    sqlFilePath = args[i];
  }
}

if (!fs.existsSync(sqlFilePath)) {
  console.error(`Файл не найден: ${sqlFilePath}`);
  process.exit(1);
}

broadcastPost(sqlFilePath, testMode, adminUsernames)
  .then(() => {
    console.log('\nРассылка завершена');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Критическая ошибка:', error);
    process.exit(1);
  });

