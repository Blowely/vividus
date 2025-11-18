-- Add is_deleted flag to campaigns table for soft delete
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE NOT NULL;

-- Убеждаемся, что все существующие кампании имеют is_deleted = false
UPDATE campaigns SET is_deleted = false WHERE is_deleted IS NULL OR is_deleted = true;

-- Create index for faster filtering
CREATE INDEX IF NOT EXISTS idx_campaigns_is_deleted ON campaigns(is_deleted);

