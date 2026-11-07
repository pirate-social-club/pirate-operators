PRAGMA foreign_keys = ON;
CREATE TABLE reward_programs (
  program_id TEXT PRIMARY KEY,
  profile_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX reward_one_program ON reward_programs((1));
CREATE TABLE reward_participants (
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  wallet TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(program_id, account_id),
  UNIQUE(program_id, wallet)
);
CREATE TABLE reward_offers (
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  offer_id TEXT NOT NULL,
  drawing_id TEXT NOT NULL,
  song_key TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL,
  opens_at INTEGER NOT NULL,
  purchase_hash TEXT NOT NULL,
  ticket_ids_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  purchase_evidence TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','closed','settled','no_prize')),
  entries_json TEXT,
  winnings_usdc_atomic TEXT,
  payout_atomic TEXT,
  remainder_atomic TEXT,
  settlement_evidence TEXT,
  PRIMARY KEY(program_id, offer_id),
  UNIQUE(program_id, drawing_id, song_key)
);
CREATE INDEX reward_offer_due ON reward_offers(program_id, state, cutoff_at, offer_id);
CREATE TABLE reward_tickets (
  source_ticket_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  FOREIGN KEY(program_id,offer_id) REFERENCES reward_offers(program_id,offer_id)
);
CREATE TABLE reward_subjects (
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  wallet TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(program_id, account_id),
  UNIQUE(program_id, subject_hash)
);
CREATE TABLE reward_verification_intents (
  intent_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  wallet TEXT NOT NULL,
  challenge TEXT NOT NULL,
  key_hex TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  launch_url TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('opening','pending','verified','subject_conflict','expired')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX reward_intent_owner ON reward_verification_intents(program_id,account_id,expires_at,intent_id);
CREATE TABLE reward_payments (
  payment_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','awaiting_signature','submitted','confirmed','review_required','cancelled')),
  transaction_hash TEXT,
  transfer_log_index INTEGER,
  receipt_json TEXT,
  minimum_block TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  dispatch_at INTEGER,
  UNIQUE(program_id,transaction_hash,transfer_log_index)
);
-- A few-person pilot serializes the payout account, including uncertain dispatch.
-- MOSS relayed intents do not use the payout EOA's ordinary transaction nonce.
CREATE UNIQUE INDEX reward_active_sender ON reward_payments(program_id,sender)
  WHERE state IN ('prepared','awaiting_signature','submitted','review_required');
CREATE INDEX reward_payment_queue ON reward_payments(program_id,state,prepared_at,payment_id);
CREATE TABLE reward_credits (
  credit_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
  wallet TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  paid_atomic TEXT NOT NULL DEFAULT '0',
  claim_state TEXT NOT NULL DEFAULT 'unclaimed' CHECK(claim_state IN ('unclaimed','accepted','subject_conflict')),
  payment_id TEXT REFERENCES reward_payments(payment_id),
  FOREIGN KEY(program_id,offer_id) REFERENCES reward_offers(program_id,offer_id),
  UNIQUE(program_id,offer_id,account_id)
);
CREATE INDEX reward_credit_owner ON reward_credits(program_id,account_id,credit_id);
CREATE INDEX reward_credit_ready ON reward_credits(program_id,claim_state,payment_id,credit_id);
CREATE TABLE reward_payment_items (
  payment_id TEXT NOT NULL REFERENCES reward_payments(payment_id),
  credit_id TEXT NOT NULL REFERENCES reward_credits(credit_id),
  amount_atomic TEXT NOT NULL,
  PRIMARY KEY(payment_id,credit_id)
);
CREATE TABLE reward_inventory (
  program_id TEXT PRIMARY KEY REFERENCES reward_programs(program_id),
  received_atomic TEXT NOT NULL DEFAULT '0',
  reserved_atomic TEXT NOT NULL DEFAULT '0',
  paid_atomic TEXT NOT NULL DEFAULT '0',
  cost_atomic TEXT NOT NULL DEFAULT '0',
  audit_cursor TEXT
);
CREATE TABLE reward_funding (
  funding_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  kind TEXT NOT NULL CHECK(kind IN ('prefunding','conversion')),
  source_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  UNIQUE(program_id,transaction_hash,log_index)
);
CREATE TABLE reward_outgoing (
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY(program_id,transaction_hash,log_index)
);
CREATE TABLE reward_costs (
  cost_id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES reward_programs(program_id),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  amount_atomic TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  UNIQUE(program_id,transaction_hash,log_index)
);
INSERT INTO setup_schema(version) VALUES(11);
