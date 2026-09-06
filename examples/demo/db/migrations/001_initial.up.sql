CREATE TABLE users (id bigint PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE orders (id bigint PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
