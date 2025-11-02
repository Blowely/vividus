-- Remove result_file_path column from orders table
-- Videos are now stored only in S3, no local storage needed
ALTER TABLE orders 
DROP COLUMN IF EXISTS result_file_path;

