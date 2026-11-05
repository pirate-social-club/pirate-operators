CREATE TABLE signature_preparations (
  signature_id TEXT PRIMARY KEY REFERENCES signatures(id),
  submission_id TEXT NOT NULL UNIQUE,
  phase TEXT NOT NULL CHECK(phase IN ('building','prepared','submitting','expired')),
  token TEXT NOT NULL,
  expires INTEGER NOT NULL,
  user_signature TEXT
);
CREATE INDEX signature_preparation_expiry ON signature_preparations(expires);
