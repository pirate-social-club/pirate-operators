-- A lyric revision can purchase forced alignment once, across all successor grants.
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
