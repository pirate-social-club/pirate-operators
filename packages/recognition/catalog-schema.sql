CREATE TABLE recognition_recordings (
 registration_id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL,
 creator_id TEXT NOT NULL,
 publication_json TEXT NOT NULL,
 registration_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending_upload','provider_outcome_unknown','provider_processing','ready','failed','deletion_pending','deleted')),
 provider_file_id TEXT,
 provider_match_id TEXT UNIQUE,
 claim_owner TEXT,
 claim_fence INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER NOT NULL DEFAULT 0,
 evidence_json TEXT NOT NULL DEFAULT '{}',
 UNIQUE(asset_id)
);
CREATE TABLE recognition_catalog_events (
 event_id INTEGER PRIMARY KEY AUTOINCREMENT,
 registration_id TEXT NOT NULL REFERENCES recognition_recordings(registration_id),
 state TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
