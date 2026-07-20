// packages/database/src/schema.ts — Manifold full database schema (SPEC §6).
//
// The SQL DDL in SPEC §6 is normative; this Drizzle pg-core file mirrors that shape.
// Enums are `text` + CHECK (Pulse style). Money/tokens are BIGINT. IDs are prefixed-ULID text.
//
// Partitioned tables (SPEC §6.13, B1) carry `created_at` in their composite PK/uniques here so
// the TypeScript types are correct; Drizzle does not emit `PARTITION BY`, so the actual RANGE/LIST
// partitioning, RLS, and immutability triggers are declared in migrations/0001_partitions.sql.
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, citext, id, money, partId, ts, tokens } from "./columns.js";

// ---------------------------------------------------------------------------
// jsonb payload types (validated at the edge by @manifold/contracts Zod schemas)
// ---------------------------------------------------------------------------
export type KeyScopes = Record<string, unknown>;
export type RateLimit = { rpm?: number; tpm?: number; burst?: number };
export type CapturePolicy = Record<string, unknown>;

// ===========================================================================
// §6.2 Tenancy & access
// ===========================================================================
export const workspace = pgTable(
  "workspace",
  {
    id: id(), // ws_…
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    region: text("region").notNull(),
    storageCeilingBytes: money("storage_ceiling_bytes")
      .notNull()
      .default(sql`524288000`),
    storageWarnPct: integer("storage_warn_pct").notNull().default(70),
    storageHighPct: integer("storage_high_pct").notNull().default(85),
    storageCritPct: integer("storage_crit_pct").notNull().default(95),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_slug_uq").on(t.slug),
    check("storage_warn_pct_range", sql`${t.storageWarnPct} BETWEEN 1 AND 99`),
    check("storage_high_pct_range", sql`${t.storageHighPct} BETWEEN 1 AND 99`),
    check("storage_crit_pct_range", sql`${t.storageCritPct} BETWEEN 1 AND 100`),
    check(
      "storage_thresholds_ordered",
      sql`${t.storageWarnPct} < ${t.storageHighPct} AND ${t.storageHighPct} < ${t.storageCritPct}`,
    ),
  ],
);

/** Tenant column helper: `workspace_id text NOT NULL REFERENCES workspace(id)` (SPEC §6.1). */
export const wsId = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspace.id);

export const costCenter = pgTable(
  "cost_center",
  {
    id: id(),
    workspaceId: wsId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => costCenter.id),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cost_center_slug_uq").on(t.workspaceId, t.slug)],
);

export const team = pgTable(
  "team",
  {
    id: id(),
    workspaceId: wsId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    costCenterId: text("cost_center_id").references(() => costCenter.id),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("team_slug_uq").on(t.workspaceId, t.slug)],
);

export const member = pgTable(
  "member",
  {
    id: id(),
    workspaceId: wsId(),
    email: citext("email").notNull(),
    name: text("name"),
    role: text("role").notNull(),
    authSubject: text("auth_subject"),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("member_email_uq").on(t.workspaceId, t.email),
    check(
      "member_role_chk",
      sql`${t.role} IN ('owner','admin','editor','viewer','billing')`,
    ),
  ],
);

export const teamMember = pgTable(
  "team_member",
  {
    workspaceId: wsId(),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.memberId] })],
);

export const apiToken = pgTable(
  "api_token",
  {
    id: id(),
    workspaceId: wsId(),
    displayPrefix: text("display_prefix").notNull(),
    keyedHash: bytea("keyed_hash").notNull(),
    scopes: jsonb("scopes").notNull(),
    createdBy: text("created_by").references(() => member.id),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_token_hash_uq").on(t.keyedHash),
    uniqueIndex("api_token_prefix_uq").on(t.workspaceId, t.displayPrefix),
  ],
);

export const cliAuthorization = pgTable(
  "cli_authorization",
  {
    id: id(),
    workspaceId: wsId(),
    deviceCodeHash: bytea("device_code_hash").notNull(),
    userCode: text("user_code").notNull(),
    status: text("status").notNull(),
    scopes: jsonb("scopes").notNull(),
    approvedBy: text("approved_by").references(() => member.id),
    issuedTokenId: text("issued_token_id").references(() => apiToken.id),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cli_user_code_uq").on(t.userCode),
    check(
      "cli_status_chk",
      sql`${t.status} IN ('pending','approved','issued','denied','expired')`,
    ),
  ],
);

// ===========================================================================
// §6.3 Ingress & keys
// ===========================================================================
export const gatewayInstallation = pgTable(
  "gateway_installation",
  {
    id: id(),
    workspaceId: wsId(),
    name: text("name").notNull(),
    publicKey: bytea("public_key"),
    workloadIdentity: jsonb("workload_identity"),
    appliedConfigRevision: text("applied_config_revision"),
    edition: text("edition").notNull().default("vercel"),
    lastSeenAt: ts("last_seen_at"),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "installation_edition_chk",
      sql`${t.edition} IN ('vercel','cloudflare','compose')`,
    ),
    check(
      "installation_identity_present",
      sql`${t.publicKey} IS NOT NULL OR ${t.workloadIdentity} IS NOT NULL`,
    ),
  ],
);

export const gatewayIngressProfile = pgTable(
  "gateway_ingress_profile",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    hostname: text("hostname").notNull(),
    mode: text("mode").notNull(),
    networkExposure: text("network_exposure").notNull().default("public"),
    authConfig: jsonb("auth_config").notNull(),
    networkConfig: jsonb("network_config"),
    policyRevisionId: text("policy_revision_id").references(
      (): AnyPgColumn => gatewayPolicyRevision.id,
    ),
    defaultRouteSet: jsonb("default_route_set"),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ingress_host_uq").on(t.installationId, t.hostname),
    uniqueIndex("ingress_host_global_uq").on(t.hostname),
    check(
      "ingress_mode_chk",
      sql`${t.mode} IN ('public_app','enterprise_egress')`,
    ),
    check(
      "ingress_exposure_chk",
      sql`${t.networkExposure} IN ('public','vpc','mtls')`,
    ),
  ],
);

export const app = pgTable(
  "app",
  {
    id: id(),
    workspaceId: wsId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    defaultCapturePolicy: jsonb("default_capture_policy")
      .$type<CapturePolicy>()
      .notNull(),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("app_slug_uq").on(t.workspaceId, t.slug),
    check("app_status_chk", sql`${t.status} IN ('active','archived')`),
  ],
);

export const action = pgTable(
  "action",
  {
    id: id(),
    workspaceId: wsId(),
    appId: text("app_id")
      .notNull()
      .references(() => app.id),
    slug: text("slug").notNull(),
    name: text("name"),
    source: text("source").notNull().default("explicit"),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("action_slug_uq").on(t.appId, t.slug),
    check(
      "action_source_chk",
      sql`${t.source} IN ('explicit','route_default','discovered')`,
    ),
  ],
);

export const virtualKey = pgTable(
  "virtual_key",
  {
    id: id(),
    workspaceId: wsId(),
    profileId: text("profile_id")
      .notNull()
      .references(() => gatewayIngressProfile.id),
    displayPrefix: text("display_prefix").notNull(),
    keyedHash: bytea("keyed_hash").notNull(),
    scopes: jsonb("scopes").$type<KeyScopes>().notNull(),
    allowedAppIds: jsonb("allowed_app_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    defaultAppId: text("default_app_id").references(() => app.id),
    defaultActionId: text("default_action_id").references(() => action.id),
    principalId: text("principal_id"),
    teamId: text("team_id").references(() => team.id),
    costCenterId: text("cost_center_id").references(() => costCenter.id),
    budgetAccountId: text("budget_account_id").references(
      (): AnyPgColumn => budgetAccount.id,
    ),
    rateLimit: jsonb("rate_limit").$type<RateLimit | null>(),
    successorKeyId: text("successor_key_id").references(
      (): AnyPgColumn => virtualKey.id,
    ),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("virtual_key_hash_uq").on(t.keyedHash),
    uniqueIndex("virtual_key_prefix_uq").on(t.workspaceId, t.displayPrefix),
    index("virtual_key_ws_idx").on(t.workspaceId),
    index("virtual_key_profile_idx")
      .on(t.profileId)
      .where(sql`revoked_at IS NULL`),
  ],
);

// ===========================================================================
// §6.4 Providers, model registry, prices
// ===========================================================================
export const providerCredential = pgTable(
  "provider_credential",
  {
    id: id(),
    workspaceId: wsId(),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    encryptedSecret: bytea("encrypted_secret").notNull(),
    dekId: text("dek_id").notNull(),
    baseUrl: text("base_url"),
    deployment: jsonb("deployment"),
    allowedHosts: jsonb("allowed_hosts").notNull().default([]),
    // `status` is the pre-revoke validation/rotation lifecycle only; `revoked_at` is the SINGLE
    // revoke signal (F23-F3). A row is revoked iff revoked_at IS NOT NULL — 'revoked' is NOT a
    // status value. The CHECK now lists every non-terminal machine state incl. 'rotating', so the
    // domain machine (PROVIDER_CREDENTIAL_STATES) and the CHECK no longer drift.
    status: text("status").notNull().default("unvalidated"),
    lastValidatedAt: ts("last_validated_at"),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("provider_credential_ws_idx")
      .on(t.workspaceId)
      .where(sql`revoked_at IS NULL`),
    check(
      "provider_credential_status_chk",
      sql`${t.status} IN ('unvalidated','valid','invalid','rotating')`,
    ),
  ],
);

export const dataEncryptionKey = pgTable(
  "data_encryption_key",
  {
    id: id(), // dek_…
    workspaceId: wsId(),
    wrappedDek: bytea("wrapped_dek").notNull(),
    kekId: text("kek_id").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("data_encryption_key_ws_idx").on(t.workspaceId),
    check(
      "data_encryption_key_status_chk",
      sql`${t.status} IN ('active','retiring','revoked')`,
    ),
  ],
);

export const canonicalModel = pgTable(
  "canonical_model",
  {
    id: id(), // cm_…
    canonicalSlug: text("canonical_slug").notNull(),
    family: text("family"),
    displayName: text("display_name").notNull(),
    modalityIn: jsonb("modality_in").notNull().default(["text"]),
    modalityOut: jsonb("modality_out").notNull().default(["text"]),
    openWeights: boolean("open_weights"),
    knowledgeCutoff: date("knowledge_cutoff"),
    releaseDate: date("release_date"),
    source: text("source").notNull().default("models.dev"),
    catalogRevision: text("catalog_revision").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("canonical_model_slug_uq").on(t.canonicalSlug)],
);

export const providerModelOffering = pgTable(
  "provider_model_offering",
  {
    id: id(), // off_…
    canonicalModelId: text("canonical_model_id")
      .notNull()
      .references(() => canonicalModel.id),
    provider: text("provider").notNull(),
    providerModelId: text("provider_model_id").notNull(),
    endpointKinds: jsonb("endpoint_kinds").notNull(),
    adapterRevision: text("adapter_revision").notNull(),
    contextLimitTokens: tokens("context_limit_tokens"),
    outputLimitTokens: tokens("output_limit_tokens"),
    capabilities: jsonb("capabilities").notNull(),
    region: text("region"),
    activePriceRevisionId: text("active_price_revision_id").references(
      (): AnyPgColumn => providerPriceRevision.id,
    ),
    catalogRevision: text("catalog_revision").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("offering_uq").on(t.provider, t.providerModelId, t.region),
    index("offering_canonical_idx").on(t.canonicalModelId),
  ],
);

export const providerPriceRevision = pgTable(
  "provider_price_revision",
  {
    id: id(), // prc_…
    offeringId: text("offering_id")
      .notNull()
      .references(() => providerModelOffering.id),
    workspaceId: text("workspace_id").references(() => workspace.id),
    inputPerMtokMicrousd: money("input_per_mtok_microusd"),
    outputPerMtokMicrousd: money("output_per_mtok_microusd"),
    cacheReadPerMtokMicrousd: money("cache_read_per_mtok_microusd"),
    cacheWritePerMtokMicrousd: money("cache_write_per_mtok_microusd"),
    reasoningPerMtokMicrousd: money("reasoning_per_mtok_microusd"),
    audioInPerMtokMicrousd: money("audio_in_per_mtok_microusd"),
    audioOutPerMtokMicrousd: money("audio_out_per_mtok_microusd"),
    currency: text("currency").notNull().default("USD"),
    unit: text("unit").notNull().default("per_mtok"),
    fidelity: text("fidelity").notNull(),
    effectiveFrom: ts("effective_from").notNull().defaultNow(),
    contentHash: text("content_hash").notNull(),
    catalogRevision: text("catalog_revision"),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("price_hash_uq").on(t.contentHash),
    index("price_offering_idx").on(t.offeringId, t.effectiveFrom.desc()),
    check("price_currency_chk", sql`${t.currency} = 'USD'`),
    check("price_unit_chk", sql`${t.unit} = 'per_mtok'`),
    check(
      "price_fidelity_chk",
      sql`${t.fidelity} IN ('provider_verified','operator_override','aggregator','unknown')`,
    ),
  ],
);

export const registryFieldEvidence = pgTable(
  "registry_field_evidence",
  {
    id: id(),
    offeringId: text("offering_id")
      .notNull()
      .references(() => providerModelOffering.id),
    field: text("field").notNull(),
    value: jsonb("value"),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    observedAt: ts("observed_at").notNull(),
    catalogRevision: text("catalog_revision").notNull(),
  },
  (t) => [
    uniqueIndex("evidence_uq").on(
      t.offeringId,
      t.field,
      t.source,
      t.catalogRevision,
    ),
  ],
);

// ===========================================================================
// §6.5 Routes, revisions, targets
// ===========================================================================
export const gatewayRoute = pgTable(
  "gateway_route",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    publicName: text("public_name").notNull(),
    endpointKind: text("endpoint_kind").notNull(),
    activeRevisionId: text("active_revision_id").references(
      (): AnyPgColumn => gatewayRouteRevision.id,
    ),
    attributionAppId: text("attribution_app_id").references(() => app.id),
    defaultActionId: text("default_action_id").references(() => action.id),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("route_name_uq").on(
      t.installationId,
      t.endpointKind,
      t.publicName,
    ),
    check(
      "route_endpoint_kind_chk",
      sql`${t.endpointKind} IN ('chat','responses','embeddings')`,
    ),
  ],
);

export const gatewayRouteRevision = pgTable(
  "gateway_route_revision",
  {
    id: id(),
    workspaceId: wsId(),
    routeId: text("route_id")
      .notNull()
      .references(() => gatewayRoute.id),
    mode: text("mode").notNull(),
    retryPolicy: jsonb("retry_policy").notNull(),
    timeoutPolicy: jsonb("timeout_policy").notNull(),
    capturePolicy: jsonb("capture_policy"),
    contentHash: text("content_hash").notNull(),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("route_revision_hash_uq").on(t.routeId, t.contentHash),
    check("route_revision_mode_chk", sql`${t.mode} IN ('ordered','weighted')`),
  ],
);

export const gatewayTarget = pgTable(
  "gateway_target",
  {
    id: id(),
    workspaceId: wsId(),
    routeRevisionId: text("route_revision_id")
      .notNull()
      .references(() => gatewayRouteRevision.id),
    providerCredentialId: text("provider_credential_id")
      .notNull()
      .references(() => providerCredential.id),
    offeringId: text("offering_id")
      .notNull()
      .references(() => providerModelOffering.id),
    adapterRevision: text("adapter_revision").notNull(),
    baseUrl: text("base_url"),
    deployment: jsonb("deployment"),
    region: text("region"),
    weight: integer("weight").notNull().default(1),
    priority: integer("priority").notNull().default(0),
    healthState: text("health_state").notNull().default("unknown"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("target_revision_idx").on(t.routeRevisionId),
    check("target_weight_chk", sql`${t.weight} >= 0`),
    check(
      "target_health_state_chk",
      sql`${t.healthState} IN ('healthy','degraded','unhealthy','unknown')`,
    ),
    check(
      "target_weight_priority",
      sql`${t.weight} >= 0 AND ${t.priority} >= 0`,
    ),
  ],
);

// ===========================================================================
// §6.6 Governance: policies, revisions, constraints
// ===========================================================================
export const gatewayPolicy = pgTable(
  "gateway_policy",
  {
    id: id(),
    workspaceId: wsId(),
    name: text("name").notNull(),
    activeRevisionId: text("active_revision_id").references(
      (): AnyPgColumn => gatewayPolicyRevision.id,
    ),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("policy_name_uq").on(t.workspaceId, t.name)],
);

export const gatewayPolicyRevision = pgTable(
  "gateway_policy_revision",
  {
    id: id(),
    workspaceId: wsId(),
    policyId: text("policy_id")
      .notNull()
      .references(() => gatewayPolicy.id),
    contentHash: text("content_hash").notNull(),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("policy_revision_hash_uq").on(t.policyId, t.contentHash)],
);

export const modelEntitlement = pgTable(
  "model_entitlement",
  {
    id: id(),
    workspaceId: wsId(),
    policyRevisionId: text("policy_revision_id")
      .notNull()
      .references(() => gatewayPolicyRevision.id),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: text("subject_ref"),
    canonicalModelId: text("canonical_model_id").references(
      () => canonicalModel.id,
    ),
    offeringId: text("offering_id").references(() => providerModelOffering.id),
    effect: text("effect").notNull().default("allow"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("entitlement_revision_idx").on(t.policyRevisionId),
    check(
      "entitlement_subject_kind_chk",
      sql`${t.subjectKind} IN ('key_scope','team','cost_center','app','all')`,
    ),
    check("entitlement_effect_chk", sql`${t.effect} IN ('allow','deny')`),
  ],
);

export const requestConstraint = pgTable(
  "request_constraint",
  {
    id: id(),
    workspaceId: wsId(),
    policyRevisionId: text("policy_revision_id")
      .notNull()
      .references(() => gatewayPolicyRevision.id),
    param: text("param").notNull(),
    maxValue: numeric("max_value"),
    minValue: numeric("min_value"),
    onViolation: text("on_violation").notNull().default("clamp"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "request_constraint_on_violation_chk",
      sql`${t.onViolation} IN ('clamp','reject')`,
    ),
  ],
);

export const dataHandlingConstraint = pgTable(
  "data_handling_constraint",
  {
    id: id(),
    workspaceId: wsId(),
    policyRevisionId: text("policy_revision_id")
      .notNull()
      .references(() => gatewayPolicyRevision.id),
    captureMode: text("capture_mode").notNull().default("redacted"),
    redaction: jsonb("redaction"),
    allowedRegions: jsonb("allowed_regions"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "data_handling_capture_mode_chk",
      sql`${t.captureMode} IN ('none','metadata','redacted','full')`,
    ),
  ],
);

export const policyApproval = pgTable("policy_approval", {
  id: id(),
  workspaceId: wsId(),
  policyRevisionId: text("policy_revision_id")
    .notNull()
    .references(() => gatewayPolicyRevision.id),
  approvedBy: text("approved_by")
    .notNull()
    .references(() => member.id),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ===========================================================================
// §6.7 Budgets, allocations, reservations, ledgers
// ===========================================================================
export const budgetAccount = pgTable(
  "budget_account",
  {
    id: id(),
    workspaceId: wsId(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),
    parentId: text("parent_id").references((): AnyPgColumn => budgetAccount.id),
    unit: text("unit").notNull(),
    currency: text("currency").notNull().default("USD"),
    window: text("window").notNull(),
    limitAmount: money("limit_amount").notNull(),
    enforcement: text("enforcement").notNull(),
    pricingCatalogRevisionId: text("pricing_catalog_revision_id"),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budget_scope_uq").on(
      t.workspaceId,
      t.scopeType,
      t.scopeId,
      t.window,
    ),
    check(
      "budget_scope_type_chk",
      sql`${t.scopeType} IN ('workspace','team','app','cost_center','key')`,
    ),
    check("budget_unit_chk", sql`${t.unit} IN ('cost_microusd','tokens')`),
    check(
      "budget_window_chk",
      sql`${t.window} IN ('daily','weekly','monthly','rolling_30d','total')`,
    ),
    check("budget_limit_amount_chk", sql`${t.limitAmount} >= 0`),
    check(
      "budget_enforcement_chk",
      sql`${t.enforcement} IN ('advisory','hard')`,
    ),
    check(
      "hard_requires_pricing",
      sql`${t.enforcement} <> 'hard' OR ${t.pricingCatalogRevisionId} IS NOT NULL`,
    ),
  ],
);

export const budgetAllocation = pgTable(
  "budget_allocation",
  {
    id: id(),
    workspaceId: wsId(),
    parentId: text("parent_id")
      .notNull()
      .references(() => budgetAccount.id),
    childId: text("child_id")
      .notNull()
      .references(() => budgetAccount.id),
    reservedAllowance: money("reserved_allowance").notNull(),
    window: text("window").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("allocation_uq").on(t.parentId, t.childId, t.window),
    check(
      "allocation_reserved_allowance_chk",
      sql`${t.reservedAllowance} >= 0`,
    ),
  ],
);

// Partitioned by month on created_at (B1). PK/unique include created_at.
export const budgetReservation = pgTable(
  "budget_reservation",
  {
    id: partId(),
    workspaceId: wsId(),
    budgetAccountId: text("budget_account_id")
      .notNull()
      .references(() => budgetAccount.id),
    requestId: text("request_id").notNull(),
    estimatedInputTokens: tokens("estimated_input_tokens").notNull(),
    maxOutputTokens: tokens("max_output_tokens").notNull(),
    reservedMicrousd: money("reserved_microusd").notNull(),
    reservedTokens: tokens("reserved_tokens"),
    status: text("status").notNull(),
    reconciledMicrousd: money("reconciled_microusd"),
    reconciledTokens: tokens("reconciled_tokens"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
    reconciledAt: ts("reconciled_at"),
    // Exact counter-row coordinates that reserve() bumped (added by migration
    // 0003_reservation_counter_coords, SPEC §16.3). commit()/rollback()/sweepExpired()
    // decrement THAT same budget_window_state row instead of re-deriving it. reserve() always
    // writes it; tightened to NOT NULL by migration 0005 (it was born nullable only because it
    // was added to an existing partitioned table). `shard` mirrors budget_window_state.shard.
    windowStart: ts("window_start").notNull(),
    shard: smallint("shard").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex("reservation_request_uq").on(
      t.budgetAccountId,
      t.requestId,
      t.createdAt,
    ),
    // Sweep index (0005): sweepExpired() finds reserved rows past expiry without seq-scanning
    // every partition. Partial on status='reserved' so committed/rolled_back/expired are excluded.
    index("reservation_sweep_idx")
      .on(t.expiresAt)
      .where(sql`status = 'reserved'`),
    check("reservation_reserved_microusd_chk", sql`${t.reservedMicrousd} >= 0`),
    check(
      "reservation_status_chk",
      sql`${t.status} IN ('reserved','committed','rolled_back','expired')`,
    ),
  ],
);

export const budgetWindowState = pgTable(
  "budget_window_state",
  {
    workspaceId: wsId(),
    budgetAccountId: text("budget_account_id")
      .notNull()
      .references(() => budgetAccount.id),
    windowStart: ts("window_start").notNull(),
    shard: smallint("shard").notNull().default(0),
    committedMicrousd: money("committed_microusd").notNull().default(sql`0`),
    reservedMicrousd: money("reserved_microusd").notNull().default(sql`0`),
    committedTokens: tokens("committed_tokens").notNull().default(sql`0`),
    reservedTokens: tokens("reserved_tokens").notNull().default(sql`0`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.budgetAccountId, t.windowStart, t.shard] }),
    index("budget_window_state_ws_idx").on(t.workspaceId),
    // Non-negativity of the money-truth counters (0005, §16.3): a decrement can never drive
    // committed/reserved below zero.
    check(
      "budget_window_state_nonneg_chk",
      sql`${t.committedMicrousd} >= 0 AND ${t.reservedMicrousd} >= 0 AND ${t.committedTokens} >= 0 AND ${t.reservedTokens} >= 0`,
    ),
  ],
);

// ===========================================================================
// §6.8 Observations: journal, reduction, decisions
// ===========================================================================
// Partitioned by RANGE(created_at) monthly (B1).
export const observationEvent = pgTable(
  "observation_event",
  {
    id: partId(),
    workspaceId: wsId(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parentSpanId: text("parent_span_id"),
    installationId: text("installation_id").notNull(),
    profileMode: text("profile_mode").notNull(),
    appId: text("app_id"),
    actionId: text("action_id"),
    routeId: text("route_id"),
    routeRevisionId: text("route_revision_id"),
    virtualKeyId: text("virtual_key_id"),
    kind: text("kind").notNull(),
    seq: integer("seq").notNull(),
    producerId: text("producer_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex("observation_event_dedup_uq").on(
      t.workspaceId,
      t.producerId,
      t.idempotencyKey,
      t.createdAt,
    ),
    index("oe_trace_idx").on(t.workspaceId, t.traceId, t.seq),
    check(
      "observation_event_kind_chk",
      sql`${t.kind} IN ('accepted','provider_attempt','terminal','annotation')`,
    ),
  ],
);

export const observation = pgTable(
  "observation",
  {
    id: partId(),
    workspaceId: wsId(),
    traceId: text("trace_id").notNull(),
    installationId: text("installation_id").notNull(),
    profileMode: text("profile_mode").notNull(),
    routeId: text("route_id"),
    routeRevisionId: text("route_revision_id"),
    publicName: text("public_name"),
    endpointKind: text("endpoint_kind"),
    finalProvider: text("final_provider"),
    finalOfferingId: text("final_offering_id"),
    adapterRevision: text("adapter_revision"),
    priceRevisionId: text("price_revision_id"),
    appId: text("app_id"),
    actionId: text("action_id"),
    teamId: text("team_id"),
    costCenterId: text("cost_center_id"),
    virtualKeyId: text("virtual_key_id"),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    inputTokens: tokens("input_tokens"),
    outputTokens: tokens("output_tokens"),
    cacheReadTokens: tokens("cache_read_tokens"),
    reasoningTokens: tokens("reasoning_tokens"),
    cacheWriteTokens: tokens("cache_write_tokens"),
    audioInputTokens: tokens("audio_input_tokens"),
    audioOutputTokens: tokens("audio_output_tokens"),
    costMicrousd: money("cost_microusd"),
    costFidelity: text("cost_fidelity"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"),
    attempts: integer("attempts").notNull().default(1),
    failovers: integer("failovers").notNull().default(0),
    policyDecisionId: text("policy_decision_id"),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    captureRef: jsonb("capture_ref"),
    compacted: boolean("compacted").notNull().default(false),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    uniqueIndex("observation_trace_uq").on(
      t.workspaceId,
      t.traceId,
      t.createdAt,
    ),
    index("obs_ws_time_idx").on(t.workspaceId, t.createdAt.desc()),
    index("obs_route_time_idx").on(
      t.workspaceId,
      t.routeId,
      t.createdAt.desc(),
    ),
    index("obs_status_time_idx")
      .on(t.workspaceId, t.status, t.createdAt.desc())
      .where(sql`status <> 'ok'`),
    index("obs_key_time_idx").on(
      t.workspaceId,
      t.virtualKeyId,
      t.createdAt.desc(),
    ),
    index("obs_costcenter_idx").on(
      t.workspaceId,
      t.costCenterId,
      t.createdAt.desc(),
    ),
    check(
      "observation_status_chk",
      sql`${t.status} IN ('ok','error','denied','clamped','timeout')`,
    ),
    check(
      "observation_cost_fidelity_chk",
      sql`${t.costFidelity} IN ('exact','estimated','unknown')`,
    ),
  ],
);

export const traceSummary = pgTable(
  "trace_summary",
  {
    workspaceId: wsId(),
    traceId: text("trace_id").notNull(),
    rootObservationId: text("root_observation_id").notNull(),
    spanCount: integer("span_count").notNull(),
    error: boolean("error").notNull(),
    totalCostMicrousd: money("total_cost_microusd"),
    totalLatencyMs: integer("total_latency_ms"),
    startedAt: ts("started_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.traceId, t.createdAt] }),
  ],
);

export const policyDecision = pgTable(
  "policy_decision",
  {
    id: partId(),
    workspaceId: wsId(),
    requestId: text("request_id").notNull(),
    traceId: text("trace_id"),
    outcome: text("outcome").notNull(),
    reasonCodes: jsonb("reason_codes").notNull(),
    policyRevisionId: text("policy_revision_id"),
    detail: jsonb("detail"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("policy_decision_trace_idx").on(t.workspaceId, t.traceId),
    check(
      "policy_decision_outcome_chk",
      sql`${t.outcome} IN ('allow','clamp','deny')`,
    ),
  ],
);

export const annotation = pgTable("annotation", {
  id: id(),
  workspaceId: wsId(),
  traceId: text("trace_id").notNull(),
  authorId: text("author_id").references(() => member.id),
  body: text("body"),
  tags: jsonb("tags"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const feedbackEvent = pgTable("feedback_event", {
  id: id(),
  workspaceId: wsId(),
  traceId: text("trace_id").notNull(),
  score: numeric("score"),
  label: text("label"),
  source: text("source"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ===========================================================================
// §6.9 Projections: usage records, cost ledger, aggregates
// ===========================================================================
export const usageRecord = pgTable(
  "usage_record",
  {
    id: partId(),
    workspaceId: wsId(),
    observationId: text("observation_id").notNull(),
    traceId: text("trace_id").notNull(),
    inputTokens: tokens("input_tokens"),
    outputTokens: tokens("output_tokens"),
    cacheReadTokens: tokens("cache_read_tokens"),
    reasoningTokens: tokens("reasoning_tokens"),
    cacheWriteTokens: tokens("cache_write_tokens"),
    audioInputTokens: tokens("audio_input_tokens"),
    audioOutputTokens: tokens("audio_output_tokens"),
    fidelity: text("fidelity").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // Idempotent re-ingest (0005): with ON CONFLICT DO NOTHING + a deterministic created_at in
    // observe.ts, a replayed observation cannot double-insert usage. created_at is in the key
    // because the table is partitioned by it.
    uniqueIndex("usage_record_ingest_uq").on(
      t.workspaceId,
      t.observationId,
      t.createdAt,
    ),
    check(
      "usage_record_fidelity_chk",
      sql`${t.fidelity} IN ('exact','estimated','unknown')`,
    ),
  ],
);

export const costLedger = pgTable(
  "cost_ledger",
  {
    id: partId(),
    workspaceId: wsId(),
    observationId: text("observation_id"),
    traceId: text("trace_id"),
    budgetAccountId: text("budget_account_id"),
    costCenterId: text("cost_center_id"),
    teamId: text("team_id"),
    appId: text("app_id"),
    virtualKeyId: text("virtual_key_id"),
    amountMicrousd: money("amount_microusd").notNull(),
    fidelity: text("fidelity").notNull(),
    priceRevisionId: text("price_revision_id"),
    offeringId: text("offering_id"),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("cost_ledger_budget_idx").on(
      t.workspaceId,
      t.budgetAccountId,
      t.occurredAt,
    ),
    index("cost_ledger_cc_idx").on(
      t.workspaceId,
      t.costCenterId,
      t.occurredAt,
    ),
    // Idempotent re-ingest (0005): with ON CONFLICT DO NOTHING + a deterministic created_at in
    // observe.ts, a replayed observation cannot double-insert cost. created_at is in the key
    // because the table is partitioned by it. (observation_id is nullable for non-observation
    // ledger entries; NULLs are distinct, so those rows are never deduped by this index.)
    uniqueIndex("cost_ledger_ingest_uq").on(
      t.workspaceId,
      t.observationId,
      t.createdAt,
    ),
    check(
      "cost_ledger_fidelity_chk",
      sql`${t.fidelity} IN ('exact','estimated','unknown')`,
    ),
  ],
);

// Partitioned by LIST(grain).
export const usageAggregate = pgTable(
  "usage_aggregate",
  {
    workspaceId: wsId(),
    grain: text("grain").notNull(),
    bucketStart: ts("bucket_start").notNull(),
    dims: jsonb("dims").notNull(),
    requests: money("requests").notNull().default(sql`0`),
    inputTokens: tokens("input_tokens").notNull().default(sql`0`),
    outputTokens: tokens("output_tokens").notNull().default(sql`0`),
    cacheReadTokens: tokens("cache_read_tokens").notNull().default(sql`0`),
    reasoningTokens: tokens("reasoning_tokens").notNull().default(sql`0`),
    costMicrousd: money("cost_microusd").notNull().default(sql`0`),
    errors: money("errors").notNull().default(sql`0`),
    failovers: money("failovers").notNull().default(sql`0`),
    latencyMsSum: money("latency_ms_sum").notNull().default(sql`0`),
    latencyMsP95: integer("latency_ms_p95"),
    dimsHash: text("dims_hash").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.workspaceId, t.grain, t.bucketStart, t.dimsHash],
    }),
    check(
      "usage_aggregate_grain_chk",
      sql`${t.grain} IN ('hourly','daily','monthly')`,
    ),
  ],
);

export const projectionCheckpoint = pgTable(
  "projection_checkpoint",
  {
    workspaceId: wsId(),
    projection: text("projection").notNull(),
    lastEventId: text("last_event_id"),
    lastEventSeq: money("last_event_seq"),
    lastProcessedAt: ts("last_processed_at"),
    lagSeconds: integer("lag_seconds"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.projection] })],
);

// ===========================================================================
// §6.11 Config revisions and operations
// ===========================================================================
export const gatewayConfigRevision = pgTable(
  "gateway_config_revision",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    contentHash: text("content_hash").notNull(),
    parentRevisionId: text("parent_revision_id").references(
      (): AnyPgColumn => gatewayConfigRevision.id,
    ),
    snapshot: jsonb("snapshot").notNull(),
    routeIds: jsonb("route_ids"),
    policyIds: jsonb("policy_ids"),
    priceIds: jsonb("price_ids"),
    status: text("status").notNull(),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("config_revision_hash_uq").on(t.installationId, t.contentHash),
    uniqueIndex("config_active_uq")
      .on(t.installationId)
      .where(sql`status = 'active'`),
    check(
      "config_revision_status_chk",
      sql`${t.status} IN ('active','superseded','rolled_back')`,
    ),
  ],
);

export const configOperation = pgTable(
  "config_operation",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id").notNull(),
    baseConfigHash: text("base_config_hash"),
    targetConfigHash: text("target_config_hash"),
    planHash: text("plan_hash"),
    diffJson: jsonb("diff_json").notNull(),
    outcome: text("outcome").notNull(),
    edgeConfigVersion: text("edge_config_version"),
    tripwireItems: jsonb("tripwire_items"),
    approvedBy: text("approved_by").references(() => member.id),
    error: jsonb("error"),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("config_op_install_idx").on(t.installationId, t.createdAt.desc()),
    check(
      "config_operation_outcome_chk",
      sql`${t.outcome} IN ('written','accepted','rejected','failed')`,
    ),
  ],
);

// ===========================================================================
// §6.12 Job ledger, audit, alerts, storage stats
// ===========================================================================
export const jobLedger = pgTable(
  "job_ledger",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspace.id),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(12),
    runAfter: ts("run_after").notNull().defaultNow(),
    claimedAt: ts("claimed_at"),
    claimedBy: text("claimed_by"),
    lastError: jsonb("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_idem_uq").on(t.kind, t.idempotencyKey),
    index("job_claimable_idx")
      .on(t.kind, t.runAfter)
      .where(sql`status = 'pending'`),
    check(
      "job_ledger_status_chk",
      sql`${t.status} IN ('pending','claimed','done','failed','dead')`,
    ),
  ],
);

// Partitioned by RANGE(created_at) monthly (B1).
export const auditEvent = pgTable(
  "audit_event",
  {
    id: partId(),
    workspaceId: wsId(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    requestRef: text("request_ref"),
    detail: jsonb("detail"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("audit_ws_time_idx").on(t.workspaceId, t.createdAt.desc()),
    index("audit_target_idx").on(t.workspaceId, t.targetKind, t.targetId),
    check(
      "audit_actor_kind_chk",
      sql`${t.actorKind} IN ('member','api_token','cli','system')`,
    ),
  ],
);

export const alertRule = pgTable("alert_rule", {
  id: id(),
  workspaceId: wsId(),
  scopeType: text("scope_type").notNull(),
  scopeId: text("scope_id"),
  metric: text("metric").notNull(),
  threshold: numeric("threshold").notNull(),
  window: text("window").notNull(),
  destinations: jsonb("destinations").notNull(),
  disabledAt: ts("disabled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const storageStat = pgTable(
  "storage_stat",
  {
    id: id(),
    workspaceId: wsId(),
    measuredAt: ts("measured_at").notNull(),
    totalBytes: money("total_bytes").notNull(),
    tableBytes: jsonb("table_bytes").notNull(),
    indexBytes: money("index_bytes").notNull(),
    toastBytes: money("toast_bytes").notNull(),
    ceilingBytes: money("ceiling_bytes").notNull(),
    usedPct: numeric("used_pct").notNull(),
    growthBytesPerDay: money("growth_bytes_per_day"),
    forecastExhaustionAt: ts("forecast_exhaustion_at"),
    tier: text("tier").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("storage_stat_ws_time_idx").on(
      t.workspaceId,
      t.measuredAt.desc(),
    ),
    check(
      "storage_stat_tier_chk",
      sql`${t.tier} IN ('normal','warning','high','critical','emergency')`,
    ),
  ],
);
