# Настройка SSL для админ-панели

## Шаги настройки:

### Вариант 1: Certbot автоматически настроит SSL (рекомендуется)

1. **Установите временную конфигурацию (БЕЗ HTTPS редиректа):**

```bash
sudo cp /root/vividus/nginx-admin-temp.conf /etc/nginx/sites-available/bots-panel.re-poizon.ru
sudo ln -s /etc/nginx/sites-available/bots-panel.re-poizon.ru /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

2. **Получите SSL сертификат через certbot (он автоматически добавит SSL в конфиг):**

```bash
sudo certbot --nginx -d bots-panel.re-poizon.ru
```

Certbot автоматически:
- Получит сертификат
- Обновит конфигурацию nginx
- Добавит редирект HTTP → HTTPS
- Настроит SSL параметры

3. **Проверьте конфигурацию:**

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Вариант 2: Использовать готовую конфигурацию с SSL

Если у вас уже есть сертификат или вы хотите использовать готовую конфигурацию:

1. **Установите конфигурацию с SSL:**

```bash
sudo cp /root/vividus/nginx-admin.conf /etc/nginx/sites-available/bots-panel.re-poizon.ru
sudo ln -s /etc/nginx/sites-available/bots-panel.re-poizon.ru /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

2. **Получите сертификат (certbot обновит существующий конфиг):**

```bash
sudo certbot --nginx -d bots-panel.re-poizon.ru
```

4. **Проверьте автоматическое обновление сертификата:**

```bash
sudo certbot renew --dry-run
```

## Автоматическое обновление:

Certbot обычно уже настроен через cron/systemd timer. Проверьте:

```bash
sudo systemctl status certbot.timer
```

Если не настроено, добавьте в crontab:
```bash
sudo crontab -e
# Добавьте строку:
0 0,12 * * * certbot renew --quiet
```

## Проверка SSL:

Откройте в браузере: `https://bots-panel.re-poizon.ru`

