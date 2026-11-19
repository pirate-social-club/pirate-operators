-- pirate.native-business-transition/1
-- UNNUMBERED / UNAPPLIED. ONE D1 batch, explicit framing preserves trigger bodies.
-- Additive metadata only: no existing table/index/trigger is altered or dropped.
-- The complete affected preimage is absence of every new name and incoming FK.
CREATE TABLE native_application_transition_guard(valid INTEGER NOT NULL CONSTRAINT native_business_schema_refusal CHECK(valid=1));
-- native-transition-statement
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
INSERT INTO native_application_transition_guard
SELECT CASE WHEN NOT EXISTS (
  SELECT type,name,tbl_name,sql FROM actual_runtime_metadata
  EXCEPT SELECT type,name,tbl_name,CAST(sql AS BLOB) FROM expected_runtime_metadata
) THEN 1 ELSE 0 END;
-- native-transition-statement
-- Metadata was attested by the preceding CHECK in this same D1 batch.
WITH incoming_tables AS MATERIALIZED (
  SELECT name FROM main.sqlite_schema
  WHERE type='table' AND name<>'_cf_METADATA'
)
INSERT INTO native_application_transition_guard SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE lower(name) IN (
    'native_application_original','native_business_bindings','native_readback_nonces','native_binding_guards',
    'native_original_no_update','native_original_no_delete','native_business_no_update',
    'native_nonce_no_update','native_nonce_no_delete'))
  AND NOT EXISTS(SELECT 1 FROM incoming_tables s JOIN pragma_foreign_key_list(s.name) f
    WHERE lower(f."table") IN (
      'native_application_original','native_business_bindings','native_readback_nonces','native_binding_guards',
      'native_application_transition_guard'))
  THEN 1 ELSE 0 END;
-- native-transition-statement
-- No unknown executable schema can refer to a future native table and
-- silently acquire a new effect when it is created. Global byte comparison;
-- no lossy SQL normalization or guessed textual dependency search.
WITH publication_consent_context(enabled) AS (VALUES (0)),
dance_publication_context(enabled) AS (VALUES (0)),
known(type,name,tbl_name,sql) AS(VALUES
  ('trigger','dance_accepted_submission_no_update','dance_reviews','CREATE TRIGGER dance_accepted_submission_no_update BEFORE UPDATE OF review_id,community_id,account_id,media_id,recording_digest,media_json,receipt_json ON dance_reviews BEGIN SELECT RAISE(ABORT,''dance_submission_immutable''); END'),
  ('trigger','dance_attempt_admission_no_delete','dance_attempt_admissions','CREATE TRIGGER dance_attempt_admission_no_delete BEFORE DELETE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,''dance_attempt_admission_immutable''); END'),
  ('trigger','dance_attempt_admission_no_update','dance_attempt_admissions','CREATE TRIGGER dance_attempt_admission_no_update BEFORE UPDATE ON dance_attempt_admissions BEGIN SELECT RAISE(ABORT,''dance_attempt_admission_immutable''); END'),
  ('trigger','dance_attempt_no_delete','dance_transaction_attempts','CREATE TRIGGER dance_attempt_no_delete BEFORE DELETE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,''dance_attempt_immutable''); END'),
  ('trigger','dance_attempt_no_update','dance_transaction_attempts','CREATE TRIGGER dance_attempt_no_update BEFORE UPDATE ON dance_transaction_attempts BEGIN SELECT RAISE(ABORT,''dance_attempt_immutable''); END'),
  ('trigger','dance_capture_no_delete','dance_captures','CREATE TRIGGER dance_capture_no_delete BEFORE DELETE ON dance_captures BEGIN SELECT RAISE(ABORT,''dance_capture_immutable''); END'),
  ('trigger','dance_capture_no_update','dance_captures','CREATE TRIGGER dance_capture_no_update BEFORE UPDATE ON dance_captures BEGIN SELECT RAISE(ABORT,''dance_capture_immutable''); END'),
  ('trigger','dance_consent_no_delete','dance_consents','CREATE TRIGGER dance_consent_no_delete BEFORE DELETE ON dance_consents BEGIN SELECT RAISE(ABORT,''dance_consent_immutable''); END'),
  ('trigger','dance_consent_no_update','dance_consents','CREATE TRIGGER dance_consent_no_update BEFORE UPDATE ON dance_consents BEGIN SELECT RAISE(ABORT,''dance_consent_immutable''); END'),
  ('trigger','dance_control_binding_no_delete','dance_control_bindings','CREATE TRIGGER dance_control_binding_no_delete BEFORE DELETE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,''dance_control_binding_immutable''); END'),
  ('trigger','dance_control_binding_no_update','dance_control_bindings','CREATE TRIGGER dance_control_binding_no_update BEFORE UPDATE ON dance_control_bindings BEGIN SELECT RAISE(ABORT,''dance_control_binding_immutable''); END'),
  ('trigger','dance_control_no_delete','dance_control_intents','CREATE TRIGGER dance_control_no_delete BEFORE DELETE ON dance_control_intents BEGIN SELECT RAISE(ABORT,''dance_control_immutable''); END'),
  ('trigger','dance_control_no_update','dance_control_intents','CREATE TRIGGER dance_control_no_update BEFORE UPDATE ON dance_control_intents BEGIN SELECT RAISE(ABORT,''dance_control_immutable''); END'),
  ('trigger','dance_control_observation_no_delete','dance_control_observations','CREATE TRIGGER dance_control_observation_no_delete BEFORE DELETE ON dance_control_observations BEGIN SELECT RAISE(ABORT,''dance_control_observation_immutable''); END'),
  ('trigger','dance_control_observation_no_update','dance_control_observations','CREATE TRIGGER dance_control_observation_no_update BEFORE UPDATE ON dance_control_observations BEGIN SELECT RAISE(ABORT,''dance_control_observation_immutable''); END'),
  ('trigger','dance_host_account_delete_generation','dance_host_accounts','CREATE TRIGGER dance_host_account_delete_generation AFTER DELETE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END'),
  ('trigger','dance_host_account_insert_generation','dance_host_accounts','CREATE TRIGGER dance_host_account_insert_generation AFTER INSERT ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END'),
  ('trigger','dance_host_account_revision','dance_host_accounts','CREATE TRIGGER dance_host_account_revision BEFORE UPDATE ON dance_host_accounts
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.account_id IS NOT OLD.account_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,''dance_host_revision''); END'),
  ('trigger','dance_host_account_update_generation','dance_host_accounts','CREATE TRIGGER dance_host_account_update_generation AFTER UPDATE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END'),
  ('trigger','dance_host_context_no_delete','dance_host_context','CREATE TRIGGER dance_host_context_no_delete BEFORE DELETE ON dance_host_context
 BEGIN SELECT RAISE(ABORT,''dance_host_context_retained''); END'),
  ('trigger','dance_host_context_no_replace','dance_host_context','CREATE TRIGGER dance_host_context_no_replace BEFORE INSERT ON dance_host_context
 WHEN EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=NEW.community_id)
 BEGIN SELECT RAISE(ABORT,''dance_host_context_retained''); END'),
  ('trigger','dance_host_context_revision','dance_host_context','CREATE TRIGGER dance_host_context_revision BEFORE UPDATE ON dance_host_context
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,''dance_host_revision''); END'),
  ('trigger','dance_host_probe_immutable_delete','dance_host_audio_probes','CREATE TRIGGER dance_host_probe_immutable_delete BEFORE DELETE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,''dance_host_probe_immutable''); END'),
  ('trigger','dance_host_probe_immutable_update','dance_host_audio_probes','CREATE TRIGGER dance_host_probe_immutable_update BEFORE UPDATE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,''dance_host_probe_immutable''); END'),
  ('trigger','dance_host_probe_no_replace','dance_host_audio_probes','CREATE TRIGGER dance_host_probe_no_replace BEFORE INSERT ON dance_host_audio_probes
 WHEN EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE community_id=NEW.community_id
   AND audio_sha256=NEW.audio_sha256 AND evidence_sha256=NEW.evidence_sha256)
 BEGIN SELECT RAISE(ABORT,''dance_host_probe_immutable''); END'),
  ('trigger','dance_host_selection_delete_generation','dance_host_selections','CREATE TRIGGER dance_host_selection_delete_generation AFTER DELETE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END'),
  ('trigger','dance_host_selection_insert_generation','dance_host_selections','CREATE TRIGGER dance_host_selection_insert_generation AFTER INSERT ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END'),
  ('trigger','dance_host_selection_revision','dance_host_selections','CREATE TRIGGER dance_host_selection_revision BEFORE UPDATE ON dance_host_selections
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.song_key IS NOT OLD.song_key
 OR NEW.reference_id IS NOT OLD.reference_id OR NEW.offer_id IS NOT OLD.offer_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,''dance_host_revision''); END'),
  ('trigger','dance_host_selection_update_generation','dance_host_selections','CREATE TRIGGER dance_host_selection_update_generation AFTER UPDATE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END'),
  ('trigger','dance_host_song_key_immutable_delete','dance_host_song_keys','CREATE TRIGGER dance_host_song_key_immutable_delete BEFORE DELETE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,''dance_host_song_key_immutable''); END'),
  ('trigger','dance_host_song_key_immutable_update','dance_host_song_keys','CREATE TRIGGER dance_host_song_key_immutable_update BEFORE UPDATE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,''dance_host_song_key_immutable''); END'),
  ('trigger','dance_host_song_key_no_replace','dance_host_song_keys','CREATE TRIGGER dance_host_song_key_no_replace BEFORE INSERT ON dance_host_song_keys
 WHEN EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=NEW.community_id
   AND (song_key=NEW.song_key OR post_id=NEW.post_id))
 BEGIN SELECT RAISE(ABORT,''dance_host_song_key_immutable''); END'),
  ('trigger','dance_intent_no_delete','dance_decision_intents','CREATE TRIGGER dance_intent_no_delete BEFORE DELETE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,''dance_intent_immutable''); END'),
  ('trigger','dance_intent_no_update','dance_decision_intents','CREATE TRIGGER dance_intent_no_update BEFORE UPDATE ON dance_decision_intents BEGIN SELECT RAISE(ABORT,''dance_intent_immutable''); END'),
  ('trigger','dance_observation_no_delete','dance_chain_observations','CREATE TRIGGER dance_observation_no_delete BEFORE DELETE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,''dance_observation_immutable''); END'),
  ('trigger','dance_observation_no_update','dance_chain_observations','CREATE TRIGGER dance_observation_no_update BEFORE UPDATE ON dance_chain_observations BEGIN SELECT RAISE(ABORT,''dance_observation_immutable''); END'),
  ('trigger','dance_outbox_no_delete','dance_outbox','CREATE TRIGGER dance_outbox_no_delete BEFORE DELETE ON dance_outbox BEGIN SELECT RAISE(ABORT,''dance_outbox_payload_immutable''); END'),
  ('trigger','dance_outbox_payload_no_update','dance_outbox','CREATE TRIGGER dance_outbox_payload_no_update BEFORE UPDATE OF command_id,community_id,subject_id,kind,payload_json,local_integrity_hash ON dance_outbox BEGIN SELECT RAISE(ABORT,''dance_outbox_payload_immutable''); END'),
  ('trigger','dance_receipt_no_delete','dance_receipts','CREATE TRIGGER dance_receipt_no_delete BEFORE DELETE ON dance_receipts BEGIN SELECT RAISE(ABORT,''dance_receipt_immutable''); END'),
  ('trigger','dance_receipt_no_update','dance_receipts','CREATE TRIGGER dance_receipt_no_update BEFORE UPDATE ON dance_receipts BEGIN SELECT RAISE(ABORT,''dance_receipt_immutable''); END'),
  ('trigger','dance_recovered_attempt_no_delete','dance_recovered_attempts','CREATE TRIGGER dance_recovered_attempt_no_delete BEFORE DELETE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,''dance_recovered_attempt_immutable''); END'),
  ('trigger','dance_recovered_attempt_no_update','dance_recovered_attempts','CREATE TRIGGER dance_recovered_attempt_no_update BEFORE UPDATE ON dance_recovered_attempts BEGIN SELECT RAISE(ABORT,''dance_recovered_attempt_immutable''); END'),
  ('trigger','dance_role_observation_no_delete','dance_reviewer_observations','CREATE TRIGGER dance_role_observation_no_delete BEFORE DELETE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,''dance_role_observation_immutable''); END'),
  ('trigger','dance_role_observation_no_update','dance_reviewer_observations','CREATE TRIGGER dance_role_observation_no_update BEFORE UPDATE ON dance_reviewer_observations BEGIN SELECT RAISE(ABORT,''dance_role_observation_immutable''); END'),
  ('trigger', 'dance_source3_request_no_delete', 'dance_source3_requests', 'CREATE TRIGGER dance_source3_request_no_delete BEFORE DELETE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,''dance_source3_original_retained''); END'),
  ('trigger', 'dance_source3_request_no_replace', 'dance_source3_requests', 'CREATE TRIGGER dance_source3_request_no_replace BEFORE INSERT ON dance_source3_requests
 WHEN EXISTS(SELECT 1 FROM dance_source3_requests WHERE
 (community_id=NEW.community_id AND account_id=NEW.account_id AND request_id=NEW.request_id)
 OR capture_id=NEW.capture_id)
 BEGIN SELECT RAISE(ABORT,''dance_source3_original_retained''); END'),
  ('trigger', 'dance_source3_request_no_update', 'dance_source3_requests', 'CREATE TRIGGER dance_source3_request_no_update BEFORE UPDATE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,''dance_source3_original_retained''); END'),
  ('trigger','learning_authority_capture','learning_authorizations','CREATE TRIGGER learning_authority_capture AFTER INSERT ON learning_authorizations
 BEGIN UPDATE learning_authorizations SET authority_epoch=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0)
 WHERE authorization_id=NEW.authorization_id; END'),
  ('trigger','learning_authority_challenge_capture','login_challenges','CREATE TRIGGER learning_authority_challenge_capture AFTER INSERT ON login_challenges
 BEGIN UPDATE login_challenges SET authority_epoch=COALESCE((SELECT h.revision FROM credential_bindings b
 JOIN learning_authority_heads h ON h.account_id=b.account_id
 WHERE b.namespace=''moss'' AND b.network=6343 AND b.subject=NEW.subject),0) WHERE challenge_id=NEW.challenge_id; END'),
  ('trigger','learning_authority_credential_delete','credential_bindings','CREATE TRIGGER learning_authority_credential_delete AFTER DELETE ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_credential_insert','credential_bindings','CREATE TRIGGER learning_authority_credential_insert AFTER INSERT ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_credential_update','credential_bindings','CREATE TRIGGER learning_authority_credential_update AFTER UPDATE OF binding_id,account_id,namespace,network,subject ON credential_bindings
 WHEN OLD.binding_id IS NOT NEW.binding_id OR OLD.account_id IS NOT NEW.account_id OR OLD.namespace IS NOT NEW.namespace OR OLD.network IS NOT NEW.network OR OLD.subject IS NOT NEW.subject
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_credentials(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_insert_hold','learning_authorizations','CREATE TRIGGER learning_authority_insert_hold BEFORE INSERT ON learning_authorizations
 WHEN EXISTS(SELECT 1 FROM learning_authority_heads h WHERE h.account_id=NEW.account_id AND h.pending_operation IS NOT NULL)
 OR EXISTS(SELECT 1 FROM learning_authority_dirty d WHERE d.account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM login_challenges c WHERE c.subject=NEW.subject AND c.message=NEW.message AND c.kind=''sign-in-v4''
   AND c.authority_epoch!=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0))
 BEGIN SELECT RAISE(IGNORE); END'),
  ('trigger','learning_authority_member_delete','learning_authority_members','CREATE TRIGGER learning_authority_member_delete AFTER DELETE ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id; END'),
  ('trigger','learning_authority_member_insert','learning_authority_members','CREATE TRIGGER learning_authority_member_insert AFTER INSERT ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=NEW.operation_id; END'),
  ('trigger','learning_authority_member_update','learning_authority_members','CREATE TRIGGER learning_authority_member_update AFTER UPDATE OF operation_id,authorization_id ON learning_authority_members
 WHEN OLD.operation_id IS NOT NEW.operation_id OR OLD.authorization_id IS NOT NEW.authorization_id
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id OR operation_id=NEW.operation_id; END'),
  ('trigger','learning_authority_off_insert','learning_settings','CREATE TRIGGER learning_authority_off_insert AFTER INSERT ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END'),
  ('trigger','learning_authority_off_update','learning_settings','CREATE TRIGGER learning_authority_off_update AFTER UPDATE OF public_results_withdrawn_at,last_withdrawn_at ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL AND (OLD.public_results_withdrawn_at IS NULL OR NEW.last_withdrawn_at IS NOT OLD.last_withdrawn_at)
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END'),
  ('trigger','learning_authority_original_delete','learning_authorizations','CREATE TRIGGER learning_authority_original_delete AFTER DELETE ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_original_insert','learning_authorizations','CREATE TRIGGER learning_authority_original_insert AFTER INSERT ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_original_update','learning_authorizations','CREATE TRIGGER learning_authority_original_update AFTER UPDATE OF authorization_id,account_id,subject,issued_at,authority_epoch,message,sign_in_json,signature,policy_hash,policy_version ON learning_authorizations
 WHEN OLD.authorization_id IS NOT NEW.authorization_id OR OLD.account_id IS NOT NEW.account_id OR OLD.subject IS NOT NEW.subject
 OR OLD.issued_at IS NOT NEW.issued_at OR OLD.authority_epoch IS NOT NEW.authority_epoch OR OLD.message IS NOT NEW.message
 OR OLD.sign_in_json IS NOT NEW.sign_in_json OR OLD.signature IS NOT NEW.signature OR OLD.policy_hash IS NOT NEW.policy_hash OR OLD.policy_version IS NOT NEW.policy_version
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_original_heads(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END'),
  ('trigger','learning_authority_withdrawal_identity','learning_authority_withdrawals','CREATE TRIGGER learning_authority_withdrawal_identity AFTER INSERT ON learning_authority_withdrawals
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END'),
  ('trigger','publication_catalog_completion','publication_jobs','CREATE TRIGGER publication_catalog_completion BEFORE UPDATE OF phase ON publication_jobs
WHEN NEW.phase=''published'' AND json_extract(NEW.authority_json,''$.policy.version'')=''pirate-owner-catalog/2026-11-13/1''
 AND NOT EXISTS(SELECT 1 FROM publication_catalog_obligations WHERE job_id=NEW.job_id AND state=''complete'' AND promotion_receipt_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,''catalog_pending''); END'),
  ('trigger','publication_catalog_identity','publication_catalog_obligations','CREATE TRIGGER publication_catalog_identity BEFORE UPDATE ON publication_catalog_obligations
WHEN NEW.job_id<>OLD.job_id OR NEW.intent_json<>OLD.intent_json OR NEW.intent_sha256<>OLD.intent_sha256 OR NEW.reservation_id<>OLD.reservation_id
 OR (OLD.posting_json IS NOT NULL AND NEW.posting_json IS NOT OLD.posting_json)
 OR (OLD.chain_receipt_json IS NOT NULL AND NEW.chain_receipt_json IS NOT OLD.chain_receipt_json)
 OR (OLD.promotion_receipt_json IS NOT NULL AND NEW.promotion_receipt_json IS NOT OLD.promotion_receipt_json)
 OR (OLD.state=''complete'' AND NEW.state<>''complete'')
BEGIN SELECT RAISE(ABORT,''catalog_obligation_identity_changed''); END'),
  ('trigger','publication_catalog_job_identity','publication_jobs','CREATE TRIGGER publication_catalog_job_identity BEFORE UPDATE OF input_hash,authority_json,submission_id ON publication_jobs
WHEN EXISTS(SELECT 1 FROM publication_catalog_obligations WHERE job_id=OLD.job_id)
 AND (NEW.input_hash<>OLD.input_hash OR NEW.authority_json<>OLD.authority_json OR NEW.submission_id<>OLD.submission_id)
BEGIN SELECT RAISE(ABORT,''catalog_job_identity_changed''); END')
),
expected_consent_trigger(type,name,tbl_name,sql) AS (
  VALUES
    ('trigger', 'publication_v1_archive_delete', 'publication_v1_release_archive', 'CREATE TRIGGER publication_v1_archive_delete BEFORE DELETE ON publication_v1_release_archive
BEGIN SELECT RAISE(ABORT,''publication_release_archive_immutable''); END'),
    ('trigger', 'publication_v1_archive_insert', 'publication_v1_release_archive', 'CREATE TRIGGER publication_v1_archive_insert BEFORE INSERT ON publication_v1_release_archive
WHEN EXISTS(SELECT 1 FROM publication_v1_release_archive
  WHERE community_id=NEW.community_id AND release_sha256=NEW.release_sha256)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM publication_v1_release_archive
    WHERE community_id=NEW.community_id AND release_sha256=NEW.release_sha256
    AND (release_json IS NOT NEW.release_json OR transport_ref IS NOT NEW.transport_ref))
    THEN RAISE(ABORT,''publication_retained_release_changed'') END;
  SELECT RAISE(IGNORE);
END'),
    ('trigger', 'publication_v1_archive_update', 'publication_v1_release_archive', 'CREATE TRIGGER publication_v1_archive_update BEFORE UPDATE ON publication_v1_release_archive
BEGIN SELECT RAISE(ABORT,''publication_release_archive_immutable''); END'),
    ('trigger', 'publication_v1_command_delete', 'publication_v1_commands', 'CREATE TRIGGER publication_v1_command_delete BEFORE DELETE ON publication_v1_commands
BEGIN SELECT RAISE(ABORT,''publication_command_immutable''); END'),
    ('trigger', 'publication_v1_command_first_bytes', 'publication_v1_commands', 'CREATE TRIGGER publication_v1_command_first_bytes BEFORE UPDATE ON publication_v1_commands
WHEN (OLD.fence_generation IS NOT NULL AND NEW.fence_generation IS NOT OLD.fence_generation)
  OR (OLD.typed_json IS NOT NULL AND NEW.typed_json IS NOT OLD.typed_json)
  OR (OLD.digest IS NOT NULL AND NEW.digest IS NOT OLD.digest)
  OR (OLD.signature IS NOT NULL AND NEW.signature IS NOT OLD.signature)
  OR (OLD.accepted_json IS NOT NULL AND NEW.accepted_json IS NOT OLD.accepted_json)
  OR (OLD.fence_ack_json IS NOT NULL AND NEW.fence_ack_json IS NOT OLD.fence_ack_json)
BEGIN SELECT RAISE(ABORT,''publication_first_bytes_immutable''); END'),
    ('trigger', 'publication_v1_command_insert', 'publication_v1_commands', 'CREATE TRIGGER publication_v1_command_insert BEFORE INSERT ON publication_v1_commands
WHEN EXISTS(SELECT 1 FROM publication_v1_commands WHERE command_id=NEW.command_id
  OR (community_id=NEW.community_id AND account_id=NEW.account_id
    AND source_id=NEW.source_id AND purpose=NEW.purpose
    AND action=NEW.action AND request_id=NEW.request_id))
BEGIN SELECT RAISE(IGNORE); END'),
    ('trigger', 'publication_v1_command_original', 'publication_v1_commands', 'CREATE TRIGGER publication_v1_command_original BEFORE UPDATE ON publication_v1_commands
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.community_id IS NOT OLD.community_id
  OR NEW.account_id IS NOT OLD.account_id OR NEW.source_id IS NOT OLD.source_id
  OR NEW.purpose IS NOT OLD.purpose OR NEW.action IS NOT OLD.action
  OR NEW.request_id IS NOT OLD.request_id OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.request_json IS NOT OLD.request_json OR NEW.nonce_hex IS NOT OLD.nonce_hex
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,''publication_command_immutable''); END'),
    ('trigger', 'publication_v1_command_progress', 'publication_v1_commands', 'CREATE TRIGGER publication_v1_command_progress BEFORE UPDATE ON publication_v1_commands
WHEN NEW.version < OLD.version
  OR (OLD.phase=''accepted'' AND NEW.phase!=''accepted'')
  OR (OLD.phase=''prepared'' AND NEW.phase=''preparing'')
BEGIN SELECT RAISE(ABORT,''publication_command_regression''); END'),
    ('trigger', 'publication_v1_head_delete', 'publication_v1_heads', 'CREATE TRIGGER publication_v1_head_delete BEFORE DELETE ON publication_v1_heads
BEGIN SELECT RAISE(ABORT,''publication_head_immutable''); END'),
    ('trigger', 'publication_v1_head_insert', 'publication_v1_heads', 'CREATE TRIGGER publication_v1_head_insert BEFORE INSERT ON publication_v1_heads
WHEN EXISTS(SELECT 1 FROM publication_v1_heads WHERE community_id=NEW.community_id
  AND account_id=NEW.account_id AND source_id=NEW.source_id AND purpose=NEW.purpose)
BEGIN SELECT RAISE(IGNORE); END'),
    ('trigger', 'publication_v1_head_original', 'publication_v1_heads', 'CREATE TRIGGER publication_v1_head_original BEFORE UPDATE ON publication_v1_heads
WHEN NEW.community_id IS NOT OLD.community_id OR NEW.account_id IS NOT OLD.account_id
  OR NEW.source_id IS NOT OLD.source_id OR NEW.purpose IS NOT OLD.purpose
BEGIN SELECT RAISE(ABORT,''publication_head_immutable''); END'),
    ('trigger', 'publication_v1_head_progress', 'publication_v1_heads', 'CREATE TRIGGER publication_v1_head_progress BEFORE UPDATE ON publication_v1_heads
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT,''publication_head_regression''); END'),
    ('trigger', 'publication_v1_install_delete', 'publication_v1_installed_selection', 'CREATE TRIGGER publication_v1_install_delete BEFORE DELETE ON publication_v1_installed_selection
BEGIN SELECT RAISE(ABORT,''publication_installation_immutable''); END'),
    ('trigger', 'publication_v1_install_identity', 'publication_v1_installed_selection', 'CREATE TRIGGER publication_v1_install_identity BEFORE UPDATE ON publication_v1_installed_selection
WHEN NEW.community_id IS NOT OLD.community_id
BEGIN SELECT RAISE(ABORT,''publication_installation_immutable''); END'),
    ('trigger', 'publication_v1_install_insert', 'publication_v1_installed_selection', 'CREATE TRIGGER publication_v1_install_insert BEFORE INSERT ON publication_v1_installed_selection
WHEN EXISTS(SELECT 1 FROM publication_v1_installed_selection WHERE community_id=NEW.community_id)
BEGIN SELECT RAISE(IGNORE); END'),
    ('trigger', 'publication_v1_install_progress', 'publication_v1_installed_selection', 'CREATE TRIGGER publication_v1_install_progress BEFORE UPDATE ON publication_v1_installed_selection
WHEN NEW.incarnation != OLD.incarnation+1 OR NEW.incarnation>=9007199254740991
BEGIN SELECT RAISE(ABORT,''publication_installation_progression''); END'),
    ('trigger', 'publication_v1_observation_delete', 'publication_v1_observations', 'CREATE TRIGGER publication_v1_observation_delete BEFORE DELETE ON publication_v1_observations
BEGIN SELECT RAISE(ABORT,''publication_observation_immutable''); END'),
    ('trigger', 'publication_v1_observation_insert', 'publication_v1_observations', 'CREATE TRIGGER publication_v1_observation_insert BEFORE INSERT ON publication_v1_observations
WHEN EXISTS(SELECT 1 FROM publication_v1_observations
  WHERE command_id=NEW.command_id AND proof_hash=NEW.proof_hash)
BEGIN SELECT RAISE(IGNORE); END'),
    ('trigger', 'publication_v1_observation_update', 'publication_v1_observations', 'CREATE TRIGGER publication_v1_observation_update BEFORE UPDATE ON publication_v1_observations
BEGIN SELECT RAISE(ABORT,''publication_observation_immutable''); END')
),
expected_dance_publication_trigger(type,name,tbl_name,sql) AS (
  VALUES
    ('trigger', 'dance_publication_binding_delete', 'dance_publication_bindings', 'CREATE TRIGGER dance_publication_binding_delete BEFORE DELETE ON dance_publication_bindings BEGIN SELECT RAISE(ABORT,''dance_publication_binding_immutable''); END'),
    ('trigger', 'dance_publication_binding_insert', 'dance_publication_bindings', 'CREATE TRIGGER dance_publication_binding_insert BEFORE INSERT ON dance_publication_bindings WHEN EXISTS(SELECT 1 FROM dance_publication_bindings WHERE (community_id=NEW.community_id AND capture_id=NEW.capture_id AND account_id=NEW.account_id AND purpose=NEW.purpose) OR (capture_hash=NEW.capture_hash AND account_id=NEW.account_id AND purpose=NEW.purpose)) BEGIN SELECT RAISE(ABORT,''dance_publication_binding_immutable''); END'),
    ('trigger', 'dance_publication_binding_update', 'dance_publication_bindings', 'CREATE TRIGGER dance_publication_binding_update BEFORE UPDATE ON dance_publication_bindings BEGIN SELECT RAISE(ABORT,''dance_publication_binding_immutable''); END'),
    ('trigger', 'dance_publication_start_no_delete', 'dance_publication_starts', 'CREATE TRIGGER dance_publication_start_no_delete BEFORE DELETE ON dance_publication_starts BEGIN SELECT RAISE(ABORT,''dance_publication_start_immutable''); END'),
    ('trigger', 'dance_publication_start_no_replace', 'dance_publication_starts', 'CREATE TRIGGER dance_publication_start_no_replace BEFORE INSERT ON dance_publication_starts WHEN EXISTS(SELECT 1 FROM dance_publication_starts WHERE (community_id=NEW.community_id AND account_id=NEW.account_id AND command_id=NEW.command_id) OR capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,''dance_publication_start_immutable''); END'),
    ('trigger', 'dance_publication_start_no_update', 'dance_publication_starts', 'CREATE TRIGGER dance_publication_start_no_update BEFORE UPDATE ON dance_publication_starts BEGIN SELECT RAISE(ABORT,''dance_publication_start_immutable''); END'),
    ('trigger', 'dance_v2_action_originals_no_delete', 'dance_v2_action_originals', 'CREATE TRIGGER dance_v2_action_originals_no_delete BEFORE DELETE ON dance_v2_action_originals BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_action_originals_no_replace', 'dance_v2_action_originals', 'CREATE TRIGGER dance_v2_action_originals_no_replace BEFORE INSERT ON dance_v2_action_originals WHEN EXISTS(SELECT 1 FROM dance_v2_action_originals WHERE command_id=NEW.command_id OR (community_id=NEW.community_id AND capture_id=NEW.capture_id AND kind=NEW.kind)) BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_action_originals_no_update', 'dance_v2_action_originals', 'CREATE TRIGGER dance_v2_action_originals_no_update BEFORE UPDATE ON dance_v2_action_originals BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_dispatch_sessions_no_delete', 'dance_v2_dispatch_sessions', 'CREATE TRIGGER dance_v2_dispatch_sessions_no_delete BEFORE DELETE ON dance_v2_dispatch_sessions BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_dispatch_sessions_no_replace', 'dance_v2_dispatch_sessions', 'CREATE TRIGGER dance_v2_dispatch_sessions_no_replace BEFORE INSERT ON dance_v2_dispatch_sessions WHEN EXISTS(SELECT 1 FROM dance_v2_dispatch_sessions WHERE command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_dispatch_sessions_no_update', 'dance_v2_dispatch_sessions', 'CREATE TRIGGER dance_v2_dispatch_sessions_no_update BEFORE UPDATE ON dance_v2_dispatch_sessions BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_ready_commands_no_delete', 'dance_v2_ready_commands', 'CREATE TRIGGER dance_v2_ready_commands_no_delete BEFORE DELETE ON dance_v2_ready_commands BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_ready_commands_no_replace', 'dance_v2_ready_commands', 'CREATE TRIGGER dance_v2_ready_commands_no_replace BEFORE INSERT ON dance_v2_ready_commands WHEN EXISTS(SELECT 1 FROM dance_v2_ready_commands WHERE command_id=NEW.command_id) BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END'),
    ('trigger', 'dance_v2_ready_commands_no_update', 'dance_v2_ready_commands', 'CREATE TRIGGER dance_v2_ready_commands_no_update BEFORE UPDATE ON dance_v2_ready_commands BEGIN SELECT RAISE(ABORT,''dance_v2_action_immutable''); END')
),
selected_optional_trigger AS (
  SELECT type,name,tbl_name,CAST(sql AS BLOB) AS sql FROM expected_consent_trigger
  WHERE (SELECT enabled FROM publication_consent_context)=1
  UNION ALL
  SELECT type,name,tbl_name,CAST(sql AS BLOB) AS sql FROM expected_dance_publication_trigger
  WHERE (SELECT enabled FROM dance_publication_context)=1
),
allowed_executable AS (
  SELECT type,name,tbl_name,CAST(sql AS BLOB) AS sql FROM known
  UNION ALL SELECT type,name,tbl_name,sql FROM selected_optional_trigger
),
actual_executable AS (
  SELECT type,name,tbl_name,CAST(sql AS BLOB) AS sql FROM sqlite_schema WHERE type IN ('trigger','view')
)
INSERT INTO native_application_transition_guard
SELECT CASE WHEN NOT EXISTS(
 SELECT type,name,tbl_name,sql FROM actual_executable
 EXCEPT SELECT type,name,tbl_name,sql FROM allowed_executable
) AND NOT EXISTS(
 SELECT type,name,tbl_name,sql FROM selected_optional_trigger
 EXCEPT SELECT type,name,tbl_name,sql FROM actual_executable
) THEN 1 ELSE 0 END;
-- native-transition-statement
-- Exact immutable FK-parent definitions. Extra parent indexes are retained;
-- no parent table/index/trigger or incoming reference is rebuilt or removed.
WITH expected(name,sql) AS(VALUES
('community_media','CREATE TABLE community_media (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ready_at INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  UNIQUE(community_id, account_id, request_id)
)'),
('community_sessions','CREATE TABLE community_sessions (
  session_hash TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  community_origin TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  binding_id TEXT NOT NULL REFERENCES credential_bindings(binding_id),
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)'),
('media_submissions','CREATE TABLE media_submissions (
  submission_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  author_id TEXT NOT NULL,
  post_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  captured_wallet TEXT NOT NULL,
  creator_json TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_bytes INTEGER NOT NULL CHECK(audio_bytes BETWEEN 1 AND 26214400),
  object_key TEXT NOT NULL UNIQUE,
  upload_state TEXT NOT NULL CHECK(upload_state IN (''reserved'',''uploading'',''uploaded'',''sealed'')),
  upload_lease TEXT,
  upload_lease_until INTEGER NOT NULL DEFAULT 0,
  object_etag TEXT,
  created_at INTEGER NOT NULL,
  sealed_at INTEGER,
  UNIQUE(account_id, idempotency_key)
)')
)
INSERT INTO native_application_transition_guard
SELECT CASE WHEN NOT EXISTS(
 SELECT name,CAST(sql AS BLOB) FROM expected
 EXCEPT SELECT name,CAST(sql AS BLOB) FROM sqlite_schema WHERE type='table'
) THEN 1 ELSE 0 END;
-- native-transition-statement
WITH expected(cid,name,type,notnull_value,dflt_value,pk,hidden) AS(VALUES
(0,'lesson_id','TEXT',0,NULL,1,0),
(1,'account_id','TEXT',1,NULL,0,0),
(2,'community_id','TEXT',1,NULL,0,0),
(3,'request_id','TEXT',1,NULL,0,0),
(4,'song_json','TEXT',1,NULL,0,0),
(5,'state_json','TEXT',1,NULL,0,0),
(6,'revision','INTEGER',1,'0',0,0),
(7,'started_at','INTEGER',1,NULL,0,0),
(8,'history_deleted_at','INTEGER',0,NULL,0,0),
(9,'history_cleanup_attempts','INTEGER',1,'0',0,0)
)
INSERT INTO native_application_transition_guard
SELECT CASE WHEN NOT EXISTS(
 SELECT cid,name,type,notnull_value,dflt_value,pk,hidden FROM expected
 EXCEPT SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo('study_lessons')
) AND NOT EXISTS(
 SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo('study_lessons')
 EXCEPT SELECT cid,name,type,notnull_value,dflt_value,pk,hidden FROM expected
) AND NOT EXISTS(SELECT 1 FROM pragma_foreign_key_list('study_lessons'))
AND (SELECT CAST(sql AS BLOB) FROM sqlite_schema WHERE type='table' AND name='study_lessons')=CAST('CREATE TABLE study_lessons (
  lesson_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  song_json TEXT NOT NULL CHECK(json_valid(song_json)),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, history_deleted_at INTEGER, history_cleanup_attempts INTEGER NOT NULL DEFAULT 0
  CHECK(history_cleanup_attempts>=0),
  UNIQUE(account_id,community_id,request_id),
  UNIQUE(lesson_id,account_id,community_id)
)' AS BLOB)
AND (SELECT count(*) FROM pragma_index_list('study_lessons') WHERE origin='u')=2
AND EXISTS(SELECT 1 FROM pragma_index_list('study_lessons') i
 WHERE i.origin='u' AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))='account_id,community_id,request_id')
AND EXISTS(SELECT 1 FROM pragma_index_list('study_lessons') i
 WHERE i.origin='u' AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info(i.name) ORDER BY seqno))='lesson_id,account_id,community_id')
THEN 1 ELSE 0 END;
-- native-transition-statement
CREATE TABLE native_application_original(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  original_digest TEXT NOT NULL UNIQUE CHECK(length(original_digest)=64),
  original_json TEXT NOT NULL CHECK(json_valid(original_json))
);
-- native-transition-statement
CREATE TABLE native_business_bindings(
  kind TEXT NOT NULL CHECK(kind IN ('session','media','learning','submission')),
  record_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  original_digest TEXT NOT NULL REFERENCES native_application_original(original_digest),
  session_hash TEXT UNIQUE REFERENCES community_sessions(session_hash) ON DELETE CASCADE,
  media_id TEXT UNIQUE REFERENCES community_media(id) ON DELETE CASCADE,
  lesson_id TEXT UNIQUE REFERENCES study_lessons(lesson_id) ON DELETE CASCADE,
  submission_id TEXT UNIQUE REFERENCES media_submissions(submission_id) ON DELETE CASCADE,
  proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json)),
  PRIMARY KEY(kind,record_id),
  CHECK((kind='session' AND session_hash IS NOT NULL AND record_id=session_hash AND media_id IS NULL AND lesson_id IS NULL AND submission_id IS NULL AND proof_json IS NOT NULL)
     OR (kind='media' AND media_id IS NOT NULL AND record_id=media_id AND session_hash IS NULL AND lesson_id IS NULL AND submission_id IS NULL AND proof_json IS NULL)
     OR (kind='learning' AND lesson_id IS NOT NULL AND record_id=lesson_id AND session_hash IS NULL AND media_id IS NULL AND submission_id IS NULL AND proof_json IS NULL)
     OR (kind='submission' AND submission_id IS NOT NULL AND record_id=submission_id AND session_hash IS NULL AND media_id IS NULL AND lesson_id IS NULL AND proof_json IS NOT NULL))
);
-- native-transition-statement
CREATE TABLE native_readback_nonces(nonce TEXT PRIMARY KEY CHECK(length(nonce)=64),expires_at INTEGER NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),current_json TEXT NOT NULL CHECK(json_valid(current_json)));
-- native-transition-statement
CREATE TABLE native_binding_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
-- native-transition-statement
CREATE TRIGGER native_original_no_update BEFORE UPDATE ON native_application_original BEGIN SELECT RAISE(ABORT,'native_original_immutable'); END;
-- native-transition-statement
CREATE TRIGGER native_original_no_delete BEFORE DELETE ON native_application_original BEGIN SELECT RAISE(ABORT,'native_original_immutable'); END;
-- native-transition-statement
CREATE TRIGGER native_business_no_update BEFORE UPDATE ON native_business_bindings BEGIN SELECT RAISE(ABORT,'native_business_binding_immutable'); END;
-- native-transition-statement
CREATE TRIGGER native_nonce_no_update BEFORE UPDATE ON native_readback_nonces BEGIN SELECT RAISE(ABORT,'native_nonce_immutable'); END;
-- native-transition-statement
CREATE TRIGGER native_nonce_no_delete BEFORE DELETE ON native_readback_nonces BEGIN SELECT RAISE(ABORT,'native_nonce_immutable'); END;
-- native-transition-statement
DROP TABLE native_application_transition_guard;
