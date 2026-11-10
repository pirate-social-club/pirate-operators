-- Reviewed source schema mounted at the coordinator-assigned ordinal.
CREATE TABLE dance_captures (
 capture_id TEXT PRIMARY KEY,community_id TEXT NOT NULL,account_id TEXT NOT NULL,
 command_id TEXT NOT NULL,request_hash TEXT NOT NULL,capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
 UNIQUE(community_id,account_id,command_id)
);
CREATE TABLE dance_reviews (
 review_id TEXT PRIMARY KEY REFERENCES dance_captures(capture_id),community_id TEXT NOT NULL,account_id TEXT NOT NULL,
 media_id TEXT NOT NULL UNIQUE,recording_digest TEXT NOT NULL,media_json TEXT NOT NULL,receipt_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL CHECK(state IN ('awaiting_review','decision_pending','withdrawal_pending')),
 local_denied INTEGER NOT NULL DEFAULT 0 CHECK(local_denied IN (0,1)),
 UNIQUE(community_id,recording_digest)
);
CREATE TABLE dance_consents (capture_id TEXT PRIMARY KEY REFERENCES dance_captures(capture_id),consent_json TEXT NOT NULL);
CREATE INDEX dance_queue ON dance_reviews(community_id,state,review_id);
CREATE TABLE dance_decision_intents (
 review_id TEXT PRIMARY KEY REFERENCES dance_reviews(review_id),command_id TEXT NOT NULL UNIQUE,
 preimage_json TEXT NOT NULL CHECK(json_valid(preimage_json)),local_integrity_hash TEXT NOT NULL
);
CREATE TABLE dance_receipts (
 community_id TEXT NOT NULL,actor_id TEXT NOT NULL,command_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),PRIMARY KEY(community_id,actor_id,command_id)
);
CREATE TABLE dance_outbox (
 command_id TEXT PRIMARY KEY,community_id TEXT NOT NULL,subject_id TEXT NOT NULL,kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,local_integrity_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('held','ready','unknown','latest','safe','orphaned','canceled'))
);
CREATE TABLE dance_transaction_attempts (
 attempt_id TEXT PRIMARY KEY,command_id TEXT NOT NULL REFERENCES dance_outbox(command_id),nonce TEXT NOT NULL,
 raw_transaction TEXT NOT NULL,transaction_hash TEXT NOT NULL,UNIQUE(command_id,transaction_hash)
);
CREATE TABLE dance_chain_observations (
 observation_id TEXT PRIMARY KEY,review_id TEXT NOT NULL,command_id TEXT NOT NULL,evidence_json TEXT NOT NULL,
 observed_at_ms INTEGER NOT NULL
);
CREATE TABLE dance_delegations (
 delegation_id TEXT PRIMARY KEY,community_id TEXT NOT NULL,account_id TEXT NOT NULL,wallet TEXT NOT NULL,owner_assignment TEXT NOT NULL
);
CREATE TABLE dance_control_intents (
 command_id TEXT PRIMARY KEY,community_id TEXT NOT NULL,actor_id TEXT NOT NULL,delegation_id TEXT NOT NULL,
 account_id TEXT NOT NULL,wallet TEXT NOT NULL,operation TEXT NOT NULL,local_integrity_hash TEXT NOT NULL,body_json TEXT NOT NULL
);
CREATE INDEX dance_control_denials ON dance_control_intents(community_id,operation,account_id,wallet);
CREATE TABLE dance_transaction_guards (guard_id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
CREATE TRIGGER dance_capture_no_update BEFORE UPDATE ON dance_captures BEGIN SELECT RAISE(ABORT,'dance_capture_immutable'); END;
CREATE TRIGGER dance_capture_no_delete BEFORE DELETE ON dance_captures BEGIN SELECT RAISE(ABORT,'dance_capture_immutable'); END;
CREATE TRIGGER dance_consent_no_update BEFORE UPDATE ON dance_consents BEGIN SELECT RAISE(ABORT,'dance_consent_immutable'); END;
CREATE TRIGGER dance_consent_no_delete BEFORE DELETE ON dance_consents BEGIN SELECT RAISE(ABORT,'dance_consent_immutable'); END;
CREATE TRIGGER dance_intent_no_update BEFORE UPDATE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,'dance_intent_immutable'); END;
CREATE TRIGGER dance_intent_no_delete BEFORE DELETE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,'dance_intent_immutable'); END;
CREATE TRIGGER dance_receipt_no_update BEFORE UPDATE ON dance_receipts BEGIN SELECT RAISE(ABORT,'dance_receipt_immutable'); END;
CREATE TRIGGER dance_receipt_no_delete BEFORE DELETE ON dance_receipts BEGIN SELECT RAISE(ABORT,'dance_receipt_immutable'); END;
CREATE TRIGGER dance_control_no_update BEFORE UPDATE ON dance_control_intents BEGIN SELECT RAISE(ABORT,'dance_control_immutable'); END;
CREATE TRIGGER dance_control_no_delete BEFORE DELETE ON dance_control_intents BEGIN SELECT RAISE(ABORT,'dance_control_immutable'); END;
CREATE TRIGGER dance_observation_no_update BEFORE UPDATE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,'dance_observation_immutable'); END;
CREATE TRIGGER dance_observation_no_delete BEFORE DELETE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,'dance_observation_immutable'); END;
CREATE TRIGGER dance_attempt_no_update BEFORE UPDATE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,'dance_attempt_immutable'); END;
CREATE TRIGGER dance_attempt_no_delete BEFORE DELETE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,'dance_attempt_immutable'); END;
CREATE TRIGGER dance_outbox_payload_no_update BEFORE UPDATE OF command_id,community_id,subject_id,kind,payload_json,local_integrity_hash ON dance_outbox BEGIN SELECT RAISE(ABORT,'dance_outbox_payload_immutable'); END;
CREATE TRIGGER dance_outbox_no_delete BEFORE DELETE ON dance_outbox BEGIN SELECT RAISE(ABORT,'dance_outbox_payload_immutable'); END;
CREATE TRIGGER dance_accepted_submission_no_update BEFORE UPDATE OF review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json ON dance_reviews BEGIN SELECT RAISE(ABORT,'dance_submission_immutable'); END;
