-- =====================================================================
-- 0009 — Profiles, email verification, password reset, account lockout,
--        and refresh tokens
-- =====================================================================
-- Token design, applied identically to sessions, email verification and
-- password reset:
--
--   * The raw token is NEVER stored — only its SHA-256. A database disclosure
--     therefore yields nothing usable. SHA-256 (not Argon2) is correct because
--     these are high-entropy random values: there is nothing to brute-force.
--   * Every token has an explicit expiry, enforced in SQL rather than in
--     application code, so an expired token simply produces no row.
--   * Single-use tokens record when they were consumed, which is what makes
--     replay detectable rather than merely unlikely.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profiles. Split from `users` deliberately: `users` holds identity and
-- security state (credentials, status, lockout) while `profiles` holds
-- self-described, user-editable content. They have different sensitivity,
-- different write paths, and different authorization rules — a student may
-- freely edit their display name but must never edit their own status.
-- ---------------------------------------------------------------------
CREATE TABLE profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  full_name    text,
  avatar_url   text,
  bio          text NOT NULL DEFAULT '',
  -- Free-form UI preferences. JSON is appropriate here: the shape is genuinely
  -- open-ended and nothing authorizes against it. It is size-capped so it
  -- cannot become a storage abuse vector.
  preferences  jsonb NOT NULL DEFAULT '{}'::jsonb,
  locale       text NOT NULL DEFAULT 'ar',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT profiles_display_name_len_ck CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT profiles_full_name_len_ck    CHECK (full_name IS NULL OR length(btrim(full_name)) BETWEEN 1 AND 200),
  CONSTRAINT profiles_bio_len_ck          CHECK (length(bio) <= 2000),
  CONSTRAINT profiles_locale_ck           CHECK (locale IN ('ar', 'en')),
  CONSTRAINT profiles_preferences_size_ck CHECK (pg_column_size(preferences) <= 8192),
  -- Avatars are referenced by URL, and an attacker-controlled scheme is an XSS
  -- and SSRF vector. Only https is permitted; no data:, no javascript:.
  CONSTRAINT profiles_avatar_scheme_ck    CHECK (avatar_url IS NULL OR avatar_url ~ '^https://')
);

-- Backfill a profile for every existing user so the two tables cannot diverge.
INSERT INTO profiles (user_id, display_name, locale)
SELECT u.id, u.display_name, u.locale FROM users u;

-- ---------------------------------------------------------------------
-- Account security state on `users`.
-- ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN email_verified_at   timestamptz,
  ADD COLUMN failed_login_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until        timestamptz,
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE users
  ADD CONSTRAINT users_failed_login_count_ck CHECK (failed_login_count >= 0);

-- Finds accounts whose lockout has expired, without scanning the table.
CREATE INDEX users_locked_until_idx ON users (locked_until) WHERE locked_until IS NOT NULL;

-- ---------------------------------------------------------------------
-- Refresh tokens live on the session row.
--
-- Per ADR 0005 (reaffirmed in Task 003) sessions stay OPAQUE and server-side:
-- the access token is short-lived, the refresh token is long-lived and rotated
-- on every use, and both are revocable instantly. `rotated_from` records the
-- chain so that REUSE OF AN ALREADY-ROTATED REFRESH TOKEN is detectable — the
-- signature of a stolen token being replayed — and the whole session family can
-- be revoked in response.
-- ---------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN refresh_token_hash   bytea,
  ADD COLUMN refresh_expires_at   timestamptz,
  ADD COLUMN refresh_rotated_at   timestamptz,
  ADD COLUMN rotated_from         uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ADD COLUMN device_label         text,
  ADD COLUMN revoked_reason       text;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_refresh_token_len_ck
    CHECK (refresh_token_hash IS NULL OR octet_length(refresh_token_hash) = 32),
  ADD CONSTRAINT sessions_refresh_pairing_ck
    CHECK ((refresh_token_hash IS NULL) = (refresh_expires_at IS NULL)),
  ADD CONSTRAINT sessions_revoked_reason_ck
    CHECK (revoked_reason IS NULL OR revoked_reason IN
      ('logout', 'logout_all', 'rotated', 'refresh_reuse_detected',
       'password_changed', 'admin_revoked', 'account_locked'));

CREATE UNIQUE INDEX sessions_refresh_token_hash_uk
  ON sessions (refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------
-- Single-use email verification tokens.
-- ---------------------------------------------------------------------
CREATE TABLE email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL,
  -- The address being verified is recorded, so changing an email address later
  -- cannot be confirmed by a token issued for the previous one.
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,

  CONSTRAINT email_verifications_token_len_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT email_verifications_expiry_ck    CHECK (expires_at > created_at),
  CONSTRAINT email_verifications_email_norm_ck CHECK (email = lower(email))
);

CREATE UNIQUE INDEX email_verifications_token_hash_uk ON email_verifications (token_hash);
CREATE INDEX email_verifications_user_idx ON email_verifications (user_id);

-- ---------------------------------------------------------------------
-- Single-use password reset tokens.
-- ---------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  -- Recorded for investigation: a reset requested from an unexpected address is
  -- worth seeing after an account compromise.
  requested_ip inet,

  CONSTRAINT password_reset_tokens_token_len_ck CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_reset_tokens_expiry_ck    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_uk ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- ---------------------------------------------------------------------
-- Privileges.
--
-- `edu_app` may read and update a profile (subject to RLS), but has NO direct
-- access to the token tables at all: every operation on them runs through the
-- SECURITY DEFINER functions in 0010, which enforce single use and expiry in
-- SQL. That keeps "was this token already used?" impossible to get wrong in
-- application code.
-- ---------------------------------------------------------------------
GRANT SELECT, UPDATE ON profiles TO edu_app;
