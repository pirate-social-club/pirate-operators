-- Lane-local schema: coordinator assigns migration order and applies it.
CREATE TABLE IF NOT EXISTS community_media (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  UNIQUE(community_id, account_id, request_id)
);
CREATE INDEX IF NOT EXISTS community_media_feed ON community_media(community_id, purpose, state, ready_at DESC, id DESC);
-- Submission retention participates in the actual Dance acceptance transaction.
CREATE TABLE IF NOT EXISTS community_media_submissions (
  community_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  binding_commitment TEXT NOT NULL,
  submitted_at_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  media_revision INTEGER NOT NULL,
  PRIMARY KEY(community_id,submission_id),
  UNIQUE(community_id,media_id),
  CHECK(deadline_ms=submitted_at_ms+604800000)
);
CREATE TABLE IF NOT EXISTS community_media_submission_guards (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK(valid=1)
);
