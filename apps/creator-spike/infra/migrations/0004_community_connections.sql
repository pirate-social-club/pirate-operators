CREATE TABLE creator_request_nonces (
  community_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  wire_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, nonce)
);
CREATE TABLE scoped_creator_connections (
  request_id TEXT PRIMARY KEY REFERENCES links(id),
  community_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  ready_at INTEGER,
  receipt_json TEXT,
  UNIQUE(community_id, connection_id)
);
