ALTER TABLE items ADD COLUMN source_version_id TEXT REFERENCES source_versions(id);
