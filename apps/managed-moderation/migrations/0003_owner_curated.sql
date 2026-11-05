PRAGMA foreign_keys = ON;
-- The held automated admission remains in managed_admissions. Curation is a
-- new policy decision with its own signed authority and genuine recognition.
CREATE TABLE curated_admissions (
  admission_id TEXT PRIMARY KEY,
  original_admission_id TEXT NOT NULL UNIQUE REFERENCES managed_admissions(admission_id),
  amendment_sha256 TEXT NOT NULL UNIQUE,
  signed_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
