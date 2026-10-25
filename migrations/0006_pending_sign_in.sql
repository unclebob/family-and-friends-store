-- A phone-number sign-in is remembered by an opaque id, so the browser never holds the email.
ALTER TABLE login_codes ADD COLUMN pending_id TEXT;
CREATE UNIQUE INDEX login_codes_pending ON login_codes (pending_id);
