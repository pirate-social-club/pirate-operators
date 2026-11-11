
CREATE TABLE learning_authority_heads(
 account_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, permission_revision INTEGER NOT NULL DEFAULT 0,
 pending_operation TEXT, processed_withdrawn_at INTEGER
);
CREATE TABLE learning_authority_operations(
 operation_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, action_id TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), epoch INTEGER NOT NULL,
 cursor TEXT, sealed INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
 transition_id TEXT, error TEXT, dirty_version INTEGER, original_revision INTEGER, updated_at INTEGER NOT NULL,
 UNIQUE(account_id,action_id)
);
CREATE INDEX learning_authority_pending ON learning_authority_operations(complete,updated_at,operation_id);
CREATE TABLE learning_authority_pages(
 operation_id TEXT NOT NULL, page_id TEXT NOT NULL,
 page_json TEXT NOT NULL CHECK(json_valid(page_json)), acknowledged INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(operation_id,page_id)
);
CREATE TABLE learning_authority_members(
 operation_id TEXT NOT NULL, authorization_id TEXT NOT NULL, acknowledgment TEXT,
 PRIMARY KEY(operation_id,authorization_id)
);
CREATE TABLE learning_authority_dirty(account_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, error TEXT);
CREATE TABLE learning_authority_original_heads(account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO learning_authority_original_heads(account_id) SELECT DISTINCT account_id FROM learning_authorizations;
ALTER TABLE learning_authorizations ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_challenges ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER learning_authority_challenge_capture AFTER INSERT ON login_challenges
 BEGIN UPDATE login_challenges SET authority_epoch=COALESCE((SELECT h.revision FROM credential_bindings b
 JOIN learning_authority_heads h ON h.account_id=b.account_id
 WHERE b.namespace='moss' AND b.network=6343 AND b.subject=NEW.subject),0) WHERE challenge_id=NEW.challenge_id; END;
CREATE INDEX learning_authorizations_discovery ON learning_authorizations(account_id,authorization_id,authority_epoch);
CREATE INDEX learning_authorizations_invalid_original ON learning_authorizations(account_id,authorization_id) WHERE COALESCE((
 typeof(authorization_id)='text' AND length(authorization_id)=66 AND substr(authorization_id,1,2)='0x'
 AND substr(authorization_id,3) NOT GLOB '*[^0-9a-f]*'
 AND typeof(subject)='text' AND length(subject)=42 AND substr(subject,1,2)='0x' AND substr(subject,3) NOT GLOB '*[^0-9a-f]*'
 AND typeof(issued_at)='integer' AND issued_at BETWEEN 0 AND 9007199254740
 AND typeof(authority_epoch)='integer' AND authority_epoch BETWEEN 0 AND 9007199254740991
 AND typeof(message)='text' AND length(message) BETWEEN 1 AND 32768
 AND typeof(sign_in_json)='text' AND length(sign_in_json)<=4096 AND json_valid(sign_in_json)
 AND typeof(signature)='text' AND length(signature) BETWEEN 4 AND 32768 AND length(signature)%2=0
 AND substr(signature,1,2)='0x' AND substr(signature,3) NOT GLOB '*[^0-9a-fA-F]*'
 AND typeof(policy_hash)='text' AND length(policy_hash)=66 AND substr(policy_hash,1,2)='0x'
 AND substr(policy_hash,3) NOT GLOB '*[^0-9a-f]*' AND policy_version=4
),0)=0;
CREATE TRIGGER learning_authority_original_insert AFTER INSERT ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_original_delete AFTER DELETE ON learning_authorizations
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_original_update AFTER UPDATE OF authorization_id,account_id,subject,issued_at,authority_epoch,message,sign_in_json,signature,policy_hash,policy_version ON learning_authorizations
 WHEN OLD.authorization_id IS NOT NEW.authorization_id OR OLD.account_id IS NOT NEW.account_id OR OLD.subject IS NOT NEW.subject
 OR OLD.issued_at IS NOT NEW.issued_at OR OLD.authority_epoch IS NOT NEW.authority_epoch OR OLD.message IS NOT NEW.message
 OR OLD.sign_in_json IS NOT NEW.sign_in_json OR OLD.signature IS NOT NEW.signature OR OLD.policy_hash IS NOT NEW.policy_hash OR OLD.policy_version IS NOT NEW.policy_version
 BEGIN INSERT INTO learning_authority_original_heads(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_original_heads(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_insert_hold BEFORE INSERT ON learning_authorizations
 WHEN EXISTS(SELECT 1 FROM learning_authority_heads h WHERE h.account_id=NEW.account_id AND h.pending_operation IS NOT NULL)
 OR EXISTS(SELECT 1 FROM learning_authority_dirty d WHERE d.account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM login_challenges c WHERE c.subject=NEW.subject AND c.message=NEW.message AND c.kind='sign-in-v4'
   AND c.authority_epoch!=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0))
 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER learning_authority_capture AFTER INSERT ON learning_authorizations
 BEGIN UPDATE learning_authorizations SET authority_epoch=COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=NEW.account_id),0)
 WHERE authorization_id=NEW.authorization_id; END;
CREATE TRIGGER learning_authority_off_insert AFTER INSERT ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END;
CREATE TRIGGER learning_authority_off_update AFTER UPDATE OF public_results_withdrawn_at,last_withdrawn_at ON learning_settings
 WHEN NEW.public_results_withdrawn_at IS NOT NULL AND (OLD.public_results_withdrawn_at IS NULL OR NEW.last_withdrawn_at IS NOT OLD.last_withdrawn_at)
 BEGIN INSERT INTO learning_authority_dirty(account_id,updated_at) VALUES(NEW.account_id,0)
 ON CONFLICT(account_id) DO UPDATE SET updated_at=0,version=version+1; END;
INSERT INTO learning_authority_dirty(account_id,updated_at)
 SELECT account_id,0 FROM learning_settings WHERE public_results_withdrawn_at IS NOT NULL;
