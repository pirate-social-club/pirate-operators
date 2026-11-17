-- Separate publication consent command/outbox state; no V4 backfill or activation.
-- Apply the command journal without enabling a publication profile.
CREATE TABLE publication_v1_heads (
  community_id TEXT NOT NULL, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
  purpose TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
  stopped INTEGER NOT NULL DEFAULT 1 CHECK(stopped IN (0,1)),
  stop_command_id TEXT,
  PRIMARY KEY(community_id,account_id,source_id,purpose)
);
CREATE TABLE publication_v1_commands (
  command_id TEXT PRIMARY KEY NOT NULL, community_id TEXT NOT NULL, account_id TEXT NOT NULL,
  source_id TEXT NOT NULL, purpose TEXT NOT NULL, action TEXT NOT NULL
    CHECK(action IN ('grant','withdraw')), request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_json TEXT NOT NULL, nonce_hex TEXT NOT NULL,
  fence_generation INTEGER CHECK(fence_generation IS NULL OR
    (typeof(fence_generation)='integer' AND fence_generation BETWEEN 0 AND 9007199254740991)),
  phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','accepted')),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL, due_ms INTEGER NOT NULL,
  typed_json TEXT, digest TEXT, signature TEXT, accepted_json TEXT,
  fence_ack_json TEXT, result_state TEXT, observation_hash TEXT,
  UNIQUE(community_id,account_id,source_id,purpose,action,request_id),
  FOREIGN KEY(community_id,account_id,source_id,purpose)
    REFERENCES publication_v1_heads(community_id,account_id,source_id,purpose),
  CHECK((phase='preparing' AND typed_json IS NULL AND digest IS NULL
      AND signature IS NULL AND accepted_json IS NULL)
    OR (phase='prepared' AND typed_json IS NOT NULL AND digest IS NOT NULL
      AND signature IS NULL AND accepted_json IS NULL)
    OR (phase='accepted' AND typed_json IS NOT NULL AND digest IS NOT NULL
      AND signature IS NOT NULL AND accepted_json IS NOT NULL))
);
CREATE INDEX publication_v1_due ON publication_v1_commands(due_ms,command_id);
CREATE INDEX publication_v1_scope ON publication_v1_commands
  (community_id,account_id,source_id,purpose,action,result_state);
CREATE TABLE publication_v1_observations (
  command_id TEXT NOT NULL, proof_hash TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY(command_id,proof_hash),
  FOREIGN KEY(command_id) REFERENCES publication_v1_commands(command_id)
);
-- BEFORE INSERT also protects against REPLACE's implicit deletion, regardless
-- of the connection's recursive_triggers pragma. Exact retries keep first bytes.
CREATE TRIGGER publication_v1_head_insert BEFORE INSERT ON publication_v1_heads
WHEN EXISTS(SELECT 1 FROM publication_v1_heads WHERE community_id=NEW.community_id
  AND account_id=NEW.account_id AND source_id=NEW.source_id AND purpose=NEW.purpose)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER publication_v1_command_insert BEFORE INSERT ON publication_v1_commands
WHEN EXISTS(SELECT 1 FROM publication_v1_commands WHERE command_id=NEW.command_id
  OR (community_id=NEW.community_id AND account_id=NEW.account_id
    AND source_id=NEW.source_id AND purpose=NEW.purpose
    AND action=NEW.action AND request_id=NEW.request_id))
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER publication_v1_observation_insert BEFORE INSERT ON publication_v1_observations
WHEN EXISTS(SELECT 1 FROM publication_v1_observations
  WHERE command_id=NEW.command_id AND proof_hash=NEW.proof_hash)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER publication_v1_head_original BEFORE UPDATE ON publication_v1_heads
WHEN NEW.community_id IS NOT OLD.community_id OR NEW.account_id IS NOT OLD.account_id
  OR NEW.source_id IS NOT OLD.source_id OR NEW.purpose IS NOT OLD.purpose
BEGIN SELECT RAISE(ABORT,'publication_head_immutable'); END;
CREATE TRIGGER publication_v1_head_progress BEFORE UPDATE ON publication_v1_heads
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT,'publication_head_regression'); END;
CREATE TRIGGER publication_v1_head_delete BEFORE DELETE ON publication_v1_heads
BEGIN SELECT RAISE(ABORT,'publication_head_immutable'); END;
CREATE TRIGGER publication_v1_command_original BEFORE UPDATE ON publication_v1_commands
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.community_id IS NOT OLD.community_id
  OR NEW.account_id IS NOT OLD.account_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.purpose IS NOT OLD.purpose OR NEW.action IS NOT OLD.action
  OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.request_json IS NOT OLD.request_json OR NEW.nonce_hex IS NOT OLD.nonce_hex
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'publication_command_immutable'); END;
CREATE TRIGGER publication_v1_command_first_bytes BEFORE UPDATE ON publication_v1_commands
WHEN (OLD.fence_generation IS NOT NULL AND NEW.fence_generation IS NOT OLD.fence_generation)
  OR (OLD.typed_json IS NOT NULL AND NEW.typed_json IS NOT OLD.typed_json)
  OR (OLD.digest IS NOT NULL AND NEW.digest IS NOT OLD.digest)
  OR (OLD.signature IS NOT NULL AND NEW.signature IS NOT OLD.signature)
  OR (OLD.accepted_json IS NOT NULL AND NEW.accepted_json IS NOT OLD.accepted_json)
  OR (OLD.fence_ack_json IS NOT NULL AND NEW.fence_ack_json IS NOT OLD.fence_ack_json)
BEGIN SELECT RAISE(ABORT,'publication_first_bytes_immutable'); END;
CREATE TRIGGER publication_v1_command_progress BEFORE UPDATE ON publication_v1_commands
WHEN NEW.version < OLD.version
  OR (OLD.phase='accepted' AND NEW.phase!='accepted')
  OR (OLD.phase='prepared' AND NEW.phase='preparing')
BEGIN SELECT RAISE(ABORT,'publication_command_regression'); END;
CREATE TRIGGER publication_v1_command_delete BEFORE DELETE ON publication_v1_commands
BEGIN SELECT RAISE(ABORT,'publication_command_immutable'); END;
CREATE TRIGGER publication_v1_observation_update BEFORE UPDATE ON publication_v1_observations
BEGIN SELECT RAISE(ABORT,'publication_observation_immutable'); END;
CREATE TRIGGER publication_v1_observation_delete BEFORE DELETE ON publication_v1_observations
BEGIN SELECT RAISE(ABORT,'publication_observation_immutable'); END;

-- Root assigns the ordinal after the foundation. Preserve duplicate evidence.
CREATE UNIQUE INDEX IF NOT EXISTS publication_v1_request_original
ON publication_v1_commands(community_id,account_id,purpose,action,request_id);

CREATE INDEX IF NOT EXISTS publication_v1_due_cursor
ON publication_v1_commands(due_ms,command_id);

INSERT INTO setup_schema(version) VALUES(20);
