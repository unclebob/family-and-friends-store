-- When an item was added, and when family were told about it.
-- Items that exist before this migration count as already announced, so the
-- first new-items email lists only items added after it.
ALTER TABLE items ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN announced_at TEXT;
UPDATE items SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), announced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
CREATE INDEX items_unannounced ON items(announced_at, created_at);
