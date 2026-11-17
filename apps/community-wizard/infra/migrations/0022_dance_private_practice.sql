-- Additive installed private Dance state; coordinator-reserved ordinal0022.
-- Existing capture, consent, guard and V1 trigger tables are retained in0016/0017.
-- Exact host/source3 definitions adopted from their owned production stores.

CREATE TABLE dance_host_context (
 community_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json))
);
CREATE TABLE dance_host_accounts (
 community_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES community_accounts(account_id),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),PRIMARY KEY(community_id,account_id)
);
CREATE TABLE dance_host_selections (
 community_id TEXT NOT NULL,song_key TEXT NOT NULL,reference_id TEXT NOT NULL,offer_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>0),
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),PRIMARY KEY(community_id,song_key,reference_id,offer_id)
);
CREATE TABLE dance_host_song_keys (
 community_id TEXT NOT NULL,song_key TEXT NOT NULL,post_id TEXT NOT NULL,
 PRIMARY KEY(community_id,song_key),UNIQUE(community_id,post_id)
);
CREATE TABLE dance_host_audio_probes (
 community_id TEXT NOT NULL,audio_sha256 TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,
 samples INTEGER NOT NULL CHECK(typeof(samples)='integer' AND samples>0),receipt_bytes TEXT NOT NULL,
 PRIMARY KEY(community_id,audio_sha256,evidence_sha256)
);
CREATE TRIGGER dance_host_probe_immutable_update BEFORE UPDATE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_probe_immutable_delete BEFORE DELETE ON dance_host_audio_probes
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_probe_no_replace BEFORE INSERT ON dance_host_audio_probes
 WHEN EXISTS(SELECT 1 FROM dance_host_audio_probes WHERE community_id=NEW.community_id
   AND audio_sha256=NEW.audio_sha256 AND evidence_sha256=NEW.evidence_sha256)
 BEGIN SELECT RAISE(ABORT,'dance_host_probe_immutable'); END;
CREATE TRIGGER dance_host_song_key_immutable_update BEFORE UPDATE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_song_key_immutable_delete BEFORE DELETE ON dance_host_song_keys
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_song_key_no_replace BEFORE INSERT ON dance_host_song_keys
 WHEN EXISTS(SELECT 1 FROM dance_host_song_keys WHERE community_id=NEW.community_id
   AND (song_key=NEW.song_key OR post_id=NEW.post_id))
 BEGIN SELECT RAISE(ABORT,'dance_host_song_key_immutable'); END;
CREATE TRIGGER dance_host_context_revision BEFORE UPDATE ON dance_host_context
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_context_no_delete BEFORE DELETE ON dance_host_context
 BEGIN SELECT RAISE(ABORT,'dance_host_context_retained'); END;
CREATE TRIGGER dance_host_context_no_replace BEFORE INSERT ON dance_host_context
 WHEN EXISTS(SELECT 1 FROM dance_host_context WHERE community_id=NEW.community_id)
 BEGIN SELECT RAISE(ABORT,'dance_host_context_retained'); END;
CREATE TRIGGER dance_host_account_revision BEFORE UPDATE ON dance_host_accounts
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.account_id IS NOT OLD.account_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_selection_revision BEFORE UPDATE ON dance_host_selections
 WHEN NEW.community_id IS NOT OLD.community_id OR NEW.song_key IS NOT OLD.song_key
 OR NEW.reference_id IS NOT OLD.reference_id OR NEW.offer_id IS NOT OLD.offer_id OR NEW.revision!=OLD.revision+1
 BEGIN SELECT RAISE(ABORT,'dance_host_revision'); END;
CREATE TRIGGER dance_host_selection_insert_generation AFTER INSERT ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_selection_update_generation AFTER UPDATE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_selection_delete_generation AFTER DELETE ON dance_host_selections
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END;
CREATE TRIGGER dance_host_account_insert_generation AFTER INSERT ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_account_update_generation AFTER UPDATE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=NEW.community_id; END;
CREATE TRIGGER dance_host_account_delete_generation AFTER DELETE ON dance_host_accounts
 BEGIN UPDATE dance_host_context SET revision=revision+1 WHERE community_id=OLD.community_id; END;

CREATE TABLE dance_source3_requests (
 community_id TEXT NOT NULL,account_id TEXT NOT NULL,request_id TEXT NOT NULL,
 capture_id TEXT NOT NULL REFERENCES dance_captures(capture_id),
 capture_hash TEXT NOT NULL,intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 PRIMARY KEY(community_id,account_id,request_id),UNIQUE(capture_id)
);
CREATE TRIGGER dance_source3_request_no_update BEFORE UPDATE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;
CREATE TRIGGER dance_source3_request_no_delete BEFORE DELETE ON dance_source3_requests
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;
CREATE TRIGGER dance_source3_request_no_replace BEFORE INSERT ON dance_source3_requests
 WHEN EXISTS(SELECT 1 FROM dance_source3_requests WHERE
 (community_id=NEW.community_id AND account_id=NEW.account_id AND request_id=NEW.request_id)
 OR capture_id=NEW.capture_id)
 BEGIN SELECT RAISE(ABORT,'dance_source3_original_retained'); END;

INSERT INTO setup_schema(version) VALUES(22);
