PRAGMA foreign_keys = ON;
-- One open owner budget window per owner scope. Claiming a window is a single
-- conditional upsert (packages/release/owner-grant.ts claimOwnerWindow), so two
-- concurrent overlapping grants cannot both be admitted. A window only advances
-- to a later, non-overlapping one; it never moves back.
CREATE TABLE owner_budget_windows (
  scope TEXT PRIMARY KEY,
  valid_from INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (valid_from < expires_at)
);
INSERT INTO setup_schema(version) VALUES(9);
