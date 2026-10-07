// No capability plaintext, names as keys, personal chat data, or provider session columns.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), group_id TEXT NOT NULL,
  group_name TEXT NOT NULL, operations INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL, day_mutations INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrollments (
  position INTEGER PRIMARY KEY AUTOINCREMENT, member_id TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL UNIQUE, credential_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
  invite_id TEXT, confirmation_hash TEXT
);
CREATE INDEX IF NOT EXISTS enrollment_state ON enrollments(state,position);
CREATE TABLE IF NOT EXISTS invitations (
  invite_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE,
  issuer_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','consumed','revoked'))
);
CREATE INDEX IF NOT EXISTS invitation_state_expiry ON invitations(state,expires_at);
CREATE TABLE IF NOT EXISTS receipts (
  credential_hash TEXT NOT NULL, operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, response TEXT NOT NULL,
  PRIMARY KEY(credential_hash,operation_id)
);
CREATE TABLE IF NOT EXISTS audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  actor_installation_id TEXT NOT NULL, target_id TEXT NOT NULL, recorded_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT,'append only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT,'append only'); END;
`;
