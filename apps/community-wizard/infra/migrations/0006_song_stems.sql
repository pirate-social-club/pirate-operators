PRAGMA foreign_keys = ON;
-- Attachments are independent seals. They never rewrite the master, its
-- moderation input, lyric revision, publication job or public post identity.
CREATE TABLE media_stems (
  submission_id TEXT NOT NULL REFERENCES media_submissions(submission_id),
  slot TEXT NOT NULL CHECK(slot IN ('instrumental','vocals')),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 26214400),
  state TEXT NOT NULL CHECK(state IN ('reserved','uploading','sealed')),
  object_key TEXT UNIQUE,
  object_etag TEXT,
  duration_ms INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sealed_at INTEGER,
  PRIMARY KEY(submission_id,slot)
);
INSERT INTO setup_schema(version) VALUES(6);
