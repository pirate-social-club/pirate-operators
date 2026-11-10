-- Feature schema proposal, not a migration ordinal. Coordinator applies in order.
CREATE TABLE dance_captures (
  capture_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(community_id,account_id,command_id)
);
CREATE TABLE dance_reviews (
  review_id TEXT PRIMARY KEY REFERENCES dance_captures(capture_id),
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE,
  media_revision INTEGER NOT NULL,
  recording_digest TEXT NOT NULL,
  uploaded_at_ms INTEGER NOT NULL,
  submitted_at_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('pending','reviewed','withdrawn','expired')),
  terminal_at_ms INTEGER,
  UNIQUE(community_id,recording_digest)
);
CREATE INDEX dance_review_queue ON dance_reviews(community_id,state,submitted_at_ms,review_id);
CREATE TABLE dance_verdicts (
  review_id TEXT PRIMARY KEY REFERENCES dance_reviews(review_id),
  verdict_json TEXT NOT NULL CHECK(json_valid(verdict_json)),
  committed_at_ms INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL
);
CREATE TABLE dance_receipts (
  community_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  PRIMARY KEY(community_id,actor_id,command_id)
);
CREATE TABLE dance_delegations (
  delegation_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  owner_assignment TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);
CREATE INDEX dance_delegated_review ON dance_delegations(community_id,account_id);
CREATE TABLE dance_delegation_audit (
  community_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('grant','revoke')),
  at_ms INTEGER NOT NULL,
  PRIMARY KEY(community_id,actor_id,command_id)
);
CREATE TABLE dance_transaction_guards (
  guard_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid = 1)
);
CREATE TRIGGER dance_verdict_no_update BEFORE UPDATE ON dance_verdicts
BEGIN SELECT RAISE(ABORT,'dance_verdict_immutable'); END;
CREATE TRIGGER dance_verdict_no_delete BEFORE DELETE ON dance_verdicts
BEGIN SELECT RAISE(ABORT,'dance_verdict_immutable'); END;
CREATE TRIGGER dance_receipt_no_update BEFORE UPDATE ON dance_receipts
BEGIN SELECT RAISE(ABORT,'dance_receipt_immutable'); END;
CREATE TRIGGER dance_receipt_no_delete BEFORE DELETE ON dance_receipts
BEGIN SELECT RAISE(ABORT,'dance_receipt_immutable'); END;
CREATE TRIGGER dance_capture_no_update BEFORE UPDATE ON dance_captures
BEGIN SELECT RAISE(ABORT,'dance_capture_immutable'); END;
CREATE TRIGGER dance_capture_no_delete BEFORE DELETE ON dance_captures
BEGIN SELECT RAISE(ABORT,'dance_capture_immutable'); END;
CREATE TRIGGER dance_audit_no_update BEFORE UPDATE ON dance_delegation_audit
BEGIN SELECT RAISE(ABORT,'dance_audit_immutable'); END;
CREATE TRIGGER dance_audit_no_delete BEFORE DELETE ON dance_delegation_audit
BEGIN SELECT RAISE(ABORT,'dance_audit_immutable'); END;
