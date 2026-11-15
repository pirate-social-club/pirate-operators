-- Unnumbered source only. Integrator selects an ordinal and qualifies the
-- Alchemy migration ledger. Requires existing owner budgets; never auto-applied.
CREATE TABLE managed_publishing_installation (
 origin TEXT PRIMARY KEY, epoch TEXT NOT NULL, restore_anchor_sha256 TEXT NOT NULL
);
CREATE TABLE managed_publishing_registrations (
 admission_reference TEXT PRIMARY KEY, original_id TEXT NOT NULL UNIQUE,
 record_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('provisioning','active','revoked','disabled'))
);
CREATE TABLE managed_publishing_admissions (
 original_id TEXT PRIMARY KEY,
 admission_reference TEXT NOT NULL UNIQUE REFERENCES managed_publishing_registrations(admission_reference),
 selection_digest TEXT NOT NULL UNIQUE, selection_json TEXT NOT NULL, registration_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','attaching','attached')), attached_at INTEGER,
 CHECK((state='attached' AND attached_at IS NOT NULL) OR (state!='attached' AND attached_at IS NULL))
);
