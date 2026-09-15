CREATE TABLE focus_auth.beeper_pairings (
 token_hash TEXT PRIMARY KEY, owner_email TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE focus_auth.beeper_devices (
 id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner_email TEXT NOT NULL,
 label TEXT NOT NULL, selection JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_seen TIMESTAMPTZ, revoked_at TIMESTAMPTZ, requested BOOLEAN NOT NULL DEFAULT true,
 issue TEXT NOT NULL DEFAULT ''
);
REVOKE ALL ON focus_auth.beeper_pairings, focus_auth.beeper_devices FROM PUBLIC;
CREATE TABLE beeper_uploads (
 run_id TEXT PRIMARY KEY REFERENCES sync_runs(id), device_id TEXT NOT NULL REFERENCES focus_auth.beeper_devices(id),
 part_count INTEGER NOT NULL DEFAULT 0, record_count INTEGER NOT NULL DEFAULT 0,
 last_part_hash TEXT NOT NULL DEFAULT '', sealed BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE interactions DROP CONSTRAINT interactions_kind_check;
ALTER TABLE interactions ADD CONSTRAINT interactions_kind_check CHECK(kind IN ('email','meeting','note','message'));
