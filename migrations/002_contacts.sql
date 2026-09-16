CREATE TABLE contacts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
 tags JSONB NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', tracked BOOLEAN NOT NULL DEFAULT false,
 cadence_days INTEGER NOT NULL DEFAULT 30 CHECK(cadence_days BETWEEN 1 AND 3650), paused BOOLEAN NOT NULL DEFAULT false,
 snoozed_until DATE, do_not_contact BOOLEAN NOT NULL DEFAULT false, archived BOOLEAN NOT NULL DEFAULT false,
 confirmed BOOLEAN NOT NULL DEFAULT true, merged_into TEXT REFERENCES contacts(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX contacts_search ON contacts(lower(name),lower(email));
CREATE TABLE organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,domain TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX organizations_name ON organizations(lower(name));
CREATE TABLE affiliations(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),organization_id TEXT NOT NULL REFERENCES organizations(id),role TEXT NOT NULL DEFAULT '',started_on DATE,ended_on DATE,CHECK(ended_on IS NULL OR started_on IS NULL OR ended_on>=started_on));
CREATE TABLE contact_identities(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),provider TEXT NOT NULL,account TEXT NOT NULL,external_key TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',source_id TEXT REFERENCES sources(id),UNIQUE(provider,account,external_key));
CREATE TABLE interactions(id TEXT PRIMARY KEY,source_id TEXT UNIQUE REFERENCES sources(id),kind TEXT NOT NULL CHECK(kind IN ('email','meeting','note')),title TEXT NOT NULL,occurred_at TIMESTAMPTZ,direction TEXT NOT NULL DEFAULT 'unknown',qualified BOOLEAN NOT NULL DEFAULT false,exclusion TEXT NOT NULL DEFAULT '',thread_key TEXT NOT NULL DEFAULT '',duplicate_of TEXT REFERENCES interactions(id),duplicate_status TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE interaction_participants(interaction_id TEXT NOT NULL REFERENCES interactions(id),contact_id TEXT NOT NULL REFERENCES contacts(id),role TEXT NOT NULL DEFAULT '',PRIMARY KEY(interaction_id,contact_id));
CREATE TABLE interaction_sources(interaction_id TEXT NOT NULL REFERENCES interactions(id),source_version_id TEXT NOT NULL REFERENCES source_versions(id),source_id TEXT NOT NULL REFERENCES sources(id),quote TEXT NOT NULL DEFAULT '',PRIMARY KEY(interaction_id,source_version_id));
CREATE INDEX interactions_chronology ON interactions(occurred_at DESC);
CREATE INDEX participants_contact ON interaction_participants(contact_id,interaction_id);
CREATE TABLE identity_reviews(id TEXT PRIMARY KEY,left_id TEXT NOT NULL REFERENCES contacts(id),right_id TEXT NOT NULL REFERENCES contacts(id),reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(left_id,right_id));
CREATE TABLE identity_decisions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,left_id TEXT NOT NULL REFERENCES contacts(id),right_id TEXT NOT NULL REFERENCES contacts(id),before_snapshot JSONB NOT NULL,after_hash TEXT NOT NULL,undone_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE contact_states(contact_id TEXT PRIMARY KEY REFERENCES contacts(id),state TEXT NOT NULL,basis JSONB NOT NULL,evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),rule_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE contact_state_history(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),from_state TEXT,to_state TEXT NOT NULL,reason TEXT NOT NULL,basis JSONB NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),rule_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE contact_queue(source_id TEXT PRIMARY KEY REFERENCES sources(id),content_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE contact_runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT,imported INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',pid INTEGER,lease_owner TEXT NOT NULL DEFAULT '',lease_until TIMESTAMPTZ);
CREATE UNIQUE INDEX contact_single_active ON contact_runs((true)) WHERE state IN ('queued','running');
CREATE TABLE item_contacts(item_id TEXT NOT NULL REFERENCES items(id),contact_id TEXT NOT NULL REFERENCES contacts(id),PRIMARY KEY(item_id,contact_id));
CREATE TABLE message_drafts(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),job_id TEXT REFERENCES jobs(id),subject TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,citations JSONB NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
