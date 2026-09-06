CREATE TYPE order_state AS ENUM ('created','paid','cancelled');
ALTER TABLE orders ALTER COLUMN status TYPE order_state USING status::order_state;
