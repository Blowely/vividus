-- Add email column to users table for receipt customer information
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

