-- Exact Root migration proposal ONLY. No ordinal reserved, no applied migration.
-- Keep public_configurations, chain_scan_state and all historical evidence.
-- transaction_guards is an existing required table. Runtime mounts stay closed
-- until Root independently admits/applies this additive schema.
CREATE TABLE directory_checkpoint_heads (
  profile_key TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  next_block TEXT NOT NULL,
  block_hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  page_count INTEGER NOT NULL CHECK(page_count > 0)
);
CREATE TABLE directory_checkpoint_pages (
  snapshot TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK(page_number >= 0),
  page_sha256 TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(snapshot, page_number)
);
