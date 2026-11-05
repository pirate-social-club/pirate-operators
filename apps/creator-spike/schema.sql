PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, account TEXT NOT NULL,
  origin TEXT NOT NULL, state TEXT NOT NULL, verifier_hash TEXT NOT NULL,
  expires INTEGER NOT NULL, credential_id TEXT, code_hash TEXT UNIQUE, consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, cose_key TEXT NOT NULL, counter INTEGER NOT NULL,
  sui_public_key TEXT NOT NULL, sui_address TEXT NOT NULL UNIQUE,
  sealed_seed TEXT NOT NULL, created INTEGER NOT NULL, authenticated_at INTEGER, activated_at INTEGER,
  dwallet_id TEXT, cap_id TEXT, share_id TEXT, evm_public_key TEXT, evm_address TEXT,
  status TEXT NOT NULL DEFAULT 'saved'
);
CREATE TABLE IF NOT EXISTS bindings (
  account TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, account TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES credentials(id),
  status TEXT NOT NULL DEFAULT 'reserved', intent TEXT NOT NULL, created INTEGER NOT NULL,
  dwallet_id TEXT, cap_id TEXT, share_id TEXT, dkg_digest TEXT, acceptance_digest TEXT, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_attempt ON attempts(account) WHERE status <> 'failed';
CREATE UNIQUE INDEX IF NOT EXISTS one_credential_attempt ON attempts(credential_id) WHERE status <> 'failed';
CREATE TRIGGER IF NOT EXISTS attempt_budget BEFORE INSERT ON attempts BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM attempts WHERE account = NEW.account AND created > NEW.created - 86400000) >= 3
    THEN RAISE(ABORT, 'account_attempt_limit') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM attempts WHERE created > NEW.created - 86400000) >= 3
    THEN RAISE(ABORT, 'operator_daily_attempt_limit') END;
END;
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), kind TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE, bytes TEXT NOT NULL, signatures TEXT NOT NULL,
  status TEXT NOT NULL, receipt TEXT, created INTEGER NOT NULL,
  UNIQUE(attempt_id, kind)
);
CREATE TABLE IF NOT EXISTS operator_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY, credential_id TEXT NOT NULL REFERENCES credentials(id),
  message TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
  presign_id TEXT, presign_cap_id TEXT, ika_coin_id TEXT, sui_coin_id TEXT,
  transaction_bytes TEXT, transaction_digest TEXT, sign_id TEXT, result TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_test_signature ON signatures(credential_id);
CREATE TABLE IF NOT EXISTS signature_preparations (
  signature_id TEXT PRIMARY KEY REFERENCES signatures(id),
  submission_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK(phase IN ('building','prepared','submitting','expired')),
  token TEXT NOT NULL,
  expires INTEGER NOT NULL,
  user_signature TEXT
);
CREATE INDEX IF NOT EXISTS signature_preparation_expiry ON signature_preparations(expires);
CREATE TABLE IF NOT EXISTS activation_recovery (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  payload_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE creator_request_nonces (
  community_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  wire_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, nonce)
);
CREATE TABLE scoped_creator_connections (
  request_id TEXT PRIMARY KEY REFERENCES links(id),
  community_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  ready_at INTEGER,
  receipt_json TEXT,
  UNIQUE(community_id, connection_id)
);
CREATE TABLE scoped_creator_claims (
  community_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, account_ref),
  UNIQUE(community_id, credential_id)
);
