CREATE TABLE setup_schema (
  version INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO setup_schema (version) VALUES (1);
