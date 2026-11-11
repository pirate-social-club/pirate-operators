-- Optional categorical reward evidence. Legacy offers have no snapshot.
CREATE TABLE reward_closure_snapshots (
  program_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=66),
  PRIMARY KEY(program_id,offer_id),
  FOREIGN KEY(program_id,offer_id) REFERENCES reward_offers(program_id,offer_id)
);
