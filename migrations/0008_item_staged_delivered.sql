-- An accepted item moves to 'staged' when boxed for the recipient, and to
-- 'delivered' once handed over. Recreate items and its child tables in dependency
-- order so foreign keys stay satisfied in both local and remote D1.
CREATE TABLE photos_saved AS SELECT id, item_id, r2_key, sort_order FROM photos;
CREATE TABLE wishes_saved AS SELECT id, item_id, email, name, grp, status, updated_at, created_at, kind, cancelled_by FROM wishes;

DROP TABLE photos;
DROP TABLE wishes;

CREATE TABLE items_new (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'staged', 'delivered', 'removed')),
  assigned_to TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  announced_at TEXT,
  CHECK (price_cents IS NULL OR price_cents >= 0)
);

INSERT INTO items_new (id, topic_id, title, description, price_cents, status, assigned_to, accepted_by, accepted_at, created_at, announced_at)
SELECT id, topic_id, title, description, price_cents, status, assigned_to, accepted_by, accepted_at, created_at, announced_at FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE INDEX items_topic_status ON items(topic_id, status);
CREATE INDEX items_unannounced ON items(announced_at, created_at);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  r2_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO photos (id, item_id, r2_key, sort_order)
SELECT id, item_id, r2_key, sort_order FROM photos_saved;

DROP TABLE photos_saved;

CREATE TABLE wishes (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn', 'accepted')),
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'now' CHECK (kind IN ('now', 'someday')),
  cancelled_by TEXT,
  UNIQUE (item_id, email)
);

INSERT INTO wishes (id, item_id, email, name, grp, status, updated_at, created_at, kind, cancelled_by)
SELECT id, item_id, email, name, grp, status, updated_at, created_at, kind, cancelled_by FROM wishes_saved;

DROP TABLE wishes_saved;

CREATE INDEX wishes_item_status ON wishes(item_id, status);
CREATE INDEX wishes_created_at ON wishes(created_at);
