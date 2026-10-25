CREATE TABLE topics (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'removed')),
  assigned_to TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  CHECK (price_cents IS NULL OR price_cents >= 0)
);

CREATE INDEX items_topic_status ON items(topic_id, status);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  r2_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE wishes (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn', 'accepted')),
  updated_at TEXT NOT NULL,
  UNIQUE (item_id, email)
);

CREATE INDEX wishes_item_status ON wishes(item_id, status);

CREATE TABLE login_codes (
  email TEXT NOT NULL,
  host TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, host)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  grp TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  host TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE pending_merit_log (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
