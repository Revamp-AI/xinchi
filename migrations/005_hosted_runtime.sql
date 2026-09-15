CREATE TABLE focus_auth.provider_secrets (
 id INTEGER PRIMARY KEY CHECK(id=1),
 payload JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON focus_auth.provider_secrets FROM PUBLIC;
ALTER TABLE jobs ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN usage_json TEXT;
