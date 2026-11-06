-- Preserve compact public recovery facts while erasing private queue history.
ALTER TABLE study_lessons ADD COLUMN history_deleted_at INTEGER;
ALTER TABLE study_lessons ADD COLUMN history_cleanup_attempts INTEGER NOT NULL DEFAULT 0
  CHECK(history_cleanup_attempts>=0);
CREATE INDEX study_lessons_cleanup ON study_lessons(community_id,history_deleted_at,history_cleanup_attempts);
ALTER TABLE study_publications ADD COLUMN terminal_json TEXT
  CHECK(terminal_json IS NULL OR json_valid(terminal_json));
INSERT INTO setup_schema(version) VALUES(10);
