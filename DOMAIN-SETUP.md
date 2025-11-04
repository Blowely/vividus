# Настройка домена vividusgo.ru для оферты

## Что было сделано

1. ✅ Создана HTML страница оферты в `public/offer.html`
2. ✅ Добавлены маршруты в веб-сервер для отдачи оферты
3. ✅ Настроена автоматическая отдача оферты на домене `vividusgo.ru`

## Настройка DNS

Вам нужно настроить DNS записи для домена `vividusgo.ru`:

### Вариант 1: Прямой A-запись (если у вас статический IP)

```
Тип: A
Имя: @
Значение: [IP адрес вашего сервера]
TTL: 3600
```

### Вариант 2: Через поддомен (рекомендуется)

```
Тип: A
Имя: www
Значение: [IP адрес вашего сервера]
TTL: 3600
```

## Настройка Nginx (если используется)

Если вы используете Nginx как reverse proxy, добавьте конфигурацию:

```nginx
server {
    listen 80;
    server_name vividusgo.ru www.vividusgo.ru;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Настройка SSL (HTTPS)

Рекомендуется настроить SSL сертификат через Let's Encrypt:

```bash
# Установите certbot
sudo apt-get install certbot python3-certbot-nginx

# Получите сертификат
sudo certbot --nginx -d vividusgo.ru -d www.vividusgo.ru
```

## Доступ к оферте

После настройки DNS оферта будет доступна по адресам:
- `https://vividusgo.ru/` - главная страница (автоматически показывает оферту)
- `https://vividusgo.ru/offer` - прямой доступ к оферте
- `https://vividusgo.ru/offer.html` - прямой доступ к оферте

## Проверка

После настройки DNS подождите 5-15 минут для распространения DNS записей, затем проверьте:

```bash
# Проверка DNS
nslookup vividusgo.ru

# Проверка доступности
curl -I https://vividusgo.ru/
```

## Примечания

- Сервер уже настроен на автоматическое определение домена и отдачу оферты
- Если домен не `vividusgo.ru`, корневой путь `/` вернет JSON статус
- Оферта всегда доступна по `/offer` и `/offer.html` независимо от домена
