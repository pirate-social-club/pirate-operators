PRAGMA foreign_keys = ON;
-- Karaoke for published songs. A lyric revision can purchase forced
-- alignment once, across all successor grants (packages/alignment/schema.sql).
CREATE TABLE song_alignments (
  operation_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  lyrics_revision INTEGER NOT NULL,
  grant_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('planned','running','received','uncertain','complete','unavailable')),
  execution_token TEXT,
  response_json TEXT,
  result_json TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(community_id,post_id,lyrics_revision)
);
-- The community side of Karaoke tickets and per-line purchases
-- (services/community-purchases.ts), one conditional write per atomic step.
CREATE TABLE karaoke_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO setup_schema(version) VALUES(8);
