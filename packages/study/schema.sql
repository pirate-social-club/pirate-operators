-- Component-owned schema. Coordinator assigns and applies the next migration.
CREATE TABLE study_lessons (
  lesson_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  song_json TEXT NOT NULL CHECK(json_valid(song_json)),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  history_deleted_at INTEGER,
  history_cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK(history_cleanup_attempts>=0),
  UNIQUE(account_id,community_id,request_id),
  UNIQUE(lesson_id,account_id,community_id)
);
CREATE INDEX study_lessons_owner ON study_lessons(account_id,community_id,started_at DESC);
CREATE TABLE study_attempts (
  attempt_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  line_json TEXT NOT NULL CHECK(json_valid(line_json)),
  policy TEXT NOT NULL CHECK(policy IN ('script_aware_token_phonetic_v4','script_aware_token_phonetic_v5')),
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('ready','assessing','assessed','unavailable','uncertain')),
  audio_digest TEXT,
  audio_duration_ms INTEGER,
  lesson_id TEXT,
  presentation_number INTEGER,
  take_number INTEGER,
  grade_json TEXT CHECK(grade_json IS NULL OR json_valid(grade_json)),
  failure TEXT,
  UNIQUE(account_id, community_id, request_id),
  FOREIGN KEY(lesson_id,account_id,community_id) REFERENCES study_lessons(lesson_id,account_id,community_id),
  CHECK((lesson_id IS NULL AND presentation_number IS NULL AND take_number IS NULL) OR
        (lesson_id IS NOT NULL AND presentation_number IS NOT NULL AND take_number IS NOT NULL AND presentation_number>0 AND take_number>0)),
  CHECK((state = 'assessed') = (grade_json IS NOT NULL))
);
CREATE INDEX study_attempts_owner ON study_attempts(account_id,community_id,started_at DESC);
