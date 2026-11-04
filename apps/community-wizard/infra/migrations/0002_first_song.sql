PRAGMA foreign_keys = ON;

CREATE TABLE application_identity (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  community_id TEXT NOT NULL,
  community_origin TEXT NOT NULL
);
CREATE TABLE community_accounts (
  account_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE credential_bindings (
  binding_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  namespace TEXT NOT NULL CHECK(namespace = 'moss'),
  network INTEGER NOT NULL CHECK(network = 6343),
  subject TEXT NOT NULL CHECK(subject = lower(subject)),
  created_at INTEGER NOT NULL,
  UNIQUE(namespace, network, subject)
);
CREATE INDEX credential_accounts ON credential_bindings(account_id);
CREATE TABLE login_challenges (
  challenge_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  community_origin TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE INDEX login_challenge_expiry ON login_challenges(expires_at);
CREATE TABLE community_sessions (
  session_hash TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  community_origin TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  binding_id TEXT NOT NULL REFERENCES credential_bindings(binding_id),
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX session_expiry ON community_sessions(expires_at);
CREATE TABLE creator_connections (
  connection_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  session_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  request_id TEXT UNIQUE,
  receipt_json TEXT,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE INDEX creator_connection_account ON creator_connections(account_id, expires_at);
CREATE TABLE creator_bindings (
  account_id TEXT PRIMARY KEY REFERENCES community_accounts(account_id),
  service_origin TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  sui_address TEXT NOT NULL,
  dwallet_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  evm_address TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  UNIQUE(service_origin, credential_ref)
);

CREATE TABLE media_submissions (
  submission_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  author_id TEXT NOT NULL,
  post_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  captured_wallet TEXT NOT NULL,
  creator_json TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_bytes INTEGER NOT NULL CHECK(audio_bytes BETWEEN 1 AND 26214400),
  object_key TEXT NOT NULL UNIQUE,
  upload_state TEXT NOT NULL CHECK(upload_state IN ('reserved','uploading','uploaded','sealed')),
  upload_lease TEXT,
  upload_lease_until INTEGER NOT NULL DEFAULT 0,
  object_etag TEXT,
  created_at INTEGER NOT NULL,
  sealed_at INTEGER,
  UNIQUE(account_id, idempotency_key)
);
CREATE INDEX submission_account_page ON media_submissions(account_id, created_at, submission_id);
CREATE TABLE publication_jobs (
  job_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES media_submissions(submission_id),
  input_hash TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN (
    'admission','pin_audio','pin_lyrics','registration','pin_manifest','publication',
    'published','held','blocked','needs_evidence','uncertain','failed'
  )),
  progress_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX due_publication_jobs ON publication_jobs(phase, due_at, lease_until);
CREATE TABLE external_operations (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publication_jobs(job_id),
  step TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','prepared','running','uncertain','confirmed','failed')),
  prepared_json TEXT,
  provider_id TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(job_id, step)
);
CREATE INDEX unfinished_external_operations ON external_operations(status, job_id);

CREATE TABLE spending_budgets (
  scope TEXT NOT NULL,
  period TEXT NOT NULL,
  asset TEXT NOT NULL,
  ceiling TEXT NOT NULL,
  reserved TEXT NOT NULL DEFAULT '0',
  spent TEXT NOT NULL DEFAULT '0',
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, period, asset)
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
  PRIMARY KEY(reservation_id, scope, period, asset),
  FOREIGN KEY(scope, period, asset) REFERENCES spending_budgets(scope, period, asset)
);
-- A failed guard aborts the complete D1 batch, including earlier writes.
CREATE TABLE transaction_guards (
  guard_id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid = 1)
);

CREATE TABLE public_configurations (
  community_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  publisher TEXT NOT NULL,
  manifest_uri TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  block_number TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  PRIMARY KEY(community_id, revision)
);
CREATE TABLE public_post_revisions (
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL,
  manifest_uri TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  block_number TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK(quarantined IN (0,1)),
  PRIMARY KEY(community_id, post_id, revision)
);
CREATE INDEX feed_revision_page ON public_post_revisions(community_id, post_id, revision DESC);
CREATE TABLE chain_scan_state (
  chain_id INTEGER NOT NULL,
  contract_address TEXT NOT NULL,
  next_block TEXT NOT NULL,
  checkpoint_hash TEXT,
  PRIMARY KEY(chain_id, contract_address)
);

INSERT INTO setup_schema(version) VALUES(2);
