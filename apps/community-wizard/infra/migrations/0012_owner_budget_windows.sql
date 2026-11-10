PRAGMA foreign_keys = ON;
-- One open owner budget window per owner scope. Claiming a window is a single
-- conditional upsert (packages/release/owner-grant.ts claimOwnerWindow), so two
-- concurrent overlapping grants cannot both be admitted. A window only advances
-- to a later, non-overlapping one; it never moves back. limits_sha256 binds
-- every ceiling of the window when it is first claimed; the same claim
-- configures all five owner budgets, so a replacement grant cannot raise a
-- ceiling that has not been used yet.
CREATE TABLE owner_budget_windows (
  scope TEXT PRIMARY KEY,
  valid_from INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  limits_sha256 TEXT NOT NULL,
  CHECK (valid_from < expires_at)
);
INSERT INTO setup_schema(version) VALUES(12);
