-- Say-it-back lessons and private attempts. Public publication data is separate.
PRAGMA foreign_keys = ON;
CREATE TABLE study_lessons (
  lesson_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  song_json TEXT NOT NULL CHECK(json_valid(song_json)),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
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
  policy TEXT NOT NULL CHECK(policy = 'script_aware_token_phonetic_v4'),
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

-- Retain the full authenticated public source and exact original grant. The
-- application cannot open recording without this binding. Later retries and
-- public publication consume these frozen facts, never current configuration.
CREATE TABLE study_publications (
  lesson_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  learner TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  state TEXT NOT NULL DEFAULT 'bound' CHECK(state IN ('bound','pending','published','private','failed')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(lesson_id,account_id,community_id) REFERENCES study_lessons(lesson_id,account_id,community_id)
);
CREATE INDEX study_publications_pending ON study_publications(state,updated_at,lesson_id);
INSERT INTO setup_schema(version) VALUES(9);
