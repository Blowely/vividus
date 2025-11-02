-- Скрипт для отключения всех триггеров логирования на сервере
-- Выполните: docker compose exec postgres psql -U postgres -d vividus -f /tmp/disable_logging.sql

DROP TRIGGER IF EXISTS log_users_activity ON users;
DROP TRIGGER IF EXISTS log_users_activity_delete ON users;
DROP TRIGGER IF EXISTS log_orders_activity ON orders;
DROP TRIGGER IF EXISTS log_payments_activity ON payments;
DROP TRIGGER IF EXISTS log_did_jobs_activity ON did_jobs;
DROP TRIGGER IF EXISTS log_campaigns_activity ON campaigns;
DROP TRIGGER IF EXISTS log_campaign_stats_activity ON campaign_stats;

