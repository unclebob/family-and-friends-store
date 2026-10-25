-- When a wish was made. Wishes made before this column existed take their
-- last change as the best available guess.
ALTER TABLE wishes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
UPDATE wishes SET created_at = updated_at;
CREATE INDEX wishes_created_at ON wishes(created_at);
