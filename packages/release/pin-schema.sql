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
