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
