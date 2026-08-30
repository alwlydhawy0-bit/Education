-- =====================================================================
-- 0004 — Audit log
-- =====================================================================
-- Append-only from the application's point of view. `edu_app` is granted INSERT
-- and nothing else: it cannot read the log back, cannot amend an entry, and
-- cannot delete one. An attacker who achieves arbitrary query execution through
-- the application role therefore cannot erase their own trail, and cannot mine
-- the audit log for other users' activity.
--
-- Reading the log is an operator action performed with a separate role that
-- does not exist yet — see docs/security/observability.md.
-- =====================================================================

CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type     text NOT NULL,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  correlation_id text NOT NULL,
  ip             inet,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_log_event_type_len_ck CHECK (length(event_type) BETWEEN 1 AND 100),
  CONSTRAINT audit_log_correlation_len_ck CHECK (length(correlation_id) BETWEEN 1 AND 100),
  -- Bounds a log-flooding attack via oversized detail payloads.
  CONSTRAINT audit_log_detail_size_ck CHECK (pg_column_size(detail) <= 8192)
);

CREATE INDEX audit_log_actor_time_idx ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX audit_log_type_time_idx  ON audit_log (event_type, occurred_at DESC);

GRANT INSERT ON audit_log TO edu_app;
REVOKE SELECT, UPDATE, DELETE ON audit_log FROM edu_app;
