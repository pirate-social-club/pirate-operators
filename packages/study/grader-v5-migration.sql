-- Unnumbered proposal: coordinator owns ordinal and live application.
CREATE TABLE study_attempts_v5 (
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


INSERT INTO study_attempts_v5(attempt_id,account_id,community_id,request_id,line_json,policy,started_at,completed_at,state,audio_digest,audio_duration_ms,lesson_id,presentation_number,take_number,grade_json,failure) SELECT attempt_id,account_id,community_id,request_id,line_json,policy,started_at,completed_at,state,audio_digest,audio_duration_ms,lesson_id,presentation_number,take_number,grade_json,failure FROM study_attempts;
DROP TABLE study_attempts;
ALTER TABLE study_attempts_v5 RENAME TO study_attempts;
CREATE INDEX study_attempts_owner ON study_attempts(account_id,community_id,started_at DESC);
