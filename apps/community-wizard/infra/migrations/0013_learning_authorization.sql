-- V4: a community sign-in is the learner's publication authorization.
-- A challenge is the plain SIWE login or the V4 sign-in, which is also an
-- EIP-4361 text: both are signed as text. Every earlier challenge is plain
-- SIWE, which never produces an authorization.
ALTER TABLE login_challenges ADD COLUMN kind TEXT NOT NULL DEFAULT 'siwe'
  CHECK(kind IN ('siwe','sign-in-v4'));
ALTER TABLE login_challenges ADD COLUMN policy_version INTEGER
  CHECK(policy_version IS NULL OR policy_version>0);
CREATE TABLE learning_authorizations (
  authorization_id TEXT PRIMARY KEY
    CHECK(length(authorization_id)=66 AND authorization_id GLOB '0x*'
      AND substr(authorization_id,3) NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  subject TEXT NOT NULL,
  -- The compact LearningResultsV4.authorize arguments {learner,nonce,issuedAt}.
  sign_in_json TEXT NOT NULL CHECK(json_valid(sign_in_json)),
  -- The exact signed text; authorization_id is its EIP-191 hash.
  message TEXT NOT NULL,
  signature TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK(policy_version>0),
  issued_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','recorded','refused')),
  tx_hash TEXT,
  -- Milliseconds. Set when a Study or Karaoke start first requests the relay;
  -- a sign-in without practice is never relayed, and the scheduled retry
  -- covers only requested rows. An account keeps at most one pending row.
  relay_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX learning_authorizations_account ON learning_authorizations(account_id,state);
CREATE INDEX learning_authorizations_relay ON learning_authorizations(state,relay_requested_at);
-- Withdrawal times are milliseconds. public_results_withdrawn_at is set while
-- public results are off and cleared when the learner turns them back on.
-- last_withdrawn_at keeps the latest withdrawal after that: only a sign-in
-- issued after it can authorize again.
CREATE TABLE learning_settings (
  account_id TEXT PRIMARY KEY REFERENCES community_accounts(account_id),
  public_results_withdrawn_at INTEGER,
  last_withdrawn_at INTEGER,
  CHECK(public_results_withdrawn_at IS NULL OR last_withdrawn_at IS NOT NULL)
);
INSERT INTO setup_schema(version) VALUES(13);
