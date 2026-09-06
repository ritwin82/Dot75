ALTER TABLE orders ALTER COLUMN status TYPE text USING status::text;
DROP TYPE order_state;
