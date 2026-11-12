/** Unpublished migration18 successor fragment. No runtime DDL. Legacy frozen
 * membership starts without a validation row; it is never grandfathered in. */
export const AUTHORITY_VALIDATION_SCHEMA = `
CREATE UNIQUE INDEX learning_authority_transition ON learning_authority_operations(transition_id) WHERE transition_id IS NOT NULL;
CREATE TABLE learning_authority_credentials(account_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER learning_authority_credential_insert AFTER INSERT ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(NEW.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_credential_delete AFTER DELETE ON credential_bindings
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_credential_update AFTER UPDATE OF binding_id,account_id,namespace,network,subject ON credential_bindings
 WHEN OLD.binding_id IS NOT NEW.binding_id OR OLD.account_id IS NOT NEW.account_id OR OLD.namespace IS NOT NEW.namespace OR OLD.network IS NOT NEW.network OR OLD.subject IS NOT NEW.subject
 BEGIN INSERT INTO learning_authority_credentials(account_id,revision) VALUES(OLD.account_id,1)
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1;
 INSERT INTO learning_authority_credentials(account_id,revision) SELECT NEW.account_id,1 WHERE NEW.account_id IS NOT OLD.account_id
 ON CONFLICT(account_id) DO UPDATE SET revision=revision+1; END;
CREATE TRIGGER learning_authority_member_insert AFTER INSERT ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=NEW.operation_id; END;
CREATE TRIGGER learning_authority_member_delete AFTER DELETE ON learning_authority_members
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id; END;
CREATE TRIGGER learning_authority_member_update AFTER UPDATE OF operation_id,authorization_id ON learning_authority_members
 WHEN OLD.operation_id IS NOT NEW.operation_id OR OLD.authorization_id IS NOT NEW.authorization_id
 BEGIN UPDATE learning_authority_operations SET member_revision=member_revision+1 WHERE operation_id=OLD.operation_id OR operation_id=NEW.operation_id; END;
CREATE TABLE learning_authority_validation(
 operation_id TEXT PRIMARY KEY,policy INTEGER NOT NULL,original_revision INTEGER NOT NULL,
 credential_revision INTEGER NOT NULL,member_revision INTEGER NOT NULL,
 generation INTEGER NOT NULL DEFAULT 1,cursor TEXT NOT NULL DEFAULT '',complete INTEGER NOT NULL DEFAULT 0
);
`;
