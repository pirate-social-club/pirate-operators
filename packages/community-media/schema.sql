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
