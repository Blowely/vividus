# Vividus Telegram Bot

Telegram бот для оживления фотографий с помощью нейросети RunwayML и интеграцией платежной системы ЮMoney.

## 🚀 Функционал

- 📸 Обработка фотографий через RunwayML API
- 💳 Интеграция с ЮMoney для платежей
- 🗄️ PostgreSQL для хранения данных
- ⚡ Redis для кеширования
- 📁 Локальное файловое хранилище

## 📋 Требования

- Node.js 18+
- PostgreSQL 13+
- Redis 6+ (опционально)

## 🛠️ Установка

1. Клонируйте репозиторий:
```bash
git clone <repository-url>
cd vividus
```

2. Установите зависимости:
```bash
npm install
```

3. Настройте переменные окружения:
```bash
cp env.example .env
```

4. Настройте базу данных:
```bash
# Создайте базу данных PostgreSQL
createdb vividus

# Запустите миграции
psql -d vividus -f src/database/migrations/001_initial_schema.sql
```

5. Запустите бота:
```bash
# Разработка
npm run dev

# Продакшн
npm run build
npm start
```

## ⚙️ Конфигурация

### Переменные окружения

```env
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=vividus
DB_USER=postgres
DB_PASSWORD=password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# RunwayML API
RUNWAY_API_KEY=your_runway_api_key

# YooMoney
YOOMONEY_RECEIVER_ID=your_receiver_id
YOOMONEY_ACCESS_TOKEN=your_access_token

# File Storage
STORAGE_PATH=./uploads
MAX_FILE_SIZE=10485760
```

## 🔧 API Endpoints

### Webhook endpoints

- `POST /webhook/yoomoney` - Webhook для уведомлений о платежах
- `POST /webhook/runway` - Webhook для статуса обработки видео
- `GET /health` - Проверка состояния сервера

## 📱 Использование

1. Отправьте боту команду `/start`
2. Отправьте фото для обработки
3. Оплатите заказ через ЮMoney
4. Получите анимированное видео

## 🏗️ Архитектура

```
src/
├── config/          # Конфигурация БД и Redis
├── database/        # Миграции и схемы
├── services/        # Бизнес-логика
│   ├── telegram.ts  # Telegram Bot API
│   ├── runway.ts    # RunwayML API
│   ├── payment.ts   # ЮMoney API
│   ├── file.ts      # Файловое хранилище
│   └── processor.ts # Обработка заказов
├── webhook/         # Webhook сервер
└── types/           # TypeScript типы
```

## 🚀 Развертывание

### Docker (рекомендуется)

```bash
docker-compose up -d
```

### VPS

1. Установите Node.js, PostgreSQL, Redis
2. Настройте переменные окружения
3. Запустите миграции
4. Запустите бота: `npm start`

## 📊 Мониторинг

- Логи: `console.log` в консоли
- База данных: PostgreSQL логи
- Redis: Redis CLI для мониторинга

## 🔒 Безопасность

- Все файлы загружаются в изолированную директорию
- Автоматическая очистка старых файлов
- Валидация размера файлов
- Защита от SQL-инъекций через параметризованные запросы

## 📈 Масштабирование

- Горизонтальное масштабирование через несколько инстансов
- Redis для кеширования сессий
- PostgreSQL для надежного хранения данных
- Асинхронная обработка заказов

## 🐛 Отладка

```bash
# Логи в режиме разработки
npm run dev

# Проверка состояния
curl http://localhost:3000/health
```

## 📞 Поддержка

При возникновении проблем проверьте:
1. Логи приложения
2. Состояние базы данных
3. Подключение к внешним API
4. Настройки переменных окружения
