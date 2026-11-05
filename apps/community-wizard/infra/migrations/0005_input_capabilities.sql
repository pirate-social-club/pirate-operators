-- Expiring capabilities for private, immutable moderation inputs.
CREATE TABLE moderation_input_capabilities (
  capability_hash TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES media_submissions(submission_id),
  input_kind TEXT NOT NULL CHECK(input_kind IN ('audio','title','lyrics')),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX moderation_capability_expiry ON moderation_input_capabilities(expires_at);

INSERT INTO setup_schema(version) VALUES(5);
