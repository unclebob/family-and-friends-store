-- Family can wish for an item now or someday. Existing wishes are "now".
ALTER TABLE wishes ADD COLUMN kind TEXT NOT NULL DEFAULT 'now' CHECK (kind IN ('now', 'someday'));
