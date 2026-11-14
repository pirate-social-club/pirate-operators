-- UNAPPLIED proposal. Root assigns the real migration ordinal, native manifest,
-- signed original/current capture and actual private readback/restart closure.
-- @statement
CREATE TABLE community_member_operations (
  operation_id TEXT NOT NULL PRIMARY KEY CHECK(length(operation_id)=66 AND substr(operation_id,1,2)='0x' AND substr(operation_id,3) NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK(kind IN ('join','name')),
  installation_id TEXT NOT NULL CHECK(length(installation_id)=66),
  linux_installation_id TEXT NOT NULL CHECK(length(linux_installation_id) BETWEEN 1 AND 200 AND
    substr(linux_installation_id,1,1) GLOB '[a-zA-Z0-9]' AND linux_installation_id NOT GLOB '*[^a-zA-Z0-9:._/-]*'),
  community_id TEXT NOT NULL CHECK(length(community_id)=66),
  origin TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  binding_id TEXT NOT NULL REFERENCES credential_bindings(binding_id),
  recipient TEXT NOT NULL CHECK(length(recipient)=42),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key NOT GLOB '*[^a-zA-Z0-9_-]*'),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=66),
  original_digest TEXT NOT NULL CHECK(length(original_digest)=66),
  original_json TEXT NOT NULL CHECK(json_valid(original_json) AND length(original_json)<=65536),
  join_id TEXT REFERENCES community_member_operations(operation_id),
  namespace_id TEXT,
  label TEXT,
  policy_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  CHECK((kind='join' AND join_id IS NULL AND namespace_id IS NULL AND label IS NULL) OR
    (kind='name' AND join_id IS NOT NULL AND namespace_id IS NOT NULL AND label IS NOT NULL AND length(namespace_id)=66 AND length(label) BETWEEN 8 AND 63 AND
      label NOT GLOB '*[^a-z0-9-]*' AND substr(label,1,1)<>'-' AND substr(label,-1)<>'-' AND substr(label,3,2)<>'--')),
  UNIQUE(kind,installation_id,community_id,account_id,idempotency_key)
);
-- @statement
CREATE UNIQUE INDEX community_member_one_join ON community_member_operations(installation_id,community_id,account_id) WHERE kind='join';
-- @statement
-- Phase1 has one original name operation per account/installation/community.
-- No new key, timeout, logout or uncertainty can allocate a replacement.
CREATE UNIQUE INDEX community_member_one_original_name ON community_member_operations(installation_id,community_id,account_id) WHERE kind='name';
-- @statement
CREATE UNIQUE INDEX community_member_name_slot ON community_member_operations(installation_id,namespace_id,label) WHERE kind='name';
-- @statement
CREATE TABLE community_member_artifacts (
  operation_id TEXT NOT NULL REFERENCES community_member_operations(operation_id),
  kind TEXT NOT NULL CHECK(kind IN ('prepared','consent','grant','transaction','broadcast')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=131072),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest)=66),
  chain_id INTEGER CHECK(chain_id IN (31337,6343)),
  sender TEXT,
  nonce TEXT,
  nonce_key TEXT UNIQUE CHECK(nonce_key IS NULL OR (length(nonce_key)=66 AND substr(nonce_key,1,2)='0x' AND substr(nonce_key,3) NOT GLOB '*[^0-9a-f]*')),
  transaction_hash TEXT UNIQUE CHECK(transaction_hash IS NULL OR (length(transaction_hash)=66 AND substr(transaction_hash,1,2)='0x' AND substr(transaction_hash,3) NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(operation_id,kind),
  CHECK((kind='transaction' AND chain_id IS NOT NULL AND sender IS NOT NULL AND length(sender)=42 AND substr(sender,1,2)='0x' AND substr(sender,3) NOT GLOB '*[^0-9a-f]*' AND
    nonce IS NOT NULL AND length(nonce) BETWEEN 1 AND 20 AND nonce NOT GLOB '*[^0-9]*' AND (nonce='0' OR substr(nonce,1,1)<>'0') AND transaction_hash IS NOT NULL) OR
    (kind<>'transaction' AND chain_id IS NULL AND sender IS NULL AND nonce IS NULL AND transaction_hash IS NULL)),
  CHECK((kind='grant' AND nonce_key IS NOT NULL) OR (kind<>'grant' AND nonce_key IS NULL)),
  UNIQUE(chain_id,sender,nonce)
);
-- @statement
CREATE TABLE community_member_budgets (
  bucket TEXT NOT NULL PRIMARY KEY CHECK(length(bucket)=66),
  limit_wei TEXT NOT NULL CHECK(length(limit_wei) BETWEEN 1 AND 78 AND limit_wei NOT GLOB '*[^0-9]*' AND (limit_wei='0' OR substr(limit_wei,1,1)<>'0')),
  reserved_wei TEXT NOT NULL CHECK(length(reserved_wei) BETWEEN 1 AND 78 AND reserved_wei NOT GLOB '*[^0-9]*' AND (reserved_wei='0' OR substr(reserved_wei,1,1)<>'0')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  last_operation_id TEXT REFERENCES community_member_operations(operation_id),
  CHECK((revision=0 AND last_operation_id IS NULL AND reserved_wei='0') OR (revision>0 AND last_operation_id IS NOT NULL)),
  CHECK(length(reserved_wei)<length(limit_wei) OR (length(reserved_wei)=length(limit_wei) AND reserved_wei<=limit_wei))
);
-- @statement
CREATE TABLE community_member_observations (
  operation_id TEXT NOT NULL REFERENCES community_member_operations(operation_id),
  observation_digest TEXT NOT NULL CHECK(length(observation_digest)=66),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(observation_json)<=65536),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(operation_id,observation_digest)
);
-- @statement
CREATE TRIGGER member_operation_no_update BEFORE UPDATE ON community_member_operations BEGIN SELECT RAISE(ABORT,'member_original_immutable'); END;
-- @statement
CREATE TRIGGER member_name_requires_join BEFORE INSERT ON community_member_operations WHEN NEW.kind='name' AND NOT EXISTS(
  SELECT 1 FROM community_member_operations j WHERE j.operation_id=NEW.join_id AND j.kind='join' AND
    j.installation_id=NEW.installation_id AND j.linux_installation_id=NEW.linux_installation_id AND j.community_id=NEW.community_id AND j.origin=NEW.origin AND
    j.account_id=NEW.account_id AND j.binding_id=NEW.binding_id AND j.recipient=NEW.recipient
) BEGIN SELECT RAISE(ABORT,'member_join_required'); END;
-- @statement
CREATE TRIGGER member_operation_no_delete BEFORE DELETE ON community_member_operations BEGIN SELECT RAISE(ABORT,'member_original_immutable'); END;
-- @statement
-- BEFORE INSERT protects REPLACE even when recursive_triggers is OFF. Cover
-- primary key, idempotency, both owner indexes, and the namespace/name slot.
CREATE TRIGGER member_operation_no_replace BEFORE INSERT ON community_member_operations WHEN EXISTS(
  SELECT 1 FROM community_member_operations o WHERE o.operation_id=NEW.operation_id OR
  (o.kind=NEW.kind AND o.installation_id=NEW.installation_id AND o.community_id=NEW.community_id AND o.account_id=NEW.account_id AND
    (o.idempotency_key=NEW.idempotency_key OR NEW.kind='join' OR NEW.kind='name')) OR
  (NEW.kind='name' AND o.kind='name' AND o.installation_id=NEW.installation_id AND o.namespace_id=NEW.namespace_id AND o.label=NEW.label)
) BEGIN SELECT RAISE(ABORT,'member_original_immutable'); END;
-- @statement
CREATE TRIGGER member_artifact_no_update BEFORE UPDATE ON community_member_artifacts BEGIN SELECT RAISE(ABORT,'member_artifact_immutable'); END;
-- @statement
CREATE TRIGGER member_artifact_no_delete BEFORE DELETE ON community_member_artifacts BEGIN SELECT RAISE(ABORT,'member_artifact_immutable'); END;
-- @statement
CREATE TRIGGER member_artifact_no_replace BEFORE INSERT ON community_member_artifacts WHEN EXISTS(
  SELECT 1 FROM community_member_artifacts a WHERE (a.operation_id=NEW.operation_id AND a.kind=NEW.kind) OR
    a.nonce_key=NEW.nonce_key OR a.transaction_hash=NEW.transaction_hash OR
    (a.chain_id=NEW.chain_id AND a.sender=NEW.sender AND a.nonce=NEW.nonce)
) BEGIN SELECT RAISE(ABORT,'member_artifact_immutable'); END;
-- @statement
CREATE TRIGGER member_observation_no_update BEFORE UPDATE ON community_member_observations BEGIN SELECT RAISE(ABORT,'member_observation_immutable'); END;
-- @statement
CREATE TRIGGER member_observation_no_delete BEFORE DELETE ON community_member_observations BEGIN SELECT RAISE(ABORT,'member_observation_immutable'); END;
-- @statement
CREATE TRIGGER member_observation_no_replace BEFORE INSERT ON community_member_observations WHEN EXISTS(SELECT 1 FROM community_member_observations WHERE operation_id=NEW.operation_id AND observation_digest=NEW.observation_digest) BEGIN SELECT RAISE(ABORT,'member_observation_immutable'); END;
-- @statement
CREATE TRIGGER member_budget_no_delete BEFORE DELETE ON community_member_budgets BEGIN SELECT RAISE(ABORT,'member_budget_retained'); END;
-- @statement
CREATE TRIGGER member_budget_no_replace BEFORE INSERT ON community_member_budgets WHEN EXISTS(SELECT 1 FROM community_member_budgets WHERE bucket=NEW.bucket) BEGIN SELECT RAISE(ABORT,'member_budget_retained'); END;
-- @statement
CREATE TRIGGER member_budget_revision BEFORE UPDATE ON community_member_budgets WHEN NEW.bucket<>OLD.bucket OR NEW.limit_wei<>OLD.limit_wei OR NEW.revision<>OLD.revision+1 OR NEW.last_operation_id IS NULL OR
  length(NEW.reserved_wei)<length(OLD.reserved_wei) OR (length(NEW.reserved_wei)=length(OLD.reserved_wei) AND NEW.reserved_wei<OLD.reserved_wei)
  BEGIN SELECT RAISE(ABORT,'member_budget_revision'); END;
