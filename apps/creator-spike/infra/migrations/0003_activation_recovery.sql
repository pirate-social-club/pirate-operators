CREATE TABLE activation_recovery (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  payload_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created INTEGER NOT NULL
);
