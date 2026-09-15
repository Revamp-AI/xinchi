CREATE TABLE focus_auth.mcp_clients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE focus_auth.mcp_grants (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES focus_auth.mcp_clients(id),
 owner_sub TEXT NOT NULL, owner_email TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
);
CREATE TABLE focus_auth.mcp_codes (
 token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES focus_auth.mcp_grants(id),
 redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE focus_auth.mcp_tokens (
 token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES focus_auth.mcp_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at TIMESTAMPTZ NOT NULL,
 used_at TIMESTAMPTZ
);
CREATE INDEX mcp_tokens_grant ON focus_auth.mcp_tokens(grant_id);
CREATE TABLE focus_auth.mcp_operations (
 grant_id TEXT NOT NULL REFERENCES focus_auth.mcp_grants(id), tool TEXT NOT NULL,
 request_key TEXT NOT NULL, args_hash TEXT NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(grant_id,tool,request_key)
);
CREATE TABLE focus_auth.mcp_rate_limits (
 key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
REVOKE ALL ON focus_auth.mcp_clients, focus_auth.mcp_grants, focus_auth.mcp_codes,
 focus_auth.mcp_tokens, focus_auth.mcp_operations, focus_auth.mcp_rate_limits FROM PUBLIC;
