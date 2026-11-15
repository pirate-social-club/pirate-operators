-- Unnumbered fresh-service schema. Integration owns migration selection.
CREATE TABLE shared_recognition_catalog_revision (
  namespace TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  enrollment_token TEXT
);
CREATE TABLE shared_recognition_recordings (
  recording_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  creator_key TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_bytes INTEGER NOT NULL CHECK(audio_bytes > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','upload_unknown','processing','verification_unknown','ready','failed','deleting','deleted')),
  provider_file_id TEXT,
  provider_match_id TEXT,
  claim_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  UNIQUE(namespace, audio_sha256),
  UNIQUE(namespace, provider_match_id)
);
CREATE TABLE shared_recognition_publications (
  association_id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES shared_recognition_recordings(recording_id),
  namespace TEXT NOT NULL,
  community_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  publication_revision INTEGER NOT NULL CHECK(publication_revision > 0),
  publication_json TEXT NOT NULL,
  match_evidence_sha256 TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','withdrawn')),
  UNIQUE(namespace, community_id, post_id, publication_revision)
);
CREATE INDEX shared_recognition_active ON shared_recognition_publications(recording_id, state, publication_revision DESC, association_id);
CREATE INDEX shared_recognition_pending ON shared_recognition_recordings(namespace, state);
CREATE TRIGGER shared_recognition_catalog_changed AFTER UPDATE OF state ON shared_recognition_recordings
WHEN OLD.state<>NEW.state
BEGIN UPDATE shared_recognition_catalog_revision SET revision=revision+1 WHERE namespace=NEW.namespace; END;
CREATE TABLE shared_recognition_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  recording_id TEXT NOT NULL REFERENCES shared_recognition_recordings(recording_id),
  kind TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER shared_recognition_recording_conflict BEFORE INSERT ON shared_recognition_recordings
WHEN EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=NEW.recording_id
  AND (r.namespace<>NEW.namespace OR r.creator_key<>NEW.creator_key OR r.audio_sha256<>NEW.audio_sha256 OR r.audio_bytes<>NEW.audio_bytes))
BEGIN SELECT RAISE(ABORT,'recognition_recording_conflict'); END;
CREATE TRIGGER shared_recognition_publication_conflict BEFORE INSERT ON shared_recognition_publications
WHEN EXISTS(SELECT 1 FROM shared_recognition_publications p WHERE p.association_id=NEW.association_id
  AND (p.publication_json<>NEW.publication_json OR p.recording_id<>NEW.recording_id
    OR p.match_evidence_sha256 IS NOT NEW.match_evidence_sha256))
  OR EXISTS(SELECT 1 FROM shared_recognition_publications p WHERE p.namespace=NEW.namespace
    AND p.community_id=NEW.community_id AND p.post_id=NEW.post_id AND p.publication_revision>NEW.publication_revision)
  OR NOT EXISTS(SELECT 1 FROM shared_recognition_recordings r WHERE r.recording_id=NEW.recording_id
    AND r.namespace=NEW.namespace AND r.creator_key=json_extract(NEW.publication_json,'$.creatorKey')
    AND r.state NOT IN ('deleting','deleted','failed'))
BEGIN SELECT RAISE(ABORT,'recognition_publication_conflict'); END;
CREATE TABLE shared_recognition_request_nonces (
  namespace TEXT NOT NULL,
  community_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  wire_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(namespace,community_id,nonce)
);

-- UNAPPLIED additive upgrade draft for exact REC008 service schema; no ordinal.
-- Fresh schema.sql already contains these statements; never apply both copies.
CREATE TABLE shared_recognition_installation (
 namespace TEXT PRIMARY KEY, profile_sha256 TEXT NOT NULL, journal_epoch TEXT NOT NULL,
 restore_anchor_sha256 TEXT NOT NULL
);
CREATE TABLE shared_recognition_reservations (
 reservation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, community_id TEXT NOT NULL,
 job_id TEXT NOT NULL, intent_json TEXT NOT NULL, intent_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','identification_unknown','enrollment_pending','ready','committing','committed','cancelled','held')),
 recording_id TEXT REFERENCES shared_recognition_recordings(recording_id),
 posting_json TEXT, publication_json TEXT, disposition_sha256 TEXT,
 UNIQUE(namespace,community_id,job_id)
);
CREATE INDEX shared_recognition_provisional ON shared_recognition_reservations(recording_id,state);
CREATE TABLE shared_recognition_original_gate (namespace TEXT PRIMARY KEY, reservation_id TEXT);
CREATE TABLE shared_recognition_original_calls (
 operation_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES shared_recognition_reservations(reservation_id),
 request_sha256 TEXT NOT NULL, catalog_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('unknown','received')),
 receipt_json TEXT, started_at INTEGER NOT NULL
);
CREATE TABLE shared_recognition_quota_limits (scope TEXT PRIMARY KEY, ceiling INTEGER NOT NULL CHECK(ceiling>=0));
CREATE TABLE shared_recognition_quota_charges (
 operation_id TEXT NOT NULL, scope TEXT NOT NULL REFERENCES shared_recognition_quota_limits(scope),
 PRIMARY KEY(operation_id,scope)
);
CREATE TRIGGER recognition_reservation_immutable BEFORE UPDATE ON shared_recognition_reservations
WHEN NEW.intent_json<>OLD.intent_json OR NEW.intent_sha256<>OLD.intent_sha256 OR
 NEW.namespace<>OLD.namespace OR NEW.community_id<>OLD.community_id OR NEW.job_id<>OLD.job_id OR
 (OLD.recording_id IS NOT NULL AND NEW.recording_id IS NOT OLD.recording_id) OR
 (OLD.posting_json IS NOT NULL AND NEW.posting_json IS NOT OLD.posting_json) OR
 (OLD.publication_json IS NOT NULL AND NEW.publication_json IS NOT OLD.publication_json)
BEGIN SELECT RAISE(ABORT,'recognition_reservation_conflict'); END;
CREATE TRIGGER recognition_reservation_insert_conflict BEFORE INSERT ON shared_recognition_reservations
WHEN EXISTS(SELECT 1 FROM shared_recognition_reservations r WHERE
 (r.reservation_id=NEW.reservation_id OR (r.namespace=NEW.namespace AND r.community_id=NEW.community_id AND r.job_id=NEW.job_id))
 AND (r.reservation_id<>NEW.reservation_id OR r.intent_json<>NEW.intent_json))
BEGIN SELECT RAISE(ABORT,'recognition_reservation_conflict'); END;
CREATE TRIGGER recognition_quota_immutable BEFORE UPDATE ON shared_recognition_quota_limits
BEGIN SELECT RAISE(ABORT,'recognition_quota_changed'); END;
CREATE TRIGGER recognition_quota_charge_limit BEFORE INSERT ON shared_recognition_quota_charges
WHEN NOT EXISTS(SELECT 1 FROM shared_recognition_quota_charges WHERE operation_id=NEW.operation_id AND scope=NEW.scope)
 AND (SELECT COUNT(*) FROM shared_recognition_quota_charges WHERE scope=NEW.scope)>=(SELECT ceiling FROM shared_recognition_quota_limits WHERE scope=NEW.scope)
BEGIN SELECT RAISE(ABORT,'recognition_quota_exhausted'); END;
