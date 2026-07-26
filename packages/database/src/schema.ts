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
  doublePrecision,
  foreignKey,
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

/** Browser-console sessions. Only the HMAC of the HttpOnly cookie value is persisted. */
export const consoleSession = pgTable(
  "console_session",
  {
    id: id(),
    workspaceId: wsId(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id),
    keyedHash: bytea("keyed_hash").notNull(),
    scopes: jsonb("scopes").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("console_session_hash_uq").on(t.keyedHash),
    index("console_session_member_idx").on(t.workspaceId, t.memberId),
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
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    verificationOrigin: text("verification_origin").notNull(),
    approvedBy: text("approved_by").references(() => member.id),
    approvedAt: ts("approved_at"),
    deniedBy: text("denied_by").references(() => member.id),
    deniedAt: ts("denied_at"),
    issuedTokenId: text("issued_token_id").references(() => apiToken.id),
    intervalSeconds: integer("interval_seconds").notNull().default(5),
    lastPolledAt: ts("last_polled_at"),
    pollNotBefore: ts("poll_not_before").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cli_user_code_uq").on(t.userCode),
    index("cli_authorization_pending_review_idx").on(
      t.workspaceId,
      t.status,
      t.expiresAt,
      t.createdAt.desc(),
    ),
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

/** One-time signed-request nonces; claimed through the narrow installation auth definer seam. */
export const installationAuthNonce = pgTable(
  "installation_auth_nonce",
  {
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id, { onDelete: "cascade" }),
    nonceHash: bytea("nonce_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.nonceHash] }),
    index("installation_auth_nonce_expiry_idx").on(t.expiresAt),
    check("installation_auth_nonce_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
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
// Gateway distributed admission state
// ===========================================================================
// These rows are the fleet-wide source of truth for gateway admission.  The
// gateway mutates them atomically through the narrow SQL adapter; they are not
// request telemetry and must remain workspace-isolated under RLS.
export const gatewayRateLimitState = pgTable(
  "gateway_rate_limit_state",
  {
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    virtualKeyId: text("virtual_key_id")
      .notNull()
      .references(() => virtualKey.id),
    configFingerprint: text("config_fingerprint").notNull(),
    requestTokens: doublePrecision("request_tokens").notNull(),
    tokenTokens: doublePrecision("token_tokens").notNull(),
    refilledAt: ts("refilled_at").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.installationId, t.virtualKeyId] }),
    check(
      "gateway_rate_limit_state_tokens_finite_nonneg_chk",
      sql`${t.requestTokens} >= 0
        AND ${t.requestTokens} <> 'NaN'::double precision
        AND ${t.requestTokens} <> 'Infinity'::double precision
        AND ${t.requestTokens} <> '-Infinity'::double precision
        AND ${t.tokenTokens} >= 0
        AND ${t.tokenTokens} <> 'NaN'::double precision
        AND ${t.tokenTokens} <> 'Infinity'::double precision
        AND ${t.tokenTokens} <> '-Infinity'::double precision`,
    ),
  ],
);

export const gatewayConcurrencyLease = pgTable(
  "gateway_concurrency_lease",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    virtualKeyId: text("virtual_key_id")
      .notNull()
      .references(() => virtualKey.id),
    state: text("state").notNull().default("active"),
    expiresAt: ts("expires_at").notNull(),
    releasedAt: ts("released_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("gateway_concurrency_lease_active_installation_expiry_idx")
      .on(t.installationId, t.expiresAt)
      .where(sql`${t.state} = 'active'`),
    index("gateway_concurrency_lease_active_key_expiry_idx")
      .on(t.installationId, t.virtualKeyId, t.expiresAt)
      .where(sql`${t.state} = 'active'`),
    check(
      "gateway_concurrency_lease_state_chk",
      sql`${t.state} IN ('active','released','expired')`,
    ),
    check(
      "gateway_concurrency_lease_release_state_chk",
      sql`(${t.state} = 'released') = (${t.releasedAt} IS NOT NULL)`,
    ),
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
// Durable gateway target health
// ===========================================================================
// Provider-attempt health facts are append-only; the current state is reduced
// independently so publishing can create a new config revision without
// mutating gateway_target.
export const gatewayTargetHealthObservation = pgTable(
  "gateway_target_health_observation",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    targetId: text("target_id")
      .notNull()
      .references(() => gatewayTarget.id),
    routeRevisionId: text("route_revision_id")
      .notNull()
      .references(() => gatewayRouteRevision.id),
    snapshotRevisionId: text("snapshot_revision_id")
      .notNull()
      .references((): AnyPgColumn => gatewayConfigRevision.id),
    sourceEventId: text("source_event_id").notNull(),
    outcome: text("outcome").notNull(),
    httpStatus: integer("http_status"),
    reasonCodes: jsonb("reason_codes").notNull().default([]),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gateway_target_health_observation_source_event_uq").on(
      t.workspaceId,
      t.sourceEventId,
    ),
    index("gateway_target_health_observation_target_window_idx").on(
      t.workspaceId,
      t.targetId,
      t.occurredAt.desc(),
    ),
    index("gateway_target_health_observation_installation_snapshot_idx").on(
      t.workspaceId,
      t.installationId,
      t.snapshotRevisionId,
      t.occurredAt.desc(),
    ),
    check(
      "gateway_target_health_observation_outcome_chk",
      sql`${t.outcome} IN ('success','transient_failure','permanent_failure')`,
    ),
    check(
      "gateway_target_health_observation_http_status_chk",
      sql`${t.httpStatus} IS NULL OR ${t.httpStatus} BETWEEN 100 AND 599`,
    ),
  ],
);

export const gatewayTargetHealth = pgTable(
  "gateway_target_health",
  {
    targetId: text("target_id")
      .primaryKey()
      .references(() => gatewayTarget.id),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    routeRevisionId: text("route_revision_id")
      .notNull()
      .references(() => gatewayRouteRevision.id),
    snapshotRevisionId: text("snapshot_revision_id")
      .notNull()
      .references((): AnyPgColumn => gatewayConfigRevision.id),
    state: text("state").notNull().default("unknown"),
    publishedState: text("published_state").notNull().default("unknown"),
    windowStartedAt: ts("window_started_at"),
    windowEndedAt: ts("window_ended_at"),
    sampleCount: integer("sample_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    transientFailureCount: integer("transient_failure_count").notNull().default(0),
    permanentFailureCount: integer("permanent_failure_count").notNull().default(0),
    consecutiveSuccesses: integer("consecutive_successes").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastOutcome: text("last_outcome"),
    lastObservedAt: ts("last_observed_at"),
    stateChangedAt: ts("state_changed_at"),
    lastRolledUpAt: ts("last_rolled_up_at"),
    nextExpiryAt: ts("next_expiry_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("gateway_target_health_expiry_idx")
      .on(t.nextExpiryAt)
      .where(sql`${t.nextExpiryAt} IS NOT NULL`),
    index("gateway_target_health_installation_state_idx").on(
      t.workspaceId,
      t.installationId,
      t.state,
    ),
    check(
      "gateway_target_health_state_chk",
      sql`${t.state} IN ('unknown','healthy','degraded','unhealthy')`,
    ),
    check(
      "gateway_target_health_published_state_chk",
      sql`${t.publishedState} IN ('unknown','healthy','degraded','unhealthy')`,
    ),
    check(
      "gateway_target_health_last_outcome_chk",
      sql`${t.lastOutcome} IS NULL OR ${t.lastOutcome} IN ('success','transient_failure','permanent_failure')`,
    ),
    check(
      "gateway_target_health_counts_nonneg_chk",
      sql`${t.sampleCount} >= 0
        AND ${t.successCount} >= 0
        AND ${t.transientFailureCount} >= 0
        AND ${t.permanentFailureCount} >= 0
        AND ${t.consecutiveSuccesses} >= 0
        AND ${t.consecutiveFailures} >= 0`,
    ),
    check(
      "gateway_target_health_counts_sum_chk",
      sql`${t.sampleCount} = ${t.successCount} + ${t.transientFailureCount} + ${t.permanentFailureCount}`,
    ),
    check(
      "gateway_target_health_window_order_chk",
      sql`${t.windowStartedAt} IS NULL OR ${t.windowEndedAt} IS NULL OR ${t.windowStartedAt} <= ${t.windowEndedAt}`,
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
    // SPEC §6.6. These literal sets are the DB projection of the policy vocabulary owned by
    // @manifold/contracts (`POLICY_SUBJECT_KINDS` / `POLICY_EFFECTS`). Keep them in lockstep:
    // any change to the const arrays there must be mirrored by a new migration here.
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
    // SPEC §6.6. DB projection of `POLICY_ON_VIOLATIONS`, owned by @manifold/contracts; keep in
    // lockstep — a change to that const array must be mirrored by a new migration here.
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

export const auditDestination = pgTable(
  "audit_destination",
  {
    id: id(),
    workspaceId: wsId(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    encryptedEndpoint: bytea("encrypted_endpoint").notNull(),
    encryptedSecret: bytea("encrypted_secret"),
    dekId: text("dek_id").notNull(),
    status: text("status").notNull().default("configured"),
    disabledAt: ts("disabled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_destination_workspace_idx").on(t.workspaceId, t.createdAt.desc()),
    check("audit_destination_kind_chk", sql`${t.kind} IN ('webhook','siem')`),
    check("audit_destination_status_chk", sql`${t.status} IN ('configured','disabled')`),
  ],
);

export const auditDeliveryJob = pgTable(
  "audit_delivery_job",
  {
    id: id(), workspaceId: wsId(), destinationId: text("destination_id").notNull(), auditEventId: text("audit_event_id").notNull(),
    status: text("status").notNull().default("pending"), attemptCount: integer("attempt_count").notNull().default(0),
    runAfter: ts("run_after").notNull().defaultNow(), leaseUntil: ts("lease_until"), lastErrorCode: text("last_error_code"),
    lastAttemptAt: ts("last_attempt_at"), deliveredAt: ts("delivered_at"), createdAt: ts("created_at").notNull().defaultNow(), updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_delivery_job_claim_idx")
      .on(t.workspaceId, t.runAfter)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const auditDeliveryAttempt = pgTable("audit_delivery_attempt", {
  id: id(), workspaceId: wsId(), jobId: text("job_id").notNull(), attemptNumber: integer("attempt_number").notNull(),
  outcome: text("outcome").notNull(), statusCode: integer("status_code"), errorCode: text("error_code"), createdAt: ts("created_at").notNull().defaultNow(),
});

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
    cacheWriteTokens: tokens("cache_write_tokens").notNull().default(sql`0`),
    audioInputTokens: tokens("audio_input_tokens").notNull().default(sql`0`),
    audioOutputTokens: tokens("audio_output_tokens").notNull().default(sql`0`),
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

/** Exact-sum authorization for one completed grain transition and its later source pruning. */
export const storageRollupCheckpoint = pgTable(
  "storage_rollup_checkpoint",
  {
    workspaceId: wsId(),
    sourceGrain: text("source_grain").notNull(),
    targetGrain: text("target_grain").notNull(),
    bucketStart: ts("bucket_start").notNull(),
    bucketEnd: ts("bucket_end").notNull(),
    exactTotals: jsonb("exact_totals").notNull(),
    completedAt: ts("completed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.targetGrain, t.bucketStart] }),
    check("storage_rollup_checkpoint_grain_chk", sql`
      (${t.sourceGrain}='observation' AND ${t.targetGrain}='hourly')
      OR (${t.sourceGrain}='hourly' AND ${t.targetGrain}='daily')
      OR (${t.sourceGrain}='daily' AND ${t.targetGrain}='monthly')`),
    check("storage_rollup_checkpoint_range_chk", sql`${t.bucketEnd} > ${t.bucketStart}`),
  ],
);

/**
 * Per-dimension source contribution retained after a daily/monthly rollup.
 * It permits an exact replacement when late source data arrives after sibling
 * source buckets have already been pruned.
 */
export const storageRollupSourceCheckpoint = pgTable(
  "storage_rollup_source_checkpoint",
  {
    workspaceId: wsId(),
    sourceGrain: text("source_grain").notNull(),
    targetGrain: text("target_grain").notNull(),
    bucketStart: ts("bucket_start").notNull(),
    sourceBucketStart: ts("source_bucket_start").notNull(),
    dims: jsonb("dims").notNull(),
    dimsHash: text("dims_hash").notNull(),
    requests: money("requests").notNull(),
    inputTokens: tokens("input_tokens").notNull(),
    outputTokens: tokens("output_tokens").notNull(),
    cacheReadTokens: tokens("cache_read_tokens").notNull(),
    reasoningTokens: tokens("reasoning_tokens").notNull(),
    cacheWriteTokens: tokens("cache_write_tokens").notNull(),
    audioInputTokens: tokens("audio_input_tokens").notNull(),
    audioOutputTokens: tokens("audio_output_tokens").notNull(),
    costMicrousd: money("cost_microusd").notNull(),
    errors: money("errors").notNull(),
    failovers: money("failovers").notNull(),
    latencyMsSum: money("latency_ms_sum").notNull(),
    completedAt: ts("completed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.workspaceId,
        t.sourceGrain,
        t.targetGrain,
        t.bucketStart,
        t.sourceBucketStart,
        t.dimsHash,
      ],
    }),
    check(
      "storage_rollup_source_checkpoint_grain_chk",
      sql`(${t.sourceGrain} = 'hourly' AND ${t.targetGrain} = 'daily') OR (${t.sourceGrain} = 'daily' AND ${t.targetGrain} = 'monthly')`,
    ),
    check(
      "storage_rollup_source_checkpoint_window_chk",
      sql`${t.sourceBucketStart} >= ${t.bucketStart} AND ((${t.targetGrain} = 'daily' AND ${t.sourceBucketStart} < ${t.bucketStart} + interval '1 day') OR (${t.targetGrain} = 'monthly' AND ${t.sourceBucketStart} < ${t.bucketStart} + interval '1 month'))`,
    ),
    check(
      "storage_rollup_source_checkpoint_nonnegative_chk",
      sql`${t.requests} >= 0 AND ${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.reasoningTokens} >= 0 AND ${t.cacheWriteTokens} >= 0 AND ${t.audioInputTokens} >= 0 AND ${t.audioOutputTokens} >= 0 AND ${t.costMicrousd} >= 0 AND ${t.errors} >= 0 AND ${t.failovers} >= 0 AND ${t.latencyMsSum} >= 0`,
    ),
  ],
);

/** Fixed-width per-trace truth retained after partition compaction; never reconstructed from aggregates. */
export const compactedTraceProjection = pgTable(
  "compacted_trace_projection",
  {
    workspaceId: wsId(),
    traceId: text("trace_id").notNull(),
    compactedAt: ts("compacted_at").notNull(),
    inputTokens: tokens("input_tokens").notNull(),
    outputTokens: tokens("output_tokens").notNull(),
    cacheReadTokens: tokens("cache_read_tokens").notNull(),
    reasoningTokens: tokens("reasoning_tokens").notNull(),
    cacheWriteTokens: tokens("cache_write_tokens").notNull(),
    audioInputTokens: tokens("audio_input_tokens").notNull(),
    audioOutputTokens: tokens("audio_output_tokens").notNull(),
    usageFidelity: text("usage_fidelity").notNull(),
    costMicrousd: money("cost_microusd").notNull(),
    costFidelity: text("cost_fidelity").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.traceId] }),
    index("compacted_trace_projection_compacted_idx").on(t.workspaceId, t.compactedAt.desc()),
    check("compacted_trace_projection_usage_fidelity_chk", sql`${t.usageFidelity} IN ('exact','estimated','unknown')`),
    check("compacted_trace_projection_cost_fidelity_chk", sql`${t.costFidelity} IN ('exact','estimated','unknown')`),
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
    mutationKey: text("mutation_key"),
    diffJson: jsonb("diff_json").notNull(),
    outcome: text("outcome").notNull(),
    operationKind: text("operation_kind").notNull().default("apply"),
    revisionId: text("revision_id").references(() => gatewayConfigRevision.id),
    servingMode: text("serving_mode").notNull().default("boot_fallback"),
    acceleratorStatus: text("accelerator_status").notNull().default("not_configured"),
    edgeConfigVersion: text("edge_config_version"),
    tripwireItems: jsonb("tripwire_items"),
    approvedBy: text("approved_by").references(() => member.id),
    error: jsonb("error"),
    reconciliationAttempts: integer("reconciliation_attempts").notNull().default(0),
    lastReconcileAt: ts("last_reconcile_at"),
    completedAt: ts("completed_at"),
    createdBy: text("created_by").references(() => member.id),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("config_op_install_idx").on(t.installationId, t.createdAt.desc()),
    index("config_operation_reconcile_idx")
      .on(t.workspaceId, t.acceleratorStatus, t.createdAt)
      .where(sql`${t.acceleratorStatus} IN ('pending','reconciliation_required')`),
    uniqueIndex("config_operation_mutation_key_uq")
      .on(t.workspaceId, t.mutationKey)
      .where(sql`${t.mutationKey} IS NOT NULL`),
    check(
      "config_operation_outcome_chk",
      sql`${t.outcome} IN ('written','accepted','rejected','failed')`,
    ),
    check(
      "config_operation_kind_chk",
      sql`${t.operationKind} IN ('apply','rollback','key_publish','health_publish')`,
    ),
    check(
      "config_operation_serving_mode_chk",
      sql`${t.servingMode} IN ('boot_fallback','edge_config')`,
    ),
    check(
      "config_operation_accelerator_status_chk",
      sql`${t.acceleratorStatus} IN ('not_configured','pending','published','reconciliation_required','superseded')`,
    ),
  ],
);

export const configTripwireApproval = pgTable(
  "config_tripwire_approval",
  {
    id: id(),
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    planHash: text("plan_hash").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    approvedBy: text("approved_by")
      .notNull()
      .references(() => member.id),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    usedByOperationId: text("used_by_operation_id").references(
      () => configOperation.id,
    ),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("config_tripwire_approval_identity_idx").on(
      t.workspaceId,
      t.installationId,
      t.planHash,
      t.kind,
      t.ref,
    ),
    index("config_tripwire_approval_lookup_idx").on(
      t.workspaceId,
      t.installationId,
      t.planHash,
    ),
    check(
      "config_tripwire_approval_kind_chk",
      sql`${t.kind} IN ('route_delete','entitlement_removal','budget_enforcement_relaxed')`,
    ),
    check(
      "config_tripwire_approval_expiry_chk",
      sql`${t.expiresAt} > ${t.createdAt}`,
    ),
    check(
      "config_tripwire_approval_usage_chk",
      sql`(${t.usedAt} IS NULL) = (${t.usedByOperationId} IS NULL)`,
    ),
  ],
);

/** Durable coalescing queue for post-rotation keys-only publications. */
export const keyRotationExpiryPublish = pgTable(
  "key_rotation_expiry_publish",
  {
    workspaceId: wsId(),
    installationId: text("installation_id")
      .notNull()
      .references(() => gatewayInstallation.id),
    operationId: text("operation_id").references(() => configOperation.id),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseUntil: ts("lease_until"),
    lastError: jsonb("last_error"),
    completedAt: ts("completed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.installationId] }),
    index("key_rotation_expiry_publish_claim_idx")
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "key_rotation_expiry_publish_status_chk",
      sql`${t.status} IN ('pending','processing','done')`,
    ),
  ],
);

// ===========================================================================
// §10.1 Control-plane mutation guards
// ===========================================================================

/** Durable response journal for Idempotency-Key protected control-plane mutations. */
export const mutationIdempotency = pgTable(
  "mutation_idempotency",
  {
    id: id(),
    workspaceId: wsId(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    method: text("method").notNull(),
    canonicalPath: text("canonical_path").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull().default("in_progress"),
    leaseExpiresAt: ts("lease_expires_at").notNull(),
    responseStatus: integer("response_status"),
    responseHeaders: jsonb("response_headers"),
    responseBody: bytea("response_body"),
    responseBodyEncrypted: bytea("response_body_encrypted"),
    responseBodyIv: bytea("response_body_iv"),
    responseBodyTag: bytea("response_body_tag"),
    completedAt: ts("completed_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mutation_idempotency_identity_uq").on(
      t.workspaceId,
      t.actorKind,
      t.actorId,
      t.method,
      t.canonicalPath,
      t.idempotencyKey,
    ),
    index("mutation_idempotency_expiry_idx").on(t.workspaceId, t.expiresAt),
    index("mutation_idempotency_cleanup_expiry_idx").on(t.expiresAt),
    check("mutation_idempotency_state_chk", sql`${t.state} IN ('in_progress','completed')`),
    check(
      "mutation_idempotency_completed_response_chk",
      sql`(${t.state} = 'in_progress' AND ${t.responseStatus} IS NULL AND ${t.responseHeaders} IS NULL AND ${t.responseBody} IS NULL AND ${t.responseBodyEncrypted} IS NULL AND ${t.responseBodyIv} IS NULL AND ${t.responseBodyTag} IS NULL AND ${t.completedAt} IS NULL) OR (${t.state} = 'completed' AND ${t.responseStatus} IS NOT NULL AND ${t.responseHeaders} IS NOT NULL AND ((${t.responseBody} IS NOT NULL AND ${t.responseBodyEncrypted} IS NULL AND ${t.responseBodyIv} IS NULL AND ${t.responseBodyTag} IS NULL) OR (${t.responseBody} IS NULL AND ${t.responseBodyEncrypted} IS NOT NULL AND octet_length(${t.responseBodyIv}) = 12 AND octet_length(${t.responseBodyTag}) = 16)) AND ${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

/** Fixed-window, per-principal mutation limiter. Expired buckets are removed on use. */
export const mutationRateLimitBucket = pgTable(
  "mutation_rate_limit_bucket",
  {
    workspaceId: wsId(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    routeIdentity: text("route_identity").notNull(),
    bucketStart: ts("bucket_start").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.actorKind, t.actorId, t.routeIdentity, t.bucketStart] }),
    index("mutation_rate_limit_expiry_idx").on(t.workspaceId, t.expiresAt),
    index("mutation_rate_limit_bucket_cleanup_expiry_idx").on(t.expiresAt),
    check("mutation_rate_limit_count_chk", sql`${t.requestCount} >= 0`),
    check("mutation_rate_limit_expiry_chk", sql`${t.expiresAt} > ${t.bucketStart}`),
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
    index("job_storage_compact_due_idx")
      .on(t.runAfter, t.workspaceId, t.id)
      .where(sql`${t.kind} = 'storage.compact' AND ${t.status} IN ('pending', 'claimed')`),
    check(
      "job_ledger_status_chk",
      sql`${t.status} IN ('pending','claimed','done','failed','dead','superseded')`,
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
    // Null denotes a truthful pre-0011 legacy record. New rows are sealed as v1 by lib/audit.
    chainVersion: integer("chain_version"),
    chainSequence: money("chain_sequence"),
    prevChainHash: bytea("prev_chain_hash"),
    chainHash: bytea("chain_hash"),
    chainSealedAt: ts("chain_sealed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    index("audit_ws_time_idx").on(t.workspaceId, t.createdAt.desc()),
    index("audit_target_idx").on(t.workspaceId, t.targetKind, t.targetId),
    index("audit_chain_workspace_order_idx")
      .on(t.workspaceId, t.chainSequence)
      .where(sql`${t.chainVersion} = 1`),
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
    /** Configured ceiling less the reserved migration/index headroom (§13.2). */
    effectiveCeilingBytes: money("effective_ceiling_bytes"),
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

/** Current ingestion/compaction posture derived solely from the latest storage measurement. */
export const storagePressureState = pgTable(
  "storage_pressure_state",
  {
    workspaceId: wsId().primaryKey(),
    tier: text("tier").notNull(),
    captureMode: text("capture_mode").notNull(),
    payloadSampleRate: numeric("payload_sample_rate").notNull(),
    journalMode: text("journal_mode").notNull(),
    triggerCompaction: boolean("trigger_compaction").notNull(),
    compactEveryMeasure: boolean("compact_every_measure").notNull(),
    blockNonEssentialGrowth: boolean("block_non_essential_growth").notNull(),
    measuredAt: ts("measured_at").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("storage_pressure_state_tier_chk", sql`${t.tier} IN ('normal','warning','high','critical','emergency')`),
    check("storage_pressure_capture_mode_chk", sql`${t.captureMode} IN ('none','metadata','redacted','full')`),
    check("storage_pressure_sample_rate_chk", sql`${t.payloadSampleRate} >= 0 AND ${t.payloadSampleRate} <= 1`),
    check("storage_pressure_journal_mode_chk", sql`${t.journalMode} IN ('full','aggregate_only')`),
  ],
);

/** Bounded one-row-per-pressure-tier or forecast alert history. Repeated measurements never append rows. */
export const storagePressureAlert = pgTable(
  "storage_pressure_alert",
  {
    workspaceId: wsId(),
    tier: text("tier").notNull(),
    openedAt: ts("opened_at").notNull(),
    lastTransitionAt: ts("last_transition_at").notNull(),
    resolvedAt: ts("resolved_at"),
    transitionCount: integer("transition_count").notNull().default(1),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.tier] }),
    check("storage_pressure_alert_tier_chk", sql`${t.tier} IN ('warning','high','critical','emergency','forecast_exhaustion_14d')`),
    check("storage_pressure_alert_count_chk", sql`${t.transitionCount} > 0`),
  ],
);

/** Retention is opt-in and requires an explicit, durable export destination. */
export const storageRetentionSetting = pgTable(
  "storage_retention_setting",
  {
    workspaceId: wsId().primaryKey(),
    minDetailHours: integer("min_detail_hours").notNull().default(24),
    journalRetentionHours: integer("journal_retention_hours").notNull().default(72),
    captureRetentionHours: integer("capture_retention_hours").notNull().default(24),
    minTraceDays: integer("min_trace_days").notNull().default(7),
    observationRetentionDays: integer("observation_retention_days").notNull().default(30),
    costLedgerRetentionDays: integer("cost_ledger_retention_days").notNull().default(30),
    policyDecisionRetentionDays: integer("policy_decision_retention_days").notNull().default(90),
    hourlyAggregateRetentionDays: integer("hourly_aggregate_retention_days").notNull().default(14),
    dailyAggregateRetentionDays: integer("daily_aggregate_retention_days").notNull().default(400),
    exportTarget: text("export_target").notNull().default("disabled"),
    exportLocation: text("export_location"),
    enabledAt: ts("enabled_at"),
    updatedByKind: text("updated_by_kind"),
    updatedById: text("updated_by_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("storage_retention_detail_floor_chk", sql`${t.minDetailHours} >= 1 AND ${t.journalRetentionHours} >= ${t.minDetailHours}`),
    check("storage_retention_capture_chk", sql`${t.captureRetentionHours} BETWEEN 1 AND 8760`),
    check("storage_retention_trace_floor_chk", sql`${t.minTraceDays} >= 1 AND ${t.observationRetentionDays} >= ${t.minTraceDays}`),
    check("storage_retention_cost_floor_chk", sql`${t.costLedgerRetentionDays} >= ${t.minTraceDays}`),
    check("storage_retention_policy_floor_chk", sql`${t.policyDecisionRetentionDays} >= 90`),
    check("storage_retention_aggregate_chk", sql`${t.hourlyAggregateRetentionDays} >= 1 AND ${t.dailyAggregateRetentionDays} >= ${t.hourlyAggregateRetentionDays}`),
  ],
);

export const storageExportManifest = pgTable(
  "storage_export_manifest",
  {
    id: id(),
    workspaceId: wsId(),
    sourceRelation: text("source_relation").notNull(),
    partitionName: text("partition_name").notNull(),
    rangeStart: ts("range_start").notNull(),
    rangeEnd: ts("range_end").notNull(),
    targetKind: text("target_kind").notNull(),
    targetUri: text("target_uri").notNull(),
    sha256: text("sha256").notNull(),
    rowCount: tokens("row_count").notNull(),
    byteCount: money("byte_count").notNull(),
    verifiedAt: ts("verified_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("storage_export_manifest_workspace_id_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("storage_export_manifest_partition_uq").on(t.workspaceId, t.partitionName, t.sha256),
    index("storage_export_manifest_lookup_idx").on(t.workspaceId, t.sourceRelation, t.rangeEnd.desc()),
  ],
);

export const storageCompactionCheckpoint = pgTable(
  "storage_compaction_checkpoint",
  {
    workspaceId: wsId(),
    partitionName: text("partition_name").notNull(),
    exportManifestId: text("export_manifest_id").notNull(),
    state: text("state").notNull().default("export_verified"),
    dropAuthorizedAt: ts("drop_authorized_at"),
    droppedAt: ts("dropped_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.partitionName] }),
    foreignKey({
      columns: [t.workspaceId, t.exportManifestId],
      foreignColumns: [storageExportManifest.workspaceId, storageExportManifest.id],
      name: "storage_checkpoint_workspace_manifest_fk",
    }),
  ],
);

/** Retry-stable export epoch: failed work is durable, but never authorizes a drop. */
export const storageExportAttempt = pgTable(
  "storage_export_attempt",
  {
    workspaceId: wsId(),
    partitionName: text("partition_name").notNull(),
    sourceRelation: text("source_relation").notNull(),
    exportedAt: ts("exported_at").notNull(),
    state: text("state").notNull().default("exporting"),
    exportManifestId: text("export_manifest_id"),
    lastError: text("last_error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.partitionName] }),
    foreignKey({
      columns: [t.workspaceId, t.exportManifestId],
      foreignColumns: [storageExportManifest.workspaceId, storageExportManifest.id],
      name: "storage_export_attempt_workspace_manifest_fk",
    }),
    check("storage_export_attempt_state_chk", sql`${t.state} IN ('exporting','finalizing','verified','failed')`),
    check("storage_export_attempt_shape_chk", sql`(${t.state} IN ('exporting','finalizing') AND ${t.exportManifestId} IS NULL AND ${t.lastError} IS NULL)
      OR (${t.state} = 'verified' AND ${t.exportManifestId} IS NOT NULL AND ${t.lastError} IS NULL)
      OR (${t.state} = 'failed' AND ${t.exportManifestId} IS NULL AND ${t.lastError} IS NOT NULL)`),
  ],
);

/** Immutable, independently gzip-compressed export chunk and keyset resume proof. */
export const storageExportChunk = pgTable(
  "storage_export_chunk",
  {
    workspaceId: wsId(),
    partitionName: text("partition_name").notNull(),
    chunkNumber: integer("chunk_number").notNull(),
    cursorCreatedAt: ts("cursor_created_at").notNull(),
    cursorRowId: text("cursor_row_id").notNull(),
    rowCount: tokens("row_count").notNull(),
    targetUri: text("target_uri").notNull(),
    byteCount: money("byte_count").notNull(),
    sha256: text("sha256").notNull(),
    uncompressedSha256: text("uncompressed_sha256").notNull(),
    verifiedAt: ts("verified_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.partitionName, t.chunkNumber] }),
    foreignKey({
      columns: [t.workspaceId, t.partitionName],
      foreignColumns: [storageExportAttempt.workspaceId, storageExportAttempt.partitionName],
      name: "storage_export_chunk_attempt_fk",
    }).onDelete("cascade"),
    check("storage_export_chunk_number_chk", sql`${t.chunkNumber} >= 1`),
    check("storage_export_chunk_row_count_chk", sql`${t.rowCount} > 0`),
    check("storage_export_chunk_byte_count_chk", sql`${t.byteCount} > 0`),
    check("storage_export_chunk_sha256_chk", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("storage_export_chunk_uncompressed_sha256_chk", sql`${t.uncompressedSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Durable hand-off between the short seal/detach and revalidate/drop transactions. */
export const storagePartitionSeal = pgTable(
  "storage_partition_seal",
  {
    workspaceId: wsId(),
    partitionName: text("partition_name").notNull(),
    sourceRelation: text("source_relation").notNull(),
    sealedRelation: text("sealed_relation").notNull(),
    relationOid: text("relation_oid").notNull(),
    partitionBound: text("partition_bound").notNull(),
    rangeStart: ts("range_start").notNull(),
    rangeEnd: ts("range_end").notNull(),
    sealToken: text("seal_token").notNull(),
    attemptToken: text("attempt_token").notNull(),
    objectKey: text("object_key").notNull(),
    state: text("state").notNull().default("sealed"),
    exportManifestId: text("export_manifest_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.partitionName] }),
    foreignKey({ columns: [t.workspaceId, t.exportManifestId], foreignColumns: [storageExportManifest.workspaceId, storageExportManifest.id], name: "storage_partition_seal_workspace_manifest_fk" }),
  ],
);
