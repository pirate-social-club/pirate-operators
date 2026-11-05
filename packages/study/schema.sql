-- Component-owned schema. Coordinator assigns and applies the next migration.
CREATE TABLE study_attempts (
  attempt_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  line_json TEXT NOT NULL CHECK(json_valid(line_json)),
  policy TEXT NOT NULL CHECK(policy = 'script_aware_token_phonetic_v4'),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('ready','assessing','assessed','unavailable','uncertain')),
  audio_digest TEXT,
  grade_json TEXT CHECK(grade_json IS NULL OR json_valid(grade_json)),
  failure TEXT,
  UNIQUE(account_id, community_id, request_id),
  CHECK((state = 'assessed') = (grade_json IS NOT NULL))
);
CREATE INDEX study_attempts_owner ON study_attempts(account_id,community_id,started_at DESC);
