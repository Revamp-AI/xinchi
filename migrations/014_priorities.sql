CREATE TABLE priority_stacks(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL);
INSERT INTO priority_stacks VALUES('deal-flow','Deal flow',0),('product','Product',1),('go-to-market','Go-to-market',2);
CREATE TABLE priority_order(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 1);
INSERT INTO priority_order VALUES(1,1);
CREATE TABLE priorities(
 id TEXT PRIMARY KEY,stack_id TEXT NOT NULL REFERENCES priority_stacks(id),title TEXT NOT NULL,
 owner TEXT NOT NULL DEFAULT 'You',financials TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',keywords TEXT NOT NULL DEFAULT '',
 next_decision TEXT NOT NULL DEFAULT '',commitment_id TEXT REFERENCES items(id),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
 position INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,latest_summary TEXT NOT NULL DEFAULT '',last_context_at TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX priorities_stack ON priorities(stack_id,status,position,id);
CREATE TABLE priority_updates(
 id TEXT PRIMARY KEY,priority_id TEXT NOT NULL REFERENCES priorities(id),body TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('user','context')),
 citations JSONB NOT NULL DEFAULT '[]',fingerprint TEXT NOT NULL UNIQUE,job_id TEXT REFERENCES jobs(id),occurred_at TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX priority_updates_history ON priority_updates(priority_id,occurred_at DESC,id);
CREATE TABLE priority_suggestions(
 id TEXT PRIMARY KEY,priority_id TEXT REFERENCES priorities(id),job_id TEXT REFERENCES jobs(id),payload JSONB NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE review_queue ADD COLUMN revisit BOOLEAN NOT NULL DEFAULT false;
