-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    start_param VARCHAR(255),
    email VARCHAR(255),
    generations INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create orders table
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    original_file_path VARCHAR(500) NOT NULL,
    did_job_id VARCHAR(255),
    custom_prompt TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create payments table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    yoomoney_payment_id VARCHAR(255),
    amount DECIMAL(10,2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create did_jobs table
CREATE TABLE IF NOT EXISTS did_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    did_job_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    result_url TEXT,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_generations ON users(generations);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_did_jobs_order_id ON did_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_did_jobs_did_job_id ON did_jobs(did_job_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at BEFORE UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payments_updated_at BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_did_jobs_updated_at BEFORE UPDATE ON did_jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create analytics tables for tracking campaign performance
CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_stats (
    id SERIAL PRIMARY KEY,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    users_count INTEGER DEFAULT 0,
    total_payments_rub DECIMAL(12,2) DEFAULT 0.00,
    total_payments_stars INTEGER DEFAULT 0,
    completed_orders INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(campaign_id, date)
);

-- Drop price and payment_id columns from orders table if they exist (for existing databases)
ALTER TABLE orders DROP COLUMN IF EXISTS price;
ALTER TABLE orders DROP COLUMN IF EXISTS payment_id;

-- Add support for merge mode (combining two images)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS second_file_path VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(50) DEFAULT 'single';

-- Create trigger for campaign_stats
CREATE TRIGGER update_campaign_stats_updated_at BEFORE UPDATE ON campaign_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create activity_logs table for tracking all database changes
CREATE TABLE IF NOT EXISTS activity_logs (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    record_id VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL, -- 'INSERT', 'UPDATE', 'DELETE'
    old_data JSONB,
    new_data JSONB,
    changed_fields TEXT[], -- Array of field names that changed
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Убеждаемся, что user_id может быть NULL
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'activity_logs') THEN
        -- Изменяем constraint если он существует и не позволяет NULL или не является DEFERRABLE
        IF EXISTS (SELECT FROM pg_constraint WHERE conname = 'activity_logs_user_id_fkey') THEN
            ALTER TABLE activity_logs DROP CONSTRAINT activity_logs_user_id_fkey;
        END IF;
        ALTER TABLE activity_logs 
        ADD CONSTRAINT activity_logs_user_id_fkey 
        FOREIGN KEY (user_id) 
        REFERENCES users(id) 
        ON DELETE SET NULL
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- Add user_id column if table exists but column doesn't (for existing installations)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'activity_logs') THEN
        IF NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'activity_logs' AND column_name = 'user_id') THEN
            ALTER TABLE activity_logs ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        END IF;
    END IF;
END $$;

-- Create indexes for activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_table_name ON activity_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_activity_logs_record_id ON activity_logs(record_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC);

-- Function to log activity
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
    -- Determine record ID and user_id based on table
    IF TG_TABLE_NAME = 'users' THEN
        record_id_val := COALESCE(NEW.id::TEXT, OLD.id::TEXT);
        -- Для DELETE операций на users устанавливаем user_id в NULL
        -- ID пользователя будет сохранён в old_data
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
        -- Для did_jobs нужно найти user_id через order_id
        IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
            SELECT o.user_id INTO user_id_val
            FROM orders o
            WHERE o.id = NEW.order_id;
        ELSIF TG_OP = 'DELETE' THEN
            SELECT o.user_id INTO user_id_val
            FROM orders o
            WHERE o.id = OLD.order_id;
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
        -- Convert NEW row to JSONB
        new_json := to_jsonb(NEW);
        
        INSERT INTO activity_logs (table_name, record_id, user_id, action, new_data)
        VALUES (TG_TABLE_NAME, record_id_val, user_id_val, 'INSERT', new_json);
        
        RETURN NEW;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Convert OLD and NEW rows to JSONB
        old_json := to_jsonb(OLD);
        new_json := to_jsonb(NEW);
        
        -- Find changed fields
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
        -- Convert OLD row to JSONB
        old_json := to_jsonb(OLD);
        
        -- Для DELETE операций на users явно используем NULL
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

-- Create triggers for all tables (drop if exists to allow re-running migration)
-- Примечание: для users не создаем триггер на DELETE, чтобы избежать проблем с foreign key constraint
-- Функция log_activity() уже настроена на установку user_id = NULL для DELETE операций на users
DROP TRIGGER IF EXISTS log_users_activity ON users;
DROP TRIGGER IF EXISTS log_users_activity_delete ON users;
CREATE TRIGGER log_users_activity
    AFTER INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION log_activity();
-- DELETE триггер не создаем для users, удаление пользователей логируется через каскадное удаление связанных записей

DROP TRIGGER IF EXISTS log_orders_activity ON orders;
CREATE TRIGGER log_orders_activity
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION log_activity();

DROP TRIGGER IF EXISTS log_payments_activity ON payments;
CREATE TRIGGER log_payments_activity
    AFTER INSERT OR UPDATE OR DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION log_activity();

DROP TRIGGER IF EXISTS log_did_jobs_activity ON did_jobs;
CREATE TRIGGER log_did_jobs_activity
    AFTER INSERT OR UPDATE OR DELETE ON did_jobs
    FOR EACH ROW EXECUTE FUNCTION log_activity();

DROP TRIGGER IF EXISTS log_campaigns_activity ON campaigns;
CREATE TRIGGER log_campaigns_activity
    AFTER INSERT OR UPDATE OR DELETE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION log_activity();

DROP TRIGGER IF EXISTS log_campaign_stats_activity ON campaign_stats;
CREATE TRIGGER log_campaign_stats_activity
    AFTER INSERT OR UPDATE OR DELETE ON campaign_stats
    FOR EACH ROW EXECUTE FUNCTION log_activity();

-- Add model column to did_jobs table for tracking which Runway model was used
ALTER TABLE did_jobs ADD COLUMN IF NOT EXISTS model VARCHAR(50);
