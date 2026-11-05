ALTER TABLE creator_connections ADD COLUMN state_secret TEXT;
ALTER TABLE creator_connections ADD COLUMN verifier_secret TEXT;
ALTER TABLE creator_connections ADD COLUMN expired_receipt_json TEXT;
ALTER TABLE creator_connections ADD COLUMN retired_reason TEXT;
CREATE UNIQUE INDEX one_pending_creator_connection
  ON creator_connections(account_id, session_hash) WHERE consumed=0;
