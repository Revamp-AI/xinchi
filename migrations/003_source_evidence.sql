ALTER TABLE source_versions ADD COLUMN normalized_body TEXT;
UPDATE source_versions v SET normalized_body=s.body FROM sources s WHERE s.id=v.source_id AND s.content_hash=v.content_hash;
CREATE TABLE interaction_decisions(id TEXT PRIMARY KEY,interaction_id TEXT NOT NULL REFERENCES interactions(id),action TEXT NOT NULL,before_snapshot JSONB NOT NULL,after_snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX contact_queue_pending ON contact_queue(updated_at,source_id) WHERE state='pending';
