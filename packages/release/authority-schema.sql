CREATE TABLE managed_releases (
  grant_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  admission_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
