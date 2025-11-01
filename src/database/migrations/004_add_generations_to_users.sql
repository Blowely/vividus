-- Add generations column to users table for prepaid generation credits
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS generations INTEGER DEFAULT 0 NOT NULL;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_users_generations ON users(generations);

