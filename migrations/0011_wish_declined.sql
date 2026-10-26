-- When an item is accepted for one wisher, the other active wishes on that item
-- become 'declined' rather than staying 'active'.
CREATE TABLE wishes_new (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn', 'accepted', 'declined')),
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'now' CHECK (kind IN ('now', 'someday')),
  cancelled_by TEXT,
  UNIQUE (item_id, email)
);

INSERT INTO wishes_new (id, item_id, email, name, grp, status, updated_at, created_at, kind, cancelled_by)
SELECT id, item_id, email, name, grp, status, updated_at, created_at, kind, cancelled_by FROM wishes;

DROP TABLE wishes;
ALTER TABLE wishes_new RENAME TO wishes;

CREATE INDEX wishes_item_status ON wishes(item_id, status);
CREATE INDEX wishes_created_at ON wishes(created_at);

UPDATE wishes SET
  status = 'declined',
  updated_at = COALESCE((SELECT accepted_at FROM items WHERE id = wishes.item_id), updated_at)
WHERE status = 'active'
  AND EXISTS (SELECT 1 FROM items WHERE id = wishes.item_id AND status != 'open');
