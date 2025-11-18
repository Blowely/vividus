-- Add support for combine_and_animate mode
ALTER TABLE orders ADD COLUMN IF NOT EXISTS combine_prompt TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS animation_prompt TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS combine_type VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS animation_type VARCHAR(50);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference_images TEXT; -- JSON array of image URLs
ALTER TABLE orders ADD COLUMN IF NOT EXISTS combined_image_path VARCHAR(500);


