CREATE TABLE durable_runs (
 kind TEXT NOT NULL CHECK(kind IN ('sync','contacts')),
 run_id TEXT NOT NULL,
 cursor JSONB,
 revision INTEGER NOT NULL DEFAULT 0,
 workflow_id TEXT NOT NULL DEFAULT '',
 dispatch_token TEXT NOT NULL DEFAULT '',
 dispatch_until TIMESTAMPTZ,
 unit_token TEXT NOT NULL DEFAULT '',
 unit_until TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 completed BOOLEAN NOT NULL DEFAULT false,
 outcome JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,run_id)
);
CREATE INDEX durable_pending ON durable_runs(updated_at) WHERE completed=false;
ALTER TABLE contact_runs ADD COLUMN review_requested BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE import_uploads(run_id TEXT PRIMARY KEY REFERENCES sync_runs(id),format TEXT NOT NULL CHECK(format IN ('json','text')),title TEXT NOT NULL,expected_bytes BIGINT NOT NULL CHECK(expected_bytes BETWEEN 0 AND 67108864),created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE import_chunks(run_id TEXT REFERENCES import_uploads(run_id) ON DELETE CASCADE,part INTEGER NOT NULL CHECK(part>=0),content TEXT NOT NULL,PRIMARY KEY(run_id,part));
CREATE TABLE import_records(run_id TEXT REFERENCES sync_runs(id),ordinal INTEGER NOT NULL CHECK(ordinal>=0),payload JSONB NOT NULL,PRIMARY KEY(run_id,ordinal));
DROP INDEX sync_single_active;
CREATE UNIQUE INDEX sync_single_active ON sync_runs((true)) WHERE state IN ('queued','running','uploading');
