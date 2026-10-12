CREATE SCHEMA "focus_auth";
--> statement-breakpoint
CREATE TABLE "focus_auth"."auth_events" (
	"id" bigserial PRIMARY KEY,
	"created_at" text NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"code" text NOT NULL,
	"http_status" integer,
	"provider_reason" text
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."beeper_devices" (
	"id" text PRIMARY KEY,
	"token_hash" text NOT NULL CONSTRAINT "beeper_devices_token_hash_key" UNIQUE,
	"owner_email" text NOT NULL,
	"label" text NOT NULL,
	"selection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"requested" boolean DEFAULT true NOT NULL,
	"issue" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."beeper_pairings" (
	"token_hash" text PRIMARY KEY,
	"owner_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_clients" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_codes" (
	"token_hash" text PRIMARY KEY,
	"grant_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_grants" (
	"id" text PRIMARY KEY,
	"client_id" text NOT NULL,
	"owner_sub" text NOT NULL,
	"owner_email" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_operations" (
	"grant_id" text,
	"tool" text,
	"request_key" text,
	"args_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_operations_pkey" PRIMARY KEY("grant_id","tool","request_key")
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_rate_limits" (
	"key" text PRIMARY KEY,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."mcp_tokens" (
	"token_hash" text PRIMARY KEY,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "mcp_tokens_kind_check" CHECK ((kind = ANY (ARRAY['access'::text, 'refresh'::text])))
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."oauth_attempts" (
	"state_hash" text PRIMARY KEY,
	"browser_hash" text NOT NULL,
	"verifier" text NOT NULL,
	"nonce" text NOT NULL,
	"client_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."owner" (
	"id" integer PRIMARY KEY,
	"sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "owner_id_check" CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."provider_secrets" (
	"id" integer PRIMARY KEY,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_secrets_id_check" CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE "focus_auth"."sessions" (
	"token_hash" text PRIMARY KEY,
	"sub" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY,
	"item_id" text NOT NULL,
	"action" text NOT NULL,
	"before_json" text,
	"after_json" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"kind" text DEFAULT 'action' NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"done_when" text DEFAULT '' NOT NULL,
	"next_action" text DEFAULT '' NOT NULL,
	"owner" text DEFAULT 'You' NOT NULL,
	"checkpoint" text DEFAULT '' NOT NULL,
	"hard_deadline" text DEFAULT '' NOT NULL,
	"original_checkpoint" text DEFAULT '' NOT NULL,
	"dependency" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"source_id" text,
	"source_quote" text DEFAULT '' NOT NULL,
	"shared" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"last_action" text DEFAULT '' NOT NULL,
	"fallback" text DEFAULT '' NOT NULL,
	"source_version_id" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" text PRIMARY KEY,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"raw_json" text NOT NULL,
	"fetched_at" text NOT NULL,
	"normalized_body" text,
	CONSTRAINT "source_versions_source_id_content_hash_key" UNIQUE("source_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"occurred_at" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"coverage" text NOT NULL,
	"content_hash" text NOT NULL,
	"imported_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "sources_provider_external_id_key" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_lock" (
	"id" integer PRIMARY KEY,
	CONSTRAINT "workspace_lock_id_check" CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY,
	"job_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"prompt" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"result_json" text,
	"error" text DEFAULT '' NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"pid" integer,
	"lease_owner" text DEFAULT '' NOT NULL,
	"lease_until" timestamp with time zone,
	"model" text DEFAULT '' NOT NULL,
	"usage_json" text
);
--> statement-breakpoint
CREATE TABLE "proposal_events" (
	"id" text PRIMARY KEY,
	"proposal_id" text NOT NULL,
	"job_id" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal_review_batches" (
	"job_id" text,
	"proposal_id" text,
	"version" integer NOT NULL,
	CONSTRAINT "proposal_review_batches_pkey" PRIMARY KEY("job_id","proposal_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY,
	"job_id" text NOT NULL,
	"fingerprint" text NOT NULL CONSTRAINT "proposals_fingerprint_key" UNIQUE,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" text NOT NULL,
	"created_at" text NOT NULL,
	"item_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deliverable_key" text DEFAULT '' NOT NULL,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_attempted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_batches" (
	"job_id" text PRIMARY KEY,
	"pages" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_queue" (
	"source_id" text PRIMARY KEY,
	"source_version_id" text NOT NULL,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"job_id" text,
	"completed" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revisit" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beeper_uploads" (
	"run_id" text PRIMARY KEY,
	"device_id" text NOT NULL,
	"part_count" integer DEFAULT 0 NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"last_part_hash" text DEFAULT '' NOT NULL,
	"sealed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "durable_runs" (
	"kind" text,
	"run_id" text,
	"cursor" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"workflow_id" text DEFAULT '' NOT NULL,
	"dispatch_token" text DEFAULT '' NOT NULL,
	"dispatch_until" timestamp with time zone,
	"unit_token" text DEFAULT '' NOT NULL,
	"unit_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"outcome" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "durable_runs_pkey" PRIMARY KEY("kind","run_id"),
	CONSTRAINT "durable_runs_kind_check" CHECK ((kind = ANY (ARRAY['sync'::text, 'contacts'::text])))
);
--> statement-breakpoint
CREATE TABLE "import_chunks" (
	"run_id" text,
	"part" integer,
	"content" text NOT NULL,
	CONSTRAINT "import_chunks_pkey" PRIMARY KEY("run_id","part"),
	CONSTRAINT "import_chunks_part_check" CHECK ((part >= 0))
);
--> statement-breakpoint
CREATE TABLE "import_records" (
	"run_id" text,
	"ordinal" integer,
	"payload" jsonb NOT NULL,
	CONSTRAINT "import_records_pkey" PRIMARY KEY("run_id","ordinal"),
	CONSTRAINT "import_records_ordinal_check" CHECK ((ordinal >= 0))
);
--> statement-breakpoint
CREATE TABLE "import_uploads" (
	"run_id" text PRIMARY KEY,
	"format" text NOT NULL,
	"title" text NOT NULL,
	"expected_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_uploads_expected_bytes_check" CHECK (((expected_bytes >= 0) AND (expected_bytes <= 67108864))),
	CONSTRAINT "import_uploads_format_check" CHECK ((format = ANY (ARRAY['json'::text, 'text'::text])))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"state" text NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"pid" integer,
	"updated_at" text,
	"changed" integer DEFAULT 0 NOT NULL,
	"lease_owner" text DEFAULT '' NOT NULL,
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "affiliations" (
	"id" text PRIMARY KEY,
	"contact_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"started_on" date,
	"ended_on" date,
	CONSTRAINT "affiliations_check" CHECK (((ended_on IS NULL) OR (started_on IS NULL) OR (ended_on >= started_on)))
);
--> statement-breakpoint
CREATE TABLE "contact_analysis_runs" (
	"id" text PRIMARY KEY,
	"state" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"reviewed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"usage" jsonb,
	"error" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_identities" (
	"id" text PRIMARY KEY,
	"contact_id" text NOT NULL,
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"external_key" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"source_id" text,
	CONSTRAINT "contact_identities_provider_account_external_key_key" UNIQUE("provider","account","external_key")
);
--> statement-breakpoint
CREATE TABLE "contact_insights" (
	"contact_id" text PRIMARY KEY,
	"input_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"run_id" text NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_queue" (
	"source_id" text PRIMARY KEY,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_runs" (
	"id" text PRIMARY KEY,
	"state" text NOT NULL,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"finished_at" text,
	"imported" integer DEFAULT 0 NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"pid" integer,
	"lease_owner" text DEFAULT '' NOT NULL,
	"lease_until" timestamp with time zone,
	"review_requested" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_state_history" (
	"id" text PRIMARY KEY,
	"contact_id" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"basis" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_states" (
	"contact_id" text PRIMARY KEY,
	"state" text NOT NULL,
	"basis" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"tracked" boolean DEFAULT false NOT NULL,
	"cadence_days" integer DEFAULT 30 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"snoozed_until" date,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL,
	"merged_into" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	CONSTRAINT "contacts_cadence_days_check" CHECK (((cadence_days >= 1) AND (cadence_days <= 3650)))
);
--> statement-breakpoint
CREATE TABLE "identity_decisions" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"left_id" text NOT NULL,
	"right_id" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_hash" text NOT NULL,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_reviews" (
	"id" text PRIMARY KEY,
	"left_id" text NOT NULL,
	"right_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_reviews_left_id_right_id_key" UNIQUE("left_id","right_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_decisions" (
	"id" text PRIMARY KEY,
	"interaction_id" text NOT NULL,
	"action" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_participants" (
	"interaction_id" text,
	"contact_id" text,
	"role" text DEFAULT '' NOT NULL,
	CONSTRAINT "interaction_participants_pkey" PRIMARY KEY("interaction_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_sources" (
	"interaction_id" text,
	"source_version_id" text,
	"source_id" text NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	CONSTRAINT "interaction_sources_pkey" PRIMARY KEY("interaction_id","source_version_id")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY,
	"source_id" text CONSTRAINT "interactions_source_id_key" UNIQUE,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"direction" text DEFAULT 'unknown' NOT NULL,
	"qualified" boolean DEFAULT false NOT NULL,
	"exclusion" text DEFAULT '' NOT NULL,
	"thread_key" text DEFAULT '' NOT NULL,
	"duplicate_of" text,
	"duplicate_status" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "interactions_kind_check" CHECK ((kind = ANY (ARRAY['email'::text, 'meeting'::text, 'note'::text, 'message'::text])))
);
--> statement-breakpoint
CREATE TABLE "item_contacts" (
	"item_id" text,
	"contact_id" text,
	CONSTRAINT "item_contacts_pkey" PRIMARY KEY("item_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "message_drafts" (
	"id" text PRIMARY KEY,
	"contact_id" text NOT NULL,
	"job_id" text,
	"subject" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"citations" jsonb DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"domain" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priorities" (
	"id" text PRIMARY KEY,
	"stack_id" text NOT NULL,
	"title" text NOT NULL,
	"owner" text DEFAULT 'You' NOT NULL,
	"financials" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"keywords" text DEFAULT '' NOT NULL,
	"next_decision" text DEFAULT '' NOT NULL,
	"commitment_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"position" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"latest_summary" text DEFAULT '' NOT NULL,
	"last_context_at" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priorities_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'done'::text])))
);
--> statement-breakpoint
CREATE TABLE "priority_order" (
	"id" integer PRIMARY KEY,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "priority_order_id_check" CHECK ((id = 1))
);
--> statement-breakpoint
CREATE TABLE "priority_stacks" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "priority_suggestions" (
	"id" text PRIMARY KEY,
	"priority_id" text,
	"job_id" text,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL CONSTRAINT "priority_suggestions_fingerprint_key" UNIQUE,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priority_suggestions_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text])))
);
--> statement-breakpoint
CREATE TABLE "priority_updates" (
	"id" text PRIMARY KEY,
	"priority_id" text NOT NULL,
	"body" text NOT NULL,
	"origin" text NOT NULL,
	"citations" jsonb DEFAULT '[]' NOT NULL,
	"fingerprint" text NOT NULL CONSTRAINT "priority_updates_fingerprint_key" UNIQUE,
	"job_id" text,
	"occurred_at" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priority_updates_origin_check" CHECK ((origin = ANY (ARRAY['user'::text, 'context'::text])))
);
--> statement-breakpoint
CREATE INDEX "mcp_tokens_grant" ON "focus_auth"."mcp_tokens" ("grant_id");--> statement-breakpoint
CREATE INDEX "events_item" ON "events" ("item_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "source_versions_latest" ON "source_versions" ("source_id","fetched_at" DESC);--> statement-breakpoint
CREATE INDEX "source_search" ON "sources" USING gin (to_tsvector('simple'::regconfig, ((title || ' '::text) || body)));--> statement-breakpoint
CREATE INDEX "sources_chronology" ON "sources" ("occurred_at" DESC,"id");--> statement-breakpoint
CREATE INDEX "job_events_job" ON "job_events" ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_single_active" ON "jobs" ((true)) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_deliverable_key" ON "proposals" ("deliverable_key") WHERE (deliverable_key <> ''::text);--> statement-breakpoint
CREATE INDEX "proposals_review_due" ON "proposals" ("status","reviewed_at");--> statement-breakpoint
CREATE INDEX "review_queue_pending" ON "review_queue" ("updated_at") WHERE (completed = false);--> statement-breakpoint
CREATE INDEX "durable_pending" ON "durable_runs" ("updated_at") WHERE (completed = false);--> statement-breakpoint
CREATE UNIQUE INDEX "sync_provider_active" ON "sync_runs" ("provider") WHERE (state = ANY (ARRAY['queued'::text, 'running'::text, 'uploading'::text]));--> statement-breakpoint
CREATE INDEX "contact_identities_exact_email" ON "contact_identities" (lower(btrim(address)),"contact_id") WHERE (address <> ''::text);--> statement-breakpoint
CREATE INDEX "contact_queue_pending" ON "contact_queue" ("updated_at","source_id") WHERE (state = 'pending'::text);--> statement-breakpoint
CREATE UNIQUE INDEX "contact_single_active" ON "contact_runs" ((true)) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]));--> statement-breakpoint
CREATE INDEX "contacts_exact_email" ON "contacts" (lower(btrim(email))) WHERE ((merged_into IS NULL) AND (email <> ''::text));--> statement-breakpoint
CREATE INDEX "contacts_search" ON "contacts" (lower(name),lower(email));--> statement-breakpoint
CREATE INDEX "participants_contact" ON "interaction_participants" ("contact_id","interaction_id");--> statement-breakpoint
CREATE INDEX "interactions_chronology" ON "interactions" ("occurred_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_name" ON "organizations" (lower(name));--> statement-breakpoint
CREATE INDEX "priorities_stack" ON "priorities" ("stack_id","status","position","id");--> statement-breakpoint
CREATE INDEX "priority_updates_history" ON "priority_updates" ("priority_id","occurred_at" DESC,"id");--> statement-breakpoint
ALTER TABLE "focus_auth"."mcp_codes" ADD CONSTRAINT "mcp_codes_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "focus_auth"."mcp_grants"("id");--> statement-breakpoint
ALTER TABLE "focus_auth"."mcp_grants" ADD CONSTRAINT "mcp_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "focus_auth"."mcp_clients"("id");--> statement-breakpoint
ALTER TABLE "focus_auth"."mcp_operations" ADD CONSTRAINT "mcp_operations_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "focus_auth"."mcp_grants"("id");--> statement-breakpoint
ALTER TABLE "focus_auth"."mcp_tokens" ADD CONSTRAINT "mcp_tokens_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "focus_auth"."mcp_grants"("id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "source_versions"("id");--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "proposal_review_batches" ADD CONSTRAINT "proposal_review_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposal_review_batches" ADD CONSTRAINT "proposal_review_batches_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "review_batches" ADD CONSTRAINT "review_batches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "source_versions"("id");--> statement-breakpoint
ALTER TABLE "review_queue" ADD CONSTRAINT "review_queue_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "beeper_uploads" ADD CONSTRAINT "beeper_uploads_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id");--> statement-breakpoint
ALTER TABLE "beeper_uploads" ADD CONSTRAINT "beeper_uploads_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "focus_auth"."beeper_devices"("id");--> statement-breakpoint
ALTER TABLE "import_chunks" ADD CONSTRAINT "import_chunks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "import_uploads"("run_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id");--> statement-breakpoint
ALTER TABLE "import_uploads" ADD CONSTRAINT "import_uploads_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id");--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "affiliations" ADD CONSTRAINT "affiliations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id");--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "contact_identities" ADD CONSTRAINT "contact_identities_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "contact_insights" ADD CONSTRAINT "contact_insights_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "contact_queue" ADD CONSTRAINT "contact_queue_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "contact_state_history" ADD CONSTRAINT "contact_state_history_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "contact_states" ADD CONSTRAINT "contact_states_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_left_id_fkey" FOREIGN KEY ("left_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_right_id_fkey" FOREIGN KEY ("right_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "identity_reviews" ADD CONSTRAINT "identity_reviews_left_id_fkey" FOREIGN KEY ("left_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "identity_reviews" ADD CONSTRAINT "identity_reviews_right_id_fkey" FOREIGN KEY ("right_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "interaction_decisions" ADD CONSTRAINT "interaction_decisions_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id");--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id");--> statement-breakpoint
ALTER TABLE "interaction_participants" ADD CONSTRAINT "interaction_participants_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "interaction_sources" ADD CONSTRAINT "interaction_sources_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id");--> statement-breakpoint
ALTER TABLE "interaction_sources" ADD CONSTRAINT "interaction_sources_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "source_versions"("id");--> statement-breakpoint
ALTER TABLE "interaction_sources" ADD CONSTRAINT "interaction_sources_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_duplicate_of_fkey" FOREIGN KEY ("duplicate_of") REFERENCES "interactions"("id");--> statement-breakpoint
ALTER TABLE "item_contacts" ADD CONSTRAINT "item_contacts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "item_contacts" ADD CONSTRAINT "item_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id");--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "priorities" ADD CONSTRAINT "priorities_stack_id_fkey" FOREIGN KEY ("stack_id") REFERENCES "priority_stacks"("id");--> statement-breakpoint
ALTER TABLE "priorities" ADD CONSTRAINT "priorities_commitment_id_fkey" FOREIGN KEY ("commitment_id") REFERENCES "items"("id");--> statement-breakpoint
ALTER TABLE "priority_suggestions" ADD CONSTRAINT "priority_suggestions_priority_id_fkey" FOREIGN KEY ("priority_id") REFERENCES "priorities"("id");--> statement-breakpoint
ALTER TABLE "priority_suggestions" ADD CONSTRAINT "priority_suggestions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
ALTER TABLE "priority_updates" ADD CONSTRAINT "priority_updates_priority_id_fkey" FOREIGN KEY ("priority_id") REFERENCES "priorities"("id");--> statement-breakpoint
ALTER TABLE "priority_updates" ADD CONSTRAINT "priority_updates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id");--> statement-breakpoint
-- Seed rows that migrations 001 and 014 created before Drizzle owned the schema.
INSERT INTO "workspace_lock" ("id") VALUES (1);--> statement-breakpoint
INSERT INTO "priority_stacks" ("id", "name", "position") VALUES ('deal-flow', 'Deal flow', 0), ('product', 'Product', 1), ('go-to-market', 'Go-to-market', 2);--> statement-breakpoint
INSERT INTO "priority_order" ("id", "version") VALUES (1, 1);
