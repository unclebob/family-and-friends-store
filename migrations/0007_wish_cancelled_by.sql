-- An admin can cancel a wish. It becomes 'withdrawn' like any other, so every
-- existing filter already treats it as gone; this column says which admin did it.
-- Wishing again clears it.
ALTER TABLE wishes ADD COLUMN cancelled_by TEXT;
