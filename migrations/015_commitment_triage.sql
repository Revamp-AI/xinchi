ALTER TABLE proposals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proposals ADD COLUMN deliverable_key TEXT NOT NULL DEFAULT '';
ALTER TABLE proposals ADD COLUMN priority_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proposals ADD COLUMN reviewed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX proposals_deliverable_key ON proposals(deliverable_key) WHERE deliverable_key<>'';
CREATE INDEX proposals_review_due ON proposals(status,reviewed_at);
CREATE TABLE proposal_events (
 id TEXT PRIMARY KEY,
 proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
 job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 reason TEXT NOT NULL,
 detail JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE proposal_review_batches (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 PRIMARY KEY(job_id,proposal_id)
);

WITH ranked AS (SELECT id,row_number() OVER(ORDER BY created_at DESC,id) n FROM proposals WHERE status='pending')
UPDATE proposals p SET status='deferred',version=version+1 FROM ranked r WHERE p.id=r.id AND r.n>10;
