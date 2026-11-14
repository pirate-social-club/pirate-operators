-- UNAPPLIED draft, no migration ordinal. Root selects actual D1 integration.
CREATE TABLE publication_catalog_obligations (
 job_id TEXT PRIMARY KEY REFERENCES publication_jobs(job_id), intent_json TEXT NOT NULL,
 intent_sha256 TEXT NOT NULL, reservation_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pending','reserved','posting','receipt','complete')),
 posting_json TEXT, chain_receipt_json TEXT, promotion_receipt_json TEXT
);
CREATE TRIGGER publication_catalog_identity BEFORE UPDATE ON publication_catalog_obligations
WHEN NEW.job_id<>OLD.job_id OR NEW.intent_json<>OLD.intent_json OR NEW.intent_sha256<>OLD.intent_sha256 OR NEW.reservation_id<>OLD.reservation_id
 OR (OLD.posting_json IS NOT NULL AND NEW.posting_json IS NOT OLD.posting_json)
 OR (OLD.chain_receipt_json IS NOT NULL AND NEW.chain_receipt_json IS NOT OLD.chain_receipt_json)
 OR (OLD.promotion_receipt_json IS NOT NULL AND NEW.promotion_receipt_json IS NOT OLD.promotion_receipt_json)
 OR (OLD.state='complete' AND NEW.state<>'complete')
BEGIN SELECT RAISE(ABORT,'catalog_obligation_identity_changed'); END;
CREATE TRIGGER publication_catalog_job_identity BEFORE UPDATE OF input_hash,authority_json,submission_id ON publication_jobs
WHEN EXISTS(SELECT 1 FROM publication_catalog_obligations WHERE job_id=OLD.job_id)
 AND (NEW.input_hash<>OLD.input_hash OR NEW.authority_json<>OLD.authority_json OR NEW.submission_id<>OLD.submission_id)
BEGIN SELECT RAISE(ABORT,'catalog_job_identity_changed'); END;
CREATE TRIGGER publication_catalog_completion BEFORE UPDATE OF phase ON publication_jobs
WHEN NEW.phase='published' AND json_extract(NEW.authority_json,'$.policy.version')='pirate-owner-catalog/2026-11-13/1'
 AND NOT EXISTS(SELECT 1 FROM publication_catalog_obligations WHERE job_id=NEW.job_id AND state='complete' AND promotion_receipt_json IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'catalog_pending'); END;
