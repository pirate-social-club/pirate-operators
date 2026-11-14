-- pirate.catalog-phase-transition/2
-- UNAPPLIED / UNNUMBERED. Use catalogPhaseTransitionStatements and ONE D1 batch.
-- The fresh named CHECK guard and every transition statement share that batch.
-- No earlier async inspection substitutes for the transactional guard.
-- Exact pre-catalog component: pinned community migrations 0001 through 0019.
-- Known unrelated later triggers are byte-pinned; optional means not yet applied.
-- Unknown affected schema/indexes, any unknown trigger/view, and any unexpected
-- incoming FK (including from an empty table) refuse before destructive DDL.
-- Foreign keys remain enabled; all v1 rowid/column/history copies are unchanged.
-- Apply catalog-obligation.sql only after this batch commits successfully.
CREATE TABLE catalog_phase_schema_guard (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  valid INTEGER NOT NULL CONSTRAINT catalog_phase_schema_refusal CHECK(valid = 1)
);
-- catalog-phase-statement
-- Attest the sole protected FK-free runtime object before FK introspection.
-- Absence is allowed; any present name/type/owner/SQL-byte mismatch refuses.
WITH expected_runtime_metadata(type,name,tbl_name,sql) AS (
  VALUES ('table','_cf_METADATA','_cf_METADATA','CREATE TABLE _cf_METADATA (
        key INTEGER PRIMARY KEY,
        value BLOB
      )')
), actual_runtime_metadata AS (
  SELECT type,name,tbl_name,CAST(sql AS BLOB) AS sql
  FROM main.sqlite_schema WHERE lower(name)='_cf_metadata'
)
INSERT INTO catalog_phase_schema_guard(singleton,valid)
SELECT 1, CASE WHEN NOT EXISTS (
  SELECT type,name,tbl_name,sql FROM actual_runtime_metadata
  EXCEPT SELECT type,name,tbl_name,CAST(sql AS BLOB) FROM expected_runtime_metadata
) THEN 1 ELSE 0 END;
-- catalog-phase-statement
-- Exact selected migration SQL bytes, including CHECK/default/collation text.
-- BLOB equality deliberately refuses even a semantically equivalent rewrite.
-- Autoindex NULL SQL/name/owner identities are included, not filtered away.
-- Known unrelated triggers from pinned migrations 0016-0018 may be absent
-- before those migrations, but any present trigger must match its exact bytes.
-- Reject all other triggers/views: no lossy dependency-text search is used.
WITH expected_affected(type, name, tbl_name, sql) AS (
  VALUES
    ('index', 'due_publication_jobs', 'publication_jobs', 'CREATE INDEX due_publication_jobs ON publication_jobs(phase, due_at, lease_until)'),
    ('index', 'sqlite_autoindex_external_operation_reconciliations_1', 'external_operation_reconciliations', NULL),
    ('index', 'sqlite_autoindex_external_operations_1', 'external_operations', NULL),
    ('index', 'sqlite_autoindex_external_operations_2', 'external_operations', NULL),
    ('index', 'sqlite_autoindex_publication_amendments_1', 'publication_amendments', NULL),
    ('index', 'sqlite_autoindex_publication_amendments_2', 'publication_amendments', NULL),
    ('index', 'sqlite_autoindex_publication_amendments_3', 'publication_amendments', NULL),
    ('index', 'sqlite_autoindex_publication_jobs_1', 'publication_jobs', NULL),
    ('index', 'sqlite_autoindex_publication_jobs_2', 'publication_jobs', NULL),
    ('index', 'unfinished_external_operations', 'external_operations', 'CREATE INDEX unfinished_external_operations ON external_operations(status, job_id)'),
    ('table', 'external_operation_reconciliations', 'external_operation_reconciliations', 'CREATE TABLE external_operation_reconciliations (
  operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  proof_sha256 TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, proof_sha256)
)'),
    ('table', 'external_operations', 'external_operations', 'CREATE TABLE external_operations (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publication_jobs(job_id),
  step TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (''planned'',''prepared'',''running'',''uncertain'',''confirmed'',''failed'')),
  prepared_json TEXT,
  provider_id TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(job_id, step)
)'),
    ('table', 'publication_amendments', 'publication_amendments', 'CREATE TABLE publication_amendments (
  job_id TEXT PRIMARY KEY REFERENCES publication_jobs(job_id),
  amendment_sha256 TEXT NOT NULL UNIQUE,
  signed_json TEXT NOT NULL,
  predecessor_operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  successor_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
)'),
    ('table', 'publication_jobs', 'publication_jobs', 'CREATE TABLE publication_jobs (
  job_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES media_submissions(submission_id),
  input_hash TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN (
    ''admission'',''pin_audio'',''pin_lyrics'',''registration'',''pin_manifest'',''publication'',
    ''published'',''held'',''blocked'',''needs_evidence'',''uncertain'',''failed''
  )),
  progress_json TEXT NOT NULL DEFAULT ''{}'',
  revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)')
),
actual_affected AS (
  SELECT type, name, tbl_name, CAST(sql AS BLOB) AS sql
  FROM main.sqlite_schema
  WHERE lower(tbl_name) IN ('publication_jobs', 'external_operations', 'external_operation_reconciliations', 'publication_amendments')
),
expected_trigger(type, name, tbl_name, sql) AS (
  VALUES
    ('trigger', 'dance_accepted_submission_no_update', 'dance_reviews', 'CREATE TRIGGER dance_accepted_submission_no_update BEFORE UPDATE OF review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json ON dance_reviews BEGIN SELECT RAISE(ABORT,''dance_submission_immutable''); END'),
    ('trigger', 'dance_attempt_admission_no_delete', 'dance_attempt_admissions', 'CREATE TRIGGER dance_attempt_admission_no_delete BEFORE DELETE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,''dance_attempt_admission_immutable''); END'),
    ('trigger', 'dance_attempt_admission_no_update', 'dance_attempt_admissions', 'CREATE TRIGGER dance_attempt_admission_no_update BEFORE UPDATE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,''dance_attempt_admission_immutable''); END'),
    ('trigger', 'dance_attempt_no_delete', 'dance_transaction_attempts', 'CREATE TRIGGER dance_attempt_no_delete BEFORE DELETE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,''dance_attempt_immutable''); END'),
    ('trigger', 'dance_attempt_no_update', 'dance_transaction_attempts', 'CREATE TRIGGER dance_attempt_no_update BEFORE UPDATE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,''dance_attempt_immutable''); END'),
    ('trigger', 'dance_capture_no_delete', 'dance_captures', 'CREATE TRIGGER dance_capture_no_delete BEFORE DELETE ON dance_captures BEGIN SELECT RAISE(ABORT,''dance_capture_immutable''); END'),
    ('trigger', 'dance_capture_no_update', 'dance_captures', 'CREATE TRIGGER dance_capture_no_update BEFORE UPDATE ON dance_captures BEGIN SELECT RAISE(ABORT,''dance_capture_immutable''); END'),
    ('trigger', 'dance_consent_no_delete', 'dance_consents', 'CREATE TRIGGER dance_consent_no_delete BEFORE DELETE ON dance_consents BEGIN SELECT RAISE(ABORT,''dance_consent_immutable''); END'),
    ('trigger', 'dance_consent_no_update', 'dance_consents', 'CREATE TRIGGER dance_consent_no_update BEFORE UPDATE ON dance_consents BEGIN SELECT RAISE(ABORT,''dance_consent_immutable''); END'),
    ('trigger', 'dance_control_binding_no_delete', 'dance_control_bindings', 'CREATE TRIGGER dance_control_binding_no_delete BEFORE DELETE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,''dance_control_binding_immutable''); END'),
    ('trigger', 'dance_control_binding_no_update', 'dance_control_bindings', 'CREATE TRIGGER dance_control_binding_no_update BEFORE UPDATE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,''dance_control_binding_immutable''); END'),
    ('trigger', 'dance_control_no_delete', 'dance_control_intents', 'CREATE TRIGGER dance_control_no_delete BEFORE DELETE ON dance_control_intents BEGIN SELECT RAISE(ABORT,''dance_control_immutable''); END'),
    ('trigger', 'dance_control_no_update', 'dance_control_intents', 'CREATE TRIGGER dance_control_no_update BEFORE UPDATE ON dance_control_intents BEGIN SELECT RAISE(ABORT,''dance_control_immutable''); END'),
    ('trigger', 'dance_control_observation_no_delete', 'dance_control_observations', 'CREATE TRIGGER dance_control_observation_no_delete BEFORE DELETE ON dance_control_observations BEGIN SELECT RAISE(ABORT,''dance_control_observation_immutable''); END'),
    ('trigger', 'dance_control_observation_no_update', 'dance_control_observations', 'CREATE TRIGGER dance_control_observation_no_update BEFORE UPDATE ON dance_control_observations BEGIN SELECT RAISE(ABORT,''dance_control_observation_immutable''); END'),
    ('trigger', 'dance_intent_no_delete', 'dance_decision_intents', 'CREATE TRIGGER dance_intent_no_delete BEFORE DELETE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,''dance_intent_immutable''); END'),
    ('trigger', 'dance_intent_no_update', 'dance_decision_intents', 'CREATE TRIGGER dance_intent_no_update BEFORE UPDATE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,''dance_intent_immutable''); END'),
    ('trigger', 'dance_observation_no_delete', 'dance_chain_observations', 'CREATE TRIGGER dance_observation_no_delete BEFORE DELETE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,''dance_observation_immutable''); END'),
    ('trigger', 'dance_observation_no_update', 'dance_chain_observations', 'CREATE TRIGGER dance_observation_no_update BEFORE UPDATE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,''dance_observation_immutable''); END'),
    ('trigger', 'dance_outbox_no_delete', 'dance_outbox', 'CREATE TRIGGER dance_outbox_no_delete BEFORE DELETE ON dance_outbox BEGIN SELECT RAISE(ABORT,''dance_outbox_payload_immutable''); END'),
    ('trigger', 'dance_outbox_payload_no_update', 'dance_outbox', 'CREATE TRIGGER dance_outbox_payload_no_update BEFORE UPDATE OF command_id,community_id,subject_id,kind,payload_json,local_integrity_hash ON dance_outbox BEGIN SELECT RAISE(ABORT,''dance_outbox_payload_immutable''); END'),
    ('trigger', 'dance_receipt_no_delete', 'dance_receipts', 'CREATE TRIGGER dance_receipt_no_delete BEFORE DELETE ON dance_receipts BEGIN SELECT RAISE(ABORT,''dance_receipt_immutable''); END'),
    ('trigger', 'dance_receipt_no_update', 'dance_receipts', 'CREATE TRIGGER dance_receipt_no_update BEFORE UPDATE ON dance_receipts BEGIN SELECT RAISE(ABORT,''dance_receipt_immutable''); END'),
    ('trigger', 'dance_recovered_attempt_no_delete', 'dance_recovered_attempts', 'CREATE TRIGGER dance_recovered_attempt_no_delete BEFORE DELETE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,''dance_recovered_attempt_immutable''); END'),
    ('trigger', 'dance_recovered_attempt_no_update', 'dance_recovered_attempts', 'CREATE TRIGGER dance_recovered_attempt_no_update BEFORE UPDATE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,''dance_recovered_attempt_immutable''); END'),
    ('trigger', 'dance_role_observation_no_delete', 'dance_reviewer_observations', 'CREATE TRIGGER dance_role_observation_no_delete BEFORE DELETE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,''dance_role_observation_immutable''); END'),
    ('trigger', 'dance_role_observation_no_update', 'dance_reviewer_observations', 'CREATE TRIGGER dance_role_observation_no_update BEFORE UPDATE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,''dance_role_observation_immutable''); END'),
    ('trigger', 'learning_authority_capture', 'learning_authorizations', 'CREATE TRIGGER learning_authority_capture AFTER INSERT ON learning_authorizations
 BEGIN UPDATE learning_authorizations SET authority_epoch=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0)
 WHERE authorization_id=NEW.authorization_id; END'),
    ('trigger', 'learning_authority_challenge_capture', 'login_challenges', 'CREATE TRIGGER learning_authority_challenge_capture AFTER INSERT ON login_challenges
 BEGIN UPDATE login_challenges SET authority_epoch=COALESCE((SELECT h.revision FROM credential_bindings b
 JOIN learning_authority_heads h ON h.account_id=b.account_id
 WHERE b.namespace=''moss'' AND b.network=6343 AND b.subject=NEW.subject),0) WHERE challenge_id=NEW.challenge_id; END'),
    ('trigger', 'learning_authority_credential_delete', 'credential_bindings', 'CREATE TRIGGER learning_authority_credential_delete AFTER DELETE ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_credential_insert', 'credential_bindings', 'CREATE TRIGGER learning_authority_credential_insert AFTER INSERT ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_credential_update', 'credential_bindings', 'CREATE TRIGGER learning_authority_credential_update AFTER UPDATE OF binding_id,account_id,namespace,network,subject ON credential_bindings
 WHEN OLD.binding_id IS NOT NEW.binding_id OR OLD.account_id IS NOT NEW.account_id OR OLD.namespace IS NOT NEW.namespace OR OLD.network IS NOT NEW.network OR OLD.subject IS NOT NEW.subject
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_credentials(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_insert_hold', 'learning_authorizations', 'CREATE TRIGGER learning_authority_insert_hold BEFORE INSERT ON learning_authorizations
 WHEN EXISTS(SELECT 1 FROM learning_authority_heads h WHERE h.account_id=NEW.account_id AND h.pending_operation IS NOT NULL)
 OR EXISTS(SELECT 1 FROM learning_authority_dirty d WHERE d.account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM login_challenges c WHERE c.subject=NEW.subject AND c.message=NEW.message AND c.kind=''sign-in-v4''
   AND c.authority_epoch!=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0))
 BEGIN SELECT RAISE(IGNORE); END'),
    ('trigger', 'learning_authority_member_delete', 'learning_authority_members', 'CREATE TRIGGER learning_authority_member_delete AFTER DELETE ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id; END'),
    ('trigger', 'learning_authority_member_insert', 'learning_authority_members', 'CREATE TRIGGER learning_authority_member_insert AFTER INSERT ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=NEW.operation_id; END'),
    ('trigger', 'learning_authority_member_update', 'learning_authority_members', 'CREATE TRIGGER learning_authority_member_update AFTER UPDATE OF operation_id,authorization_id ON learning_authority_members
 WHEN OLD.operation_id IS NOT NEW.operation_id OR OLD.authorization_id IS NOT NEW.authorization_id
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id OR operation_id=NEW.operation_id; END'),
    ('trigger', 'learning_authority_off_insert', 'learning_settings', 'CREATE TRIGGER learning_authority_off_insert AFTER INSERT ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END'),
    ('trigger', 'learning_authority_off_update', 'learning_settings', 'CREATE TRIGGER learning_authority_off_update AFTER UPDATE OF public_results_withdrawn_at,last_withdrawn_at ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL AND (OLD.public_results_withdrawn_at IS NULL OR NEW.last_withdrawn_at IS NOT OLD.last_withdrawn_at)
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END'),
    ('trigger', 'learning_authority_original_delete', 'learning_authorizations', 'CREATE TRIGGER learning_authority_original_delete AFTER DELETE ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_original_insert', 'learning_authorizations', 'CREATE TRIGGER learning_authority_original_insert AFTER INSERT ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_original_update', 'learning_authorizations', 'CREATE TRIGGER learning_authority_original_update AFTER UPDATE OF authorization_id,account_id,subject,issued_at,authority_epoch,message,sign_in_json,signature,policy_hash,policy_version ON learning_authorizations
 WHEN OLD.authorization_id IS NOT NEW.authorization_id OR OLD.account_id IS NOT NEW.account_id OR OLD.subject IS NOT NEW.subject
 OR OLD.issued_at IS NOT NEW.issued_at OR OLD.authority_epoch IS NOT NEW.authority_epoch OR OLD.message IS NOT NEW.message
 OR OLD.sign_in_json IS NOT NEW.sign_in_json OR OLD.signature IS NOT NEW.signature OR OLD.policy_hash IS NOT NEW.policy_hash OR OLD.policy_version IS NOT NEW.policy_version
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_original_heads(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
    ('trigger', 'learning_authority_withdrawal_identity', 'learning_authority_withdrawals', 'CREATE TRIGGER learning_authority_withdrawal_identity AFTER INSERT ON learning_authority_withdrawals
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END')
),
actual_executable AS (
  SELECT type, name, tbl_name, CAST(sql AS BLOB) AS sql
  FROM main.sqlite_schema WHERE type IN ('trigger', 'view')
),
expected_incoming(child, parent, child_column, parent_column, on_update, on_delete, match) AS (
  VALUES
    ('external_operation_reconciliations', 'external_operations', 'operation_id', 'operation_id', 'NO ACTION', 'NO ACTION', 'NONE'),
    ('external_operations', 'publication_jobs', 'job_id', 'job_id', 'NO ACTION', 'NO ACTION', 'NONE'),
    ('publication_amendments', 'external_operations', 'predecessor_operation_id', 'operation_id', 'NO ACTION', 'NO ACTION', 'NONE'),
    ('publication_amendments', 'publication_jobs', 'job_id', 'job_id', 'NO ACTION', 'NO ACTION', 'NONE')
),
-- The preceding named CHECK has proved this exact object is FK-free.
-- Materialize before invoking the pragma; every other table remains included.
incoming_tables AS MATERIALIZED (
  SELECT name FROM main.sqlite_schema
  WHERE type='table' AND name<>'_cf_METADATA'
),
actual_incoming AS (
  SELECT s.name, f."table", f."from", f."to", f.on_update, f.on_delete, f.match
  FROM incoming_tables AS s JOIN pragma_foreign_key_list(s.name) AS f
  WHERE lower(f."table") IN ('publication_jobs', 'external_operations', 'external_operation_reconciliations', 'publication_amendments')
)
UPDATE catalog_phase_schema_guard
SET valid = CASE WHEN
  NOT EXISTS (
    SELECT type, name, tbl_name, sql FROM actual_affected
    EXCEPT SELECT type, name, tbl_name, CAST(sql AS BLOB) FROM expected_affected
  )
  AND NOT EXISTS (
    SELECT type, name, tbl_name, CAST(sql AS BLOB) FROM expected_affected
    EXCEPT SELECT type, name, tbl_name, sql FROM actual_affected
  )
  AND NOT EXISTS (
    SELECT type, name, tbl_name, sql FROM actual_executable
    EXCEPT SELECT type, name, tbl_name, CAST(sql AS BLOB) FROM expected_trigger
  )
  AND NOT EXISTS (
    SELECT * FROM actual_incoming EXCEPT SELECT * FROM expected_incoming
  )
  AND NOT EXISTS (
    SELECT * FROM expected_incoming EXCEPT SELECT * FROM actual_incoming
  )
THEN 1 ELSE 0 END
WHERE singleton=1;
-- catalog-phase-statement
CREATE TABLE publication_jobs_catalog_next (
  job_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES media_submissions(submission_id),
  input_hash TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN (
    'admission','pin_audio','pin_lyrics','registration','pin_manifest','publication',
    'catalog_reserve','catalog_confirm','published','held','blocked','needs_evidence','uncertain','failed'
  )),
  progress_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- catalog-phase-statement
INSERT INTO publication_jobs_catalog_next(rowid,job_id,submission_id,input_hash,authority_json,phase,progress_json,revision,lease_token,lease_until,due_at,attempts,error_code,created_at,updated_at)
SELECT rowid,job_id,submission_id,input_hash,authority_json,phase,progress_json,revision,lease_token,lease_until,due_at,attempts,error_code,created_at,updated_at FROM publication_jobs;
-- catalog-phase-statement
CREATE TABLE external_operations_catalog_next (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES publication_jobs_catalog_next(job_id),
  step TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','prepared','running','uncertain','confirmed','failed')),
  prepared_json TEXT,
  provider_id TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE(job_id, step)
);
-- catalog-phase-statement
INSERT INTO external_operations_catalog_next(rowid,operation_id,job_id,step,request_hash,request_json,status,prepared_json,provider_id,result_json,error_code,started_at,completed_at)
SELECT rowid,operation_id,job_id,step,request_hash,request_json,status,prepared_json,provider_id,result_json,error_code,started_at,completed_at FROM external_operations;
-- catalog-phase-statement
CREATE TABLE external_operation_reconciliations_catalog_next (
  operation_id TEXT NOT NULL REFERENCES external_operations_catalog_next(operation_id),
  proof_sha256 TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, proof_sha256)
);
-- catalog-phase-statement
INSERT INTO external_operation_reconciliations_catalog_next(rowid,operation_id,proof_sha256,proof_json,observed_at)
SELECT rowid,operation_id,proof_sha256,proof_json,observed_at FROM external_operation_reconciliations;
-- catalog-phase-statement
CREATE TABLE publication_amendments_catalog_next (
  job_id TEXT PRIMARY KEY REFERENCES publication_jobs_catalog_next(job_id),
  amendment_sha256 TEXT NOT NULL UNIQUE,
  signed_json TEXT NOT NULL,
  predecessor_operation_id TEXT NOT NULL REFERENCES external_operations_catalog_next(operation_id),
  successor_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
-- catalog-phase-statement
INSERT INTO publication_amendments_catalog_next(rowid,job_id,amendment_sha256,signed_json,predecessor_operation_id,successor_operation_id,created_at)
SELECT rowid,job_id,amendment_sha256,signed_json,predecessor_operation_id,successor_operation_id,created_at FROM publication_amendments;
-- catalog-phase-statement
DROP TABLE publication_amendments;
-- catalog-phase-statement
DROP TABLE external_operation_reconciliations;
-- catalog-phase-statement
DROP TABLE external_operations;
-- catalog-phase-statement
DROP TABLE publication_jobs;
-- catalog-phase-statement
ALTER TABLE publication_jobs_catalog_next RENAME TO publication_jobs;
-- catalog-phase-statement
ALTER TABLE external_operations_catalog_next RENAME TO external_operations;
-- catalog-phase-statement
ALTER TABLE external_operation_reconciliations_catalog_next RENAME TO external_operation_reconciliations;
-- catalog-phase-statement
ALTER TABLE publication_amendments_catalog_next RENAME TO publication_amendments;
-- catalog-phase-statement
CREATE INDEX due_publication_jobs ON publication_jobs(phase, due_at, lease_until);
-- catalog-phase-statement
CREATE INDEX unfinished_external_operations ON external_operations(status, job_id);
-- catalog-phase-statement
DROP TABLE catalog_phase_schema_guard;
