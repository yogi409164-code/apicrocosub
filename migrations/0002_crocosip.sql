CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  pages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  photo TEXT,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  provider TEXT NOT NULL DEFAULT 'password',
  role TEXT NOT NULL DEFAULT 'customer',
  location_lat REAL,
  location_lng REAL,
  location_address TEXT,
  location_locality TEXT,
  special_access INTEGER NOT NULL DEFAULT 0,
  special_lat REAL,
  special_lng REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT NOT NULL,
  locality TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS juices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Juices',
  sku TEXT,
  price REAL NOT NULL DEFAULT 0,
  description TEXT,
  image_url TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  in_poster INTEGER NOT NULL DEFAULT 0,
  in_plans INTEGER NOT NULL DEFAULT 1,
  offer_percent REAL NOT NULL DEFAULT 0,
  ml INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS juice_categories (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS store_settings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'CrocoSip Store',
  address TEXT NOT NULL DEFAULT '',
  locality TEXT NOT NULL DEFAULT '',
  latitude REAL NOT NULL DEFAULT 12.9716,
  longitude REAL NOT NULL DEFAULT 77.5946,
  distance_km REAL NOT NULL DEFAULT 10,
  custom_discount_percent REAL NOT NULL DEFAULT 20,
  cart_min_order REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'days',
  price TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#FF7A00',
  image TEXT NOT NULL DEFAULT '',
  bottles TEXT NOT NULL DEFAULT '',
  popular INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS plan_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  price TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  bottles TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  days INTEGER,
  items TEXT NOT NULL DEFAULT '',
  upgrade_mode TEXT NOT NULL DEFAULT '',
  starts_on TEXT,
  ends_on TEXT,
  skipped_dates TEXT NOT NULL DEFAULT '[]',
  item_swaps TEXT NOT NULL DEFAULT '{}',
  slot_order TEXT NOT NULL DEFAULT '[]',
  delivery_lat REAL,
  delivery_lng REAL,
  delivery_address TEXT,
  delivery_locality TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS juice_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  delivery_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'COD',
  status TEXT NOT NULL DEFAULT 'placed',
  delivery_lat REAL,
  delivery_lng REAL,
  delivery_address TEXT,
  delivery_locality TEXT,
  delivery_date TEXT,
  delivery_window TEXT NOT NULL DEFAULT '6:00 AM – 10:00 AM',
  delivery_type TEXT NOT NULL DEFAULT 'slot',
  proof_image TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  order_id TEXT,
  plan_request_id TEXT,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  started INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  closed_at TEXT,
  assignee_id TEXT,
  assignee_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS phone_otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS delivery_marks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, delivery_date)
);
