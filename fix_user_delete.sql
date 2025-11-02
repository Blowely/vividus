-- Исправление удаления пользователей: пересоздание constraint и функции
-- Выполните этот скрипт на сервере через: docker compose exec postgres psql -U postgres -d vividus -f /tmp/fix_user_delete.sql

-- 1. Удаляем старый constraint
ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_user_id_fkey;

-- 2. Создаем constraint как DEFERRABLE INITIALLY DEFERRED (отложенная проверка)
ALTER TABLE activity_logs 
ADD CONSTRAINT activity_logs_user_id_fkey 
FOREIGN KEY (user_id) 
REFERENCES users(id) 
ON DELETE SET NULL
DEFERRABLE INITIALLY DEFERRED;

-- 3. Обновляем функцию log_activity()
CREATE OR REPLACE FUNCTION log_activity()
RETURNS TRIGGER AS $$
DECLARE
    old_json JSONB;
    new_json JSONB;
    changed_fields TEXT[];
    key TEXT;
    record_id_val VARCHAR(255);
    user_id_val INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'users' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        IF TG_OP = 'DELETE' THEN
            user_id_val := NULL;
        ELSE
            user_id_val := COALESCE(NEW.id, OLD.id);
        END IF;
    ELSIF TG_TABLE_NAME = 'orders' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        user_id_val := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_TABLE_NAME = 'payments' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        user_id_val := COALESCE(NEW.user_id, OLD.user_id);
    ELSIF TG_TABLE_NAME = 'did_jobs' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
            SELECT o.user_id INTO user_id_val FROM orders o WHERE o.id = NEW.order_id;
        ELSIF TG_OP = 'DELETE' THEN
            SELECT o.user_id INTO user_id_val FROM orders o WHERE o.id = OLD.order_id;
        END IF;
    ELSIF TG_TABLE_NAME = 'campaigns' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        user_id_val := NULL;
    ELSIF TG_TABLE_NAME = 'campaign_stats' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        user_id_val := NULL;
    ELSE
        record_id_val := 'unknown';
        user_id_val := NULL;
    END IF;

    IF TG_OP = 'INSERT' THEN
        new_json := to_jsonb(NEW);
        INSERT INTO activity_logs (table_name, record_id, user_id, action, new_data)
        VALUES (TG_TABLE_NAME, record_id_val, user_id_val, 'INSERT', new_json);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        old_json := to_jsonb(OLD);
        new_json := to_jsonb(NEW);
        changed_fields := ARRAY[]::TEXT[];
        FOR key IN SELECT jsonb_object_keys(new_json) LOOP
            IF old_json->key IS DISTINCT FROM new_json->key THEN
                changed_fields := array_append(changed_fields, key);
            END IF;
        END LOOP;
        INSERT INTO activity_logs (table_name, record_id, user_id, action, old_data, new_data, changed_fields)
        VALUES (TG_TABLE_NAME, record_id_val, user_id_val, 'UPDATE', old_json, new_json, changed_fields);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        old_json := to_jsonb(OLD);
        IF TG_TABLE_NAME = 'users' THEN
            INSERT INTO activity_logs (table_name, record_id, user_id, action, old_data)
            VALUES (TG_TABLE_NAME, record_id_val, NULL, 'DELETE', old_json);
        ELSE
            INSERT INTO activity_logs (table_name, record_id, user_id, action, old_data)
            VALUES (TG_TABLE_NAME, record_id_val, user_id_val, 'DELETE', old_json);
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

