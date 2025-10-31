-- Add user_id column to payments table for test payments
ALTER TABLE payments 
ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);

