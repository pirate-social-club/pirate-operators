CREATE TABLE external_operation_reconciliations (
  operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  proof_sha256 TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, proof_sha256)
);
