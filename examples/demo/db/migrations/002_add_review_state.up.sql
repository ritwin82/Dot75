ALTER TABLE orders
ADD COLUMN review_state text NOT NULL DEFAULT 'pending';
