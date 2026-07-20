-- citext extension is required by member.email (SPEC §6.2); enable before any table uses it.
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "action" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"app_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text,
	"source" text DEFAULT 'explicit' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_source_chk" CHECK ("action"."source" IN ('explicit','route_default','discovered'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alert_rule" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"metric" text NOT NULL,
	"threshold" numeric NOT NULL,
	"window" text NOT NULL,
	"destinations" jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annotation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"author_id" text,
	"body" text,
	"tags" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_token" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"display_prefix" text NOT NULL,
	"keyed_hash" "bytea" NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"default_capture_policy" jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_status_chk" CHECK ("app"."status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_event" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_kind" text,
	"target_id" text,
	"before_hash" text,
	"after_hash" text,
	"request_ref" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "audit_actor_kind_chk" CHECK ("audit_event"."actor_kind" IN ('member','api_token','cli','system'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_account" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"parent_id" text,
	"unit" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"window" text NOT NULL,
	"limit_amount" bigint NOT NULL,
	"enforcement" text NOT NULL,
	"pricing_catalog_revision_id" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_scope_type_chk" CHECK ("budget_account"."scope_type" IN ('workspace','team','app','cost_center','key')),
	CONSTRAINT "budget_unit_chk" CHECK ("budget_account"."unit" IN ('cost_microusd','tokens')),
	CONSTRAINT "budget_window_chk" CHECK ("budget_account"."window" IN ('daily','weekly','monthly','rolling_30d','total')),
	CONSTRAINT "budget_limit_amount_chk" CHECK ("budget_account"."limit_amount" >= 0),
	CONSTRAINT "budget_enforcement_chk" CHECK ("budget_account"."enforcement" IN ('advisory','hard')),
	CONSTRAINT "hard_requires_pricing" CHECK ("budget_account"."enforcement" <> 'hard' OR "budget_account"."pricing_catalog_revision_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_allocation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text NOT NULL,
	"child_id" text NOT NULL,
	"reserved_allowance" bigint NOT NULL,
	"window" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allocation_reserved_allowance_chk" CHECK ("budget_allocation"."reserved_allowance" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_reservation" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"budget_account_id" text NOT NULL,
	"request_id" text NOT NULL,
	"estimated_input_tokens" bigint NOT NULL,
	"max_output_tokens" bigint NOT NULL,
	"reserved_microusd" bigint NOT NULL,
	"reserved_tokens" bigint,
	"status" text NOT NULL,
	"reconciled_microusd" bigint,
	"reconciled_tokens" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "budget_reservation_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "reservation_reserved_microusd_chk" CHECK ("budget_reservation"."reserved_microusd" >= 0),
	CONSTRAINT "reservation_status_chk" CHECK ("budget_reservation"."status" IN ('reserved','committed','rolled_back','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_window_state" (
	"workspace_id" text NOT NULL,
	"budget_account_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"committed_microusd" bigint DEFAULT 0 NOT NULL,
	"reserved_microusd" bigint DEFAULT 0 NOT NULL,
	"committed_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_window_state_budget_account_id_window_start_shard_pk" PRIMARY KEY("budget_account_id","window_start","shard")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_model" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_slug" text NOT NULL,
	"family" text,
	"display_name" text NOT NULL,
	"modality_in" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"modality_out" jsonb DEFAULT '["text"]'::jsonb NOT NULL,
	"open_weights" boolean,
	"knowledge_cutoff" date,
	"release_date" date,
	"source" text DEFAULT 'models.dev' NOT NULL,
	"catalog_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_authorization" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"device_code_hash" "bytea" NOT NULL,
	"user_code" text NOT NULL,
	"status" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"approved_by" text,
	"issued_token_id" text,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_status_chk" CHECK ("cli_authorization"."status" IN ('pending','approved','issued','denied','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "config_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"base_config_hash" text,
	"target_config_hash" text,
	"plan_hash" text,
	"diff_json" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"edge_config_version" text,
	"tripwire_items" jsonb,
	"approved_by" text,
	"error" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_operation_outcome_chk" CHECK ("config_operation"."outcome" IN ('written','accepted','rejected','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_center" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_ledger" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"observation_id" text,
	"trace_id" text,
	"budget_account_id" text,
	"cost_center_id" text,
	"team_id" text,
	"app_id" text,
	"virtual_key_id" text,
	"amount_microusd" bigint NOT NULL,
	"fidelity" text NOT NULL,
	"price_revision_id" text,
	"offering_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_ledger_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "cost_ledger_fidelity_chk" CHECK ("cost_ledger"."fidelity" IN ('exact','estimated','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_encryption_key" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_encryption_key_status_chk" CHECK ("data_encryption_key"."status" IN ('active','retiring','revoked'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_handling_constraint" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"capture_mode" text DEFAULT 'redacted' NOT NULL,
	"redaction" jsonb,
	"allowed_regions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_handling_capture_mode_chk" CHECK ("data_handling_constraint"."capture_mode" IN ('none','metadata','redacted','full'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_event" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"score" numeric,
	"label" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_config_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"parent_revision_id" text,
	"snapshot" jsonb NOT NULL,
	"route_ids" jsonb,
	"policy_ids" jsonb,
	"price_ids" jsonb,
	"status" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_revision_status_chk" CHECK ("gateway_config_revision"."status" IN ('active','superseded','rolled_back'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_ingress_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"hostname" text NOT NULL,
	"mode" text NOT NULL,
	"network_exposure" text DEFAULT 'public' NOT NULL,
	"auth_config" jsonb NOT NULL,
	"network_config" jsonb,
	"policy_revision_id" text,
	"default_route_set" jsonb,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_mode_chk" CHECK ("gateway_ingress_profile"."mode" IN ('public_app','enterprise_egress')),
	CONSTRAINT "ingress_exposure_chk" CHECK ("gateway_ingress_profile"."network_exposure" IN ('public','vpc','mtls'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" "bytea",
	"workload_identity" jsonb,
	"applied_config_revision" text,
	"edition" text DEFAULT 'vercel' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_edition_chk" CHECK ("gateway_installation"."edition" IN ('vercel','cloudflare','compose')),
	CONSTRAINT "installation_identity_present" CHECK ("gateway_installation"."public_key" IS NOT NULL OR "gateway_installation"."workload_identity" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"active_revision_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_policy_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_route" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"public_name" text NOT NULL,
	"endpoint_kind" text NOT NULL,
	"active_revision_id" text,
	"attribution_app_id" text,
	"default_action_id" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_endpoint_kind_chk" CHECK ("gateway_route"."endpoint_kind" IN ('chat','responses','embeddings'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_route_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"route_id" text NOT NULL,
	"mode" text NOT NULL,
	"retry_policy" jsonb NOT NULL,
	"timeout_policy" jsonb NOT NULL,
	"capture_policy" jsonb,
	"content_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_revision_mode_chk" CHECK ("gateway_route_revision"."mode" IN ('ordered','weighted'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gateway_target" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"route_revision_id" text NOT NULL,
	"provider_credential_id" text NOT NULL,
	"offering_id" text NOT NULL,
	"adapter_revision" text NOT NULL,
	"base_url" text,
	"deployment" jsonb,
	"region" text,
	"weight" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"health_state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_weight_chk" CHECK ("gateway_target"."weight" >= 0),
	CONSTRAINT "target_health_state_chk" CHECK ("gateway_target"."health_state" IN ('healthy','degraded','unhealthy','unknown')),
	CONSTRAINT "target_weight_priority" CHECK ("gateway_target"."weight" >= 0 AND "gateway_target"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 12 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_ledger_status_chk" CHECK ("job_ledger"."status" IN ('pending','claimed','done','failed','dead'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"auth_subject" text,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_role_chk" CHECK ("member"."role" IN ('owner','admin','editor','viewer','billing'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_entitlement" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_ref" text,
	"canonical_model_id" text,
	"offering_id" text,
	"effect" text DEFAULT 'allow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_subject_kind_chk" CHECK ("model_entitlement"."subject_kind" IN ('key_scope','team','cost_center','app','all')),
	CONSTRAINT "entitlement_effect_chk" CHECK ("model_entitlement"."effect" IN ('allow','deny'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "observation" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"profile_mode" text NOT NULL,
	"route_id" text,
	"route_revision_id" text,
	"public_name" text,
	"endpoint_kind" text,
	"final_provider" text,
	"final_offering_id" text,
	"adapter_revision" text,
	"price_revision_id" text,
	"app_id" text,
	"action_id" text,
	"team_id" text,
	"cost_center_id" text,
	"virtual_key_id" text,
	"status" text NOT NULL,
	"http_status" integer,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cached_tokens" bigint,
	"reasoning_tokens" bigint,
	"cache_write_tokens" bigint,
	"audio_input_tokens" bigint,
	"audio_output_tokens" bigint,
	"cost_microusd" bigint,
	"cost_fidelity" text,
	"latency_ms" integer,
	"ttfb_ms" integer,
	"attempts" integer DEFAULT 1 NOT NULL,
	"failovers" integer DEFAULT 0 NOT NULL,
	"policy_decision_id" text,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capture_ref" jsonb,
	"compacted" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "observation_status_chk" CHECK ("observation"."status" IN ('ok','error','denied','clamped','timeout')),
	CONSTRAINT "observation_cost_fidelity_chk" CHECK ("observation"."cost_fidelity" IN ('exact','estimated','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "observation_event" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"installation_id" text NOT NULL,
	"profile_mode" text NOT NULL,
	"app_id" text,
	"action_id" text,
	"route_id" text,
	"route_revision_id" text,
	"virtual_key_id" text,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"producer_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observation_event_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "observation_event_kind_chk" CHECK ("observation_event"."kind" IN ('accepted','provider_attempt','terminal','annotation'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"approved_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_decision" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"request_id" text NOT NULL,
	"trace_id" text,
	"outcome" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"policy_revision_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decision_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "policy_decision_outcome_chk" CHECK ("policy_decision"."outcome" IN ('allow','clamp','deny'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projection_checkpoint" (
	"workspace_id" text NOT NULL,
	"projection" text NOT NULL,
	"last_event_id" text,
	"last_event_seq" bigint,
	"last_processed_at" timestamp with time zone,
	"lag_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projection_checkpoint_workspace_id_projection_pk" PRIMARY KEY("workspace_id","projection")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_secret" "bytea" NOT NULL,
	"dek_id" text NOT NULL,
	"base_url" text,
	"deployment" jsonb,
	"allowed_hosts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'unvalidated' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credential_status_chk" CHECK ("provider_credential"."status" IN ('unvalidated','valid','invalid','revoked'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_model_offering" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_model_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"endpoint_kinds" jsonb NOT NULL,
	"adapter_revision" text NOT NULL,
	"context_limit_tokens" bigint,
	"output_limit_tokens" bigint,
	"capabilities" jsonb NOT NULL,
	"region" text,
	"active_price_revision_id" text,
	"catalog_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_price_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"offering_id" text NOT NULL,
	"workspace_id" text,
	"input_per_mtok_microusd" bigint,
	"output_per_mtok_microusd" bigint,
	"cache_read_per_mtok_microusd" bigint,
	"cache_write_per_mtok_microusd" bigint,
	"reasoning_per_mtok_microusd" bigint,
	"audio_in_per_mtok_microusd" bigint,
	"audio_out_per_mtok_microusd" bigint,
	"currency" text DEFAULT 'USD' NOT NULL,
	"unit" text DEFAULT 'per_mtok' NOT NULL,
	"fidelity" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"catalog_revision" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_currency_chk" CHECK ("provider_price_revision"."currency" = 'USD'),
	CONSTRAINT "price_unit_chk" CHECK ("provider_price_revision"."unit" = 'per_mtok'),
	CONSTRAINT "price_fidelity_chk" CHECK ("provider_price_revision"."fidelity" IN ('provider_verified','operator_override','aggregator','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registry_field_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"offering_id" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb,
	"source" text NOT NULL,
	"source_url" text,
	"observed_at" timestamp with time zone NOT NULL,
	"catalog_revision" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_constraint" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"param" text NOT NULL,
	"max_value" numeric,
	"min_value" numeric,
	"on_violation" text DEFAULT 'clamp' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_constraint_on_violation_chk" CHECK ("request_constraint"."on_violation" IN ('clamp','reject'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "storage_stat" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"total_bytes" bigint NOT NULL,
	"table_bytes" jsonb NOT NULL,
	"index_bytes" bigint NOT NULL,
	"toast_bytes" bigint NOT NULL,
	"ceiling_bytes" bigint NOT NULL,
	"used_pct" numeric NOT NULL,
	"growth_bytes_per_day" bigint,
	"forecast_exhaustion_at" timestamp with time zone,
	"tier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_stat_tier_chk" CHECK ("storage_stat"."tier" IN ('normal','warning','high','critical','emergency'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"cost_center_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_member" (
	"workspace_id" text NOT NULL,
	"team_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "team_member_team_id_member_id_pk" PRIMARY KEY("team_id","member_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trace_summary" (
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"root_observation_id" text NOT NULL,
	"span_count" integer NOT NULL,
	"error" boolean NOT NULL,
	"total_cost_microusd" bigint,
	"total_latency_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_summary_workspace_id_trace_id_created_at_pk" PRIMARY KEY("workspace_id","trace_id","created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_aggregate" (
	"workspace_id" text NOT NULL,
	"grain" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"dims" jsonb NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_microusd" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"failovers" bigint DEFAULT 0 NOT NULL,
	"latency_ms_sum" bigint DEFAULT 0 NOT NULL,
	"latency_ms_p95" integer,
	"dims_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_aggregate_workspace_id_grain_bucket_start_dims_hash_pk" PRIMARY KEY("workspace_id","grain","bucket_start","dims_hash"),
	CONSTRAINT "usage_aggregate_grain_chk" CHECK ("usage_aggregate"."grain" IN ('hourly','daily','monthly'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_record" (
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cached_tokens" bigint,
	"reasoning_tokens" bigint,
	"cache_write_tokens" bigint,
	"audio_input_tokens" bigint,
	"audio_output_tokens" bigint,
	"fidelity" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_record_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "usage_record_fidelity_chk" CHECK ("usage_record"."fidelity" IN ('exact','estimated','unknown'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "virtual_key" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"display_prefix" text NOT NULL,
	"keyed_hash" "bytea" NOT NULL,
	"scopes" jsonb NOT NULL,
	"allowed_app_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_app_id" text,
	"default_action_id" text,
	"principal_id" text,
	"team_id" text,
	"cost_center_id" text,
	"budget_account_id" text,
	"rate_limit" jsonb,
	"successor_key_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"storage_ceiling_bytes" bigint DEFAULT 524288000 NOT NULL,
	"storage_warn_pct" integer DEFAULT 70 NOT NULL,
	"storage_high_pct" integer DEFAULT 85 NOT NULL,
	"storage_crit_pct" integer DEFAULT 95 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_warn_pct_range" CHECK ("workspace"."storage_warn_pct" BETWEEN 1 AND 99),
	CONSTRAINT "storage_high_pct_range" CHECK ("workspace"."storage_high_pct" BETWEEN 1 AND 99),
	CONSTRAINT "storage_crit_pct_range" CHECK ("workspace"."storage_crit_pct" BETWEEN 1 AND 100),
	CONSTRAINT "storage_thresholds_ordered" CHECK ("workspace"."storage_warn_pct" < "workspace"."storage_high_pct" AND "workspace"."storage_high_pct" < "workspace"."storage_crit_pct")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action" ADD CONSTRAINT "action_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "action" ADD CONSTRAINT "action_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "annotation" ADD CONSTRAINT "annotation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "annotation" ADD CONSTRAINT "annotation_author_id_member_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_token" ADD CONSTRAINT "api_token_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_token" ADD CONSTRAINT "api_token_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app" ADD CONSTRAINT "app_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_account" ADD CONSTRAINT "budget_account_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_account" ADD CONSTRAINT "budget_account_parent_id_budget_account_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_allocation" ADD CONSTRAINT "budget_allocation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_allocation" ADD CONSTRAINT "budget_allocation_parent_id_budget_account_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_allocation" ADD CONSTRAINT "budget_allocation_child_id_budget_account_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_reservation" ADD CONSTRAINT "budget_reservation_budget_account_id_budget_account_id_fk" FOREIGN KEY ("budget_account_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_window_state" ADD CONSTRAINT "budget_window_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "budget_window_state" ADD CONSTRAINT "budget_window_state_budget_account_id_budget_account_id_fk" FOREIGN KEY ("budget_account_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_authorization" ADD CONSTRAINT "cli_authorization_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_authorization" ADD CONSTRAINT "cli_authorization_approved_by_member_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cli_authorization" ADD CONSTRAINT "cli_authorization_issued_token_id_api_token_id_fk" FOREIGN KEY ("issued_token_id") REFERENCES "public"."api_token"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "config_operation" ADD CONSTRAINT "config_operation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "config_operation" ADD CONSTRAINT "config_operation_approved_by_member_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "config_operation" ADD CONSTRAINT "config_operation_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_center" ADD CONSTRAINT "cost_center_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_center" ADD CONSTRAINT "cost_center_parent_id_cost_center_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cost_center"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_encryption_key" ADD CONSTRAINT "data_encryption_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_handling_constraint" ADD CONSTRAINT "data_handling_constraint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_handling_constraint" ADD CONSTRAINT "data_handling_constraint_policy_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_event" ADD CONSTRAINT "feedback_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_config_revision" ADD CONSTRAINT "gateway_config_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_config_revision" ADD CONSTRAINT "gateway_config_revision_installation_id_gateway_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."gateway_installation"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_config_revision" ADD CONSTRAINT "gateway_config_revision_parent_revision_id_gateway_config_revision_id_fk" FOREIGN KEY ("parent_revision_id") REFERENCES "public"."gateway_config_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_config_revision" ADD CONSTRAINT "gateway_config_revision_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_ingress_profile" ADD CONSTRAINT "gateway_ingress_profile_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_ingress_profile" ADD CONSTRAINT "gateway_ingress_profile_installation_id_gateway_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."gateway_installation"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_ingress_profile" ADD CONSTRAINT "gateway_ingress_profile_policy_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_installation" ADD CONSTRAINT "gateway_installation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_policy" ADD CONSTRAINT "gateway_policy_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_policy" ADD CONSTRAINT "gateway_policy_active_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_policy_revision" ADD CONSTRAINT "gateway_policy_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_policy_revision" ADD CONSTRAINT "gateway_policy_revision_policy_id_gateway_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."gateway_policy"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_policy_revision" ADD CONSTRAINT "gateway_policy_revision_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route" ADD CONSTRAINT "gateway_route_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route" ADD CONSTRAINT "gateway_route_installation_id_gateway_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."gateway_installation"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route" ADD CONSTRAINT "gateway_route_active_revision_id_gateway_route_revision_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."gateway_route_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route" ADD CONSTRAINT "gateway_route_attribution_app_id_app_id_fk" FOREIGN KEY ("attribution_app_id") REFERENCES "public"."app"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route" ADD CONSTRAINT "gateway_route_default_action_id_action_id_fk" FOREIGN KEY ("default_action_id") REFERENCES "public"."action"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route_revision" ADD CONSTRAINT "gateway_route_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route_revision" ADD CONSTRAINT "gateway_route_revision_route_id_gateway_route_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."gateway_route"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_route_revision" ADD CONSTRAINT "gateway_route_revision_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_target" ADD CONSTRAINT "gateway_target_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_target" ADD CONSTRAINT "gateway_target_route_revision_id_gateway_route_revision_id_fk" FOREIGN KEY ("route_revision_id") REFERENCES "public"."gateway_route_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_target" ADD CONSTRAINT "gateway_target_provider_credential_id_provider_credential_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."provider_credential"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gateway_target" ADD CONSTRAINT "gateway_target_offering_id_provider_model_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."provider_model_offering"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_ledger" ADD CONSTRAINT "job_ledger_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member" ADD CONSTRAINT "member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_entitlement" ADD CONSTRAINT "model_entitlement_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_entitlement" ADD CONSTRAINT "model_entitlement_policy_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_entitlement" ADD CONSTRAINT "model_entitlement_canonical_model_id_canonical_model_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_model"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_entitlement" ADD CONSTRAINT "model_entitlement_offering_id_provider_model_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."provider_model_offering"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observation" ADD CONSTRAINT "observation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observation_event" ADD CONSTRAINT "observation_event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_approval" ADD CONSTRAINT "policy_approval_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_approval" ADD CONSTRAINT "policy_approval_policy_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_approval" ADD CONSTRAINT "policy_approval_approved_by_member_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_decision" ADD CONSTRAINT "policy_decision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projection_checkpoint" ADD CONSTRAINT "projection_checkpoint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_model_offering" ADD CONSTRAINT "provider_model_offering_canonical_model_id_canonical_model_id_fk" FOREIGN KEY ("canonical_model_id") REFERENCES "public"."canonical_model"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_model_offering" ADD CONSTRAINT "provider_model_offering_active_price_revision_id_provider_price_revision_id_fk" FOREIGN KEY ("active_price_revision_id") REFERENCES "public"."provider_price_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_price_revision" ADD CONSTRAINT "provider_price_revision_offering_id_provider_model_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."provider_model_offering"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_price_revision" ADD CONSTRAINT "provider_price_revision_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_price_revision" ADD CONSTRAINT "provider_price_revision_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "registry_field_evidence" ADD CONSTRAINT "registry_field_evidence_offering_id_provider_model_offering_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."provider_model_offering"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_constraint" ADD CONSTRAINT "request_constraint_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "request_constraint" ADD CONSTRAINT "request_constraint_policy_revision_id_gateway_policy_revision_id_fk" FOREIGN KEY ("policy_revision_id") REFERENCES "public"."gateway_policy_revision"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "storage_stat" ADD CONSTRAINT "storage_stat_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team" ADD CONSTRAINT "team_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team" ADD CONSTRAINT "team_cost_center_id_cost_center_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_center"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_member" ADD CONSTRAINT "team_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_member" ADD CONSTRAINT "team_member_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_member" ADD CONSTRAINT "team_member_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trace_summary" ADD CONSTRAINT "trace_summary_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_aggregate" ADD CONSTRAINT "usage_aggregate_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_profile_id_gateway_ingress_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."gateway_ingress_profile"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_default_app_id_app_id_fk" FOREIGN KEY ("default_app_id") REFERENCES "public"."app"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_default_action_id_action_id_fk" FOREIGN KEY ("default_action_id") REFERENCES "public"."action"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_cost_center_id_cost_center_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_center"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_budget_account_id_budget_account_id_fk" FOREIGN KEY ("budget_account_id") REFERENCES "public"."budget_account"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "virtual_key" ADD CONSTRAINT "virtual_key_successor_key_id_virtual_key_id_fk" FOREIGN KEY ("successor_key_id") REFERENCES "public"."virtual_key"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_slug_uq" ON "action" USING btree ("app_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_token_hash_uq" ON "api_token" USING btree ("keyed_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_token_prefix_uq" ON "api_token" USING btree ("workspace_id","display_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_slug_uq" ON "app" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_ws_time_idx" ON "audit_event" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_target_idx" ON "audit_event" USING btree ("workspace_id","target_kind","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "budget_scope_uq" ON "budget_account" USING btree ("workspace_id","scope_type","scope_id","window");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "allocation_uq" ON "budget_allocation" USING btree ("parent_id","child_id","window");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reservation_request_uq" ON "budget_reservation" USING btree ("budget_account_id","request_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_window_state_ws_idx" ON "budget_window_state" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_model_slug_uq" ON "canonical_model" USING btree ("canonical_slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cli_user_code_uq" ON "cli_authorization" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "config_op_install_idx" ON "config_operation" USING btree ("installation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cost_center_slug_uq" ON "cost_center" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_ledger_budget_idx" ON "cost_ledger" USING btree ("workspace_id","budget_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_ledger_cc_idx" ON "cost_ledger" USING btree ("workspace_id","cost_center_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_encryption_key_ws_idx" ON "data_encryption_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_revision_hash_uq" ON "gateway_config_revision" USING btree ("installation_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "config_active_uq" ON "gateway_config_revision" USING btree ("installation_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingress_host_uq" ON "gateway_ingress_profile" USING btree ("installation_id","hostname");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingress_host_global_uq" ON "gateway_ingress_profile" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_name_uq" ON "gateway_policy" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_revision_hash_uq" ON "gateway_policy_revision" USING btree ("policy_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_name_uq" ON "gateway_route" USING btree ("installation_id","endpoint_kind","public_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "route_revision_hash_uq" ON "gateway_route_revision" USING btree ("route_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "target_revision_idx" ON "gateway_target" USING btree ("route_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_idem_uq" ON "job_ledger" USING btree ("kind","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_claimable_idx" ON "job_ledger" USING btree ("kind","run_after") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_email_uq" ON "member" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entitlement_revision_idx" ON "model_entitlement" USING btree ("policy_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "observation_trace_uq" ON "observation" USING btree ("workspace_id","trace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_ws_time_idx" ON "observation" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_route_time_idx" ON "observation" USING btree ("workspace_id","route_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_status_time_idx" ON "observation" USING btree ("workspace_id","status","created_at" DESC NULLS LAST) WHERE status <> 'ok';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_key_time_idx" ON "observation" USING btree ("workspace_id","virtual_key_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obs_costcenter_idx" ON "observation" USING btree ("workspace_id","cost_center_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "observation_event_dedup_uq" ON "observation_event" USING btree ("workspace_id","producer_id","idempotency_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oe_trace_idx" ON "observation_event" USING btree ("workspace_id","trace_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_decision_trace_idx" ON "policy_decision" USING btree ("workspace_id","trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_credential_ws_idx" ON "provider_credential" USING btree ("workspace_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "offering_uq" ON "provider_model_offering" USING btree ("provider","provider_model_id","region");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offering_canonical_idx" ON "provider_model_offering" USING btree ("canonical_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_hash_uq" ON "provider_price_revision" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_offering_idx" ON "provider_price_revision" USING btree ("offering_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evidence_uq" ON "registry_field_evidence" USING btree ("offering_id","field","source","catalog_revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_stat_ws_time_idx" ON "storage_stat" USING btree ("workspace_id","measured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_slug_uq" ON "team" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_key_hash_uq" ON "virtual_key" USING btree ("keyed_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "virtual_key_prefix_uq" ON "virtual_key" USING btree ("workspace_id","display_prefix");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "virtual_key_ws_idx" ON "virtual_key" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "virtual_key_profile_idx" ON "virtual_key" USING btree ("profile_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_slug_uq" ON "workspace" USING btree ("slug");