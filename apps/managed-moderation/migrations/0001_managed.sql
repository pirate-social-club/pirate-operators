PRAGMA foreign_keys = ON;
CREATE TABLE managed_admissions (
  admission_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  budget_period TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','complete','held','rejected','uncertain')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  prepared_json TEXT,
  result_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(community_id,job_id)
);
CREATE INDEX managed_admission_recovery ON managed_admissions(state,lease_until,created_at);
CREATE TABLE moderation_request_nonces (
  community_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  wire_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(community_id,nonce)
);
CREATE INDEX moderation_nonce_expiry ON moderation_request_nonces(expires_at);
CREATE TABLE moderation_provider_calls (
  call_id TEXT PRIMARY KEY,
  admission_id TEXT NOT NULL REFERENCES managed_admissions(admission_id),
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned','running','received','uncertain','validated')),
  execution_token TEXT,
  response_json TEXT,
  result_json TEXT,
  provider_id TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(admission_id,kind)
);
CREATE TABLE spending_budgets (
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  asset TEXT NOT NULL,
  ceiling TEXT NOT NULL,
  reserved TEXT NOT NULL DEFAULT '0',
  spent TEXT NOT NULL DEFAULT '0',
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope,period,asset)
);
CREATE TABLE spending_reservations (
  reservation_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  asset TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  amount TEXT NOT NULL,
  actual TEXT,
  status TEXT NOT NULL CHECK(status IN ('reserved','settled')),
  PRIMARY KEY(reservation_id,scope,period,asset),
  FOREIGN KEY(scope,period,asset) REFERENCES spending_budgets(scope,period,asset)
);
CREATE TABLE transaction_guards (guard_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
