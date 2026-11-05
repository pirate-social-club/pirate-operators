-- Durable release grant and external-operation journals. Existing admission state remains.
CREATE TABLE managed_releases (
  grant_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  admission_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE funded_pins (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','running','uncertain','confirmed')),
  provider_receipt_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE funded_registrations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned','prepared','running','uncertain','confirmed')),
  prepared_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
