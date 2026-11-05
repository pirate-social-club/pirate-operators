CREATE TABLE funded_registrations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned','prepared','running','uncertain','confirmed')),
  prepared_json TEXT,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
