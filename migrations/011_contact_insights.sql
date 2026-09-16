CREATE TABLE contact_insights (
 contact_id TEXT PRIMARY KEY REFERENCES contacts(id), input_hash TEXT NOT NULL,
 result JSONB NOT NULL, model TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL,
 dismissed BOOLEAN NOT NULL DEFAULT false, reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE contact_analysis_runs (
 id TEXT PRIMARY KEY, state TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 reviewed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
 usage JSONB, error TEXT NOT NULL DEFAULT ''
);
