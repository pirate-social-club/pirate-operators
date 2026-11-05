PRAGMA foreign_keys = ON;
CREATE TABLE publication_amendments (
  job_id TEXT PRIMARY KEY REFERENCES publication_jobs(job_id),
  amendment_sha256 TEXT NOT NULL UNIQUE,
  signed_json TEXT NOT NULL,
  predecessor_operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  successor_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
INSERT INTO setup_schema(version) VALUES(7);
