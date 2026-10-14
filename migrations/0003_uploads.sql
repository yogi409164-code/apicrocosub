CREATE TABLE IF NOT EXISTS uploads (
  path TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  path TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (path, idx)
);

CREATE INDEX IF NOT EXISTS ix_juices_archived ON juices (archived, created_at);
CREATE INDEX IF NOT EXISTS ix_plan_requests_user ON plan_requests (user_id, status);
CREATE INDEX IF NOT EXISTS ix_juice_orders_user ON juice_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_support_messages_ticket ON support_messages (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ix_saved_addresses_user ON saved_addresses (user_id);
