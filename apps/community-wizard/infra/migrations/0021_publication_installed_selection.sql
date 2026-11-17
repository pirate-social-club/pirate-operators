-- Trusted installed selection and immutable retained source/transport archive.
CREATE TABLE publication_v1_release_archive (
  community_id TEXT NOT NULL,
  release_sha256 TEXT NOT NULL,
  release_json TEXT NOT NULL,
  transport_ref TEXT NOT NULL,
  admitted_binding_sha256 TEXT NOT NULL,
  PRIMARY KEY(community_id,release_sha256)
);
CREATE TABLE publication_v1_installed_selection (
  community_id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  community_origin TEXT NOT NULL,
  incarnation INTEGER NOT NULL CHECK(typeof(incarnation)='integer' AND incarnation>0 AND incarnation<9007199254740991),
  installed_binding_sha256 TEXT NOT NULL,
  selection_sha256 TEXT NOT NULL,
  active_release_sha256 TEXT,
  manifest_json TEXT NOT NULL,
  FOREIGN KEY(community_id,active_release_sha256)
    REFERENCES publication_v1_release_archive(community_id,release_sha256)
);
CREATE TRIGGER publication_v1_archive_insert BEFORE INSERT ON publication_v1_release_archive
WHEN EXISTS(SELECT 1 FROM publication_v1_release_archive
  WHERE community_id=NEW.community_id AND release_sha256=NEW.release_sha256)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM publication_v1_release_archive
    WHERE community_id=NEW.community_id AND release_sha256=NEW.release_sha256
    AND (release_json IS NOT NEW.release_json OR transport_ref IS NOT NEW.transport_ref))
    THEN RAISE(ABORT,'publication_retained_release_changed') END;
  SELECT RAISE(IGNORE);
END;
CREATE TRIGGER publication_v1_archive_update BEFORE UPDATE ON publication_v1_release_archive
BEGIN SELECT RAISE(ABORT,'publication_release_archive_immutable'); END;
CREATE TRIGGER publication_v1_archive_delete BEFORE DELETE ON publication_v1_release_archive
BEGIN SELECT RAISE(ABORT,'publication_release_archive_immutable'); END;
CREATE TRIGGER publication_v1_install_insert BEFORE INSERT ON publication_v1_installed_selection
WHEN EXISTS(SELECT 1 FROM publication_v1_installed_selection WHERE community_id=NEW.community_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER publication_v1_install_identity BEFORE UPDATE ON publication_v1_installed_selection
WHEN NEW.community_id IS NOT OLD.community_id
BEGIN SELECT RAISE(ABORT,'publication_installation_immutable'); END;
CREATE TRIGGER publication_v1_install_progress BEFORE UPDATE ON publication_v1_installed_selection
WHEN NEW.incarnation != OLD.incarnation+1 OR NEW.incarnation>=9007199254740991
BEGIN SELECT RAISE(ABORT,'publication_installation_progression'); END;
CREATE TRIGGER publication_v1_install_delete BEFORE DELETE ON publication_v1_installed_selection
BEGIN SELECT RAISE(ABORT,'publication_installation_immutable'); END;
INSERT INTO setup_schema(version) VALUES(21);
