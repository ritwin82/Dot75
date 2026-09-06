ALTER TABLE orders ADD COLUMN archived_at timestamptz;
CREATE INDEX orders_active_idx ON orders(id) WHERE status <> 'cancelled';
