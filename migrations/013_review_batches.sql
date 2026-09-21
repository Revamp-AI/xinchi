CREATE TABLE review_queue (
 source_id TEXT PRIMARY KEY REFERENCES sources(id),
 source_version_id TEXT NOT NULL REFERENCES source_versions(id),
 next_offset INTEGER NOT NULL DEFAULT 0,
 job_id TEXT REFERENCES jobs(id),
 completed BOOLEAN NOT NULL DEFAULT false,
 attempts INTEGER NOT NULL DEFAULT 0,
 retry_after TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX review_queue_pending ON review_queue(updated_at) WHERE completed=false;
CREATE TABLE review_batches (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 pages JSONB NOT NULL
);
