-- Additive local feature schema; coordinator assigns/applies migration ordinal.
CREATE TABLE dance_control_bindings (
 command_id TEXT PRIMARY KEY REFERENCES dance_control_intents(command_id),binding_hash TEXT NOT NULL,
 intent_hash TEXT NOT NULL,source_hash TEXT NOT NULL,wallet TEXT NOT NULL,binding_json TEXT NOT NULL
);
CREATE TABLE dance_control_observations (
 observation_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES dance_control_intents(command_id),
 binding_hash TEXT NOT NULL,state TEXT NOT NULL,evidence_json TEXT NOT NULL,observed_at_ms INTEGER NOT NULL
);
CREATE TABLE dance_control_projection (
 command_id TEXT PRIMARY KEY REFERENCES dance_control_intents(command_id),binding_hash TEXT NOT NULL,
 source_hash TEXT NOT NULL,wallet TEXT NOT NULL,state TEXT NOT NULL,result_epoch INTEGER,
 anchor_number INTEGER,anchor_hash TEXT,guarded INTEGER NOT NULL,revision INTEGER NOT NULL
);
CREATE TABLE dance_reviewer_observations (
 observation_id TEXT PRIMARY KEY,community_id TEXT NOT NULL,source_hash TEXT NOT NULL,wallet TEXT NOT NULL,
 observation_json TEXT NOT NULL,observed_at_ms INTEGER NOT NULL
);
CREATE TABLE dance_reviewer_projection (
 community_id TEXT NOT NULL,source_hash TEXT NOT NULL,wallet TEXT NOT NULL,revision INTEGER NOT NULL,
 anchor_number INTEGER NOT NULL,anchor_hash TEXT NOT NULL,role_epoch INTEGER,highest_role_epoch INTEGER NOT NULL,
 owner_epoch INTEGER NOT NULL,configuration_revision INTEGER NOT NULL,owner_valid_from_ms INTEGER NOT NULL,
 owner_expires_at_ms INTEGER NOT NULL,role_expires_at_ms INTEGER,state TEXT NOT NULL,observation_json TEXT NOT NULL,
 PRIMARY KEY(community_id,source_hash,wallet)
);
CREATE TABLE dance_attempt_admissions (
 attempt_id TEXT PRIMARY KEY REFERENCES dance_transaction_attempts(attempt_id),command_id TEXT NOT NULL,
 binding_hash TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='guarded_before_broadcast')
);
CREATE TABLE dance_recovered_attempts (
 attempt_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES dance_outbox(command_id),nonce TEXT NOT NULL,
 raw_transaction TEXT NOT NULL,transaction_hash TEXT NOT NULL,UNIQUE(command_id,transaction_hash)
);
CREATE TRIGGER dance_control_binding_no_update BEFORE UPDATE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,'dance_control_binding_immutable'); END;
CREATE TRIGGER dance_control_binding_no_delete BEFORE DELETE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,'dance_control_binding_immutable'); END;
CREATE TRIGGER dance_control_observation_no_update BEFORE UPDATE ON dance_control_observations BEGIN SELECT RAISE(ABORT,'dance_control_observation_immutable'); END;
CREATE TRIGGER dance_control_observation_no_delete BEFORE DELETE ON dance_control_observations BEGIN SELECT RAISE(ABORT,'dance_control_observation_immutable'); END;
CREATE TRIGGER dance_role_observation_no_update BEFORE UPDATE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,'dance_role_observation_immutable'); END;
CREATE TRIGGER dance_role_observation_no_delete BEFORE DELETE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,'dance_role_observation_immutable'); END;
CREATE TRIGGER dance_attempt_admission_no_update BEFORE UPDATE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,'dance_attempt_admission_immutable'); END;
CREATE TRIGGER dance_attempt_admission_no_delete BEFORE DELETE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,'dance_attempt_admission_immutable'); END;
CREATE TRIGGER dance_recovered_attempt_no_update BEFORE UPDATE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,'dance_recovered_attempt_immutable'); END;
CREATE TRIGGER dance_recovered_attempt_no_delete BEFORE DELETE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,'dance_recovered_attempt_immutable'); END;
