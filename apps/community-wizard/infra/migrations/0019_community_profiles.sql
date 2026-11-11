-- Account profiles and opaque public-activity cursor receipts.
CREATE TABLE community_profiles (
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  display_name TEXT,
  bio TEXT,
  avatar_ref TEXT,
  cover_ref TEXT,
  PRIMARY KEY(community_id, account_id)
);
CREATE TABLE community_profile_mutations (
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  result_json TEXT,
  PRIMARY KEY(community_id, account_id, mutation_id)
);
CREATE TABLE community_profile_activity_cursors (
  token TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  page_offset INTEGER NOT NULL CHECK(page_offset > 0 AND page_offset <= 100),
  page_size INTEGER NOT NULL CHECK(page_size > 0 AND page_size <= 20),
  expires_at INTEGER NOT NULL,
  UNIQUE(community_id, author_id, snapshot_hash, page_offset, page_size, expires_at)
);
CREATE INDEX community_profile_cursor_expiry ON community_profile_activity_cursors(expires_at);
