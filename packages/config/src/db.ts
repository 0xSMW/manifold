// DB access for the config package.
//
// SPEC §4.2 forbids `config` from importing `drizzle-orm` / `postgres` directly (`database` is
// the sole owner). We therefore never import those packages; we use the postgres-js tagged
// client that `@manifold/database` exposes on the drizzle handle (`db.$client`). All reads and
// writes go through it, so the only DB dependency is the connection object handed to us.
import type { Database } from "@manifold/database";

/** The postgres-js tagged-template client exposed by the drizzle handle (§4.2). */
export type PgSql = Database["$client"];

/** The value type postgres-js accepts for `sql.json(...)` jsonb params. */
export type JsonParam = Parameters<PgSql["json"]>[0];

/** Cast an arbitrary JSON-serializable value to the client's json-param type. */
export function jval(v: unknown): JsonParam {
  return v as unknown as JsonParam;
}

export function client(db: Database): PgSql {
  return db.$client;
}

// ── Row shapes (snake_case, as returned by postgres-js) ─────────────────────
export interface InstallationRow {
  id: string;
  workspace_id: string;
  applied_config_revision: string | null;
}
export interface ProfileRow {
  id: string;
  hostname: string;
  mode: "public_app" | "enterprise_egress";
  policy_revision_id: string | null;
  default_route_set: unknown;
}
export interface VirtualKeyRow {
  id: string;
  profile_id: string;
  keyed_hash: Uint8Array;
  scopes: unknown;
  allowed_app_ids: unknown;
  budget_account_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}
export interface RouteRow {
  id: string;
  public_name: string;
  endpoint_kind: string;
  active_revision_id: string | null;
}
export interface RouteRevisionRow {
  id: string;
  route_id: string;
  mode: "ordered" | "weighted";
  timeout_policy: Record<string, unknown>;
  capture_policy: Record<string, unknown> | null;
  content_hash: string;
}
export interface TargetRow {
  id: string;
  route_revision_id: string;
  provider_credential_id: string;
  offering_id: string;
  adapter_revision: string;
  base_url: string | null;
  region: string | null;
  weight: number;
  priority: number;
}
export interface CredentialRow {
  id: string;
  provider: string;
  encrypted_secret: Uint8Array;
  dek_id: string;
  base_url: string | null;
  allowed_hosts: unknown;
}
export interface DekRow {
  id: string;
  wrapped_dek: Uint8Array;
}
export interface OfferingRow {
  id: string;
  provider: string;
  provider_model_id: string;
  adapter_revision: string;
  region: string | null;
  capabilities: unknown;
  active_price_revision_id: string | null;
}
export interface PriceRow {
  id: string;
  fidelity: string;
  // Per-mtok µ$ columns (int8 → decimal string over the driver, kept exact). Null when unpriced.
  input_per_mtok_microusd: string | null;
  output_per_mtok_microusd: string | null;
  cache_read_per_mtok_microusd: string | null;
  cache_write_per_mtok_microusd: string | null;
  reasoning_per_mtok_microusd: string | null;
  audio_in_per_mtok_microusd: string | null;
  audio_out_per_mtok_microusd: string | null;
}
export interface EntitlementRow {
  policy_revision_id: string;
  subject_kind: string;
  subject_ref: string | null;
  canonical_model_id: string | null;
  offering_id: string | null;
  effect: "allow" | "deny";
}
export interface RequestConstraintRow {
  policy_revision_id: string;
  param: string;
  max_value: string | null;
  min_value: string | null;
  on_violation: string;
}
export interface DataHandlingRow {
  policy_revision_id: string;
  capture_mode: string;
  redaction: unknown;
  allowed_regions: unknown;
}
export interface BudgetAccountRow {
  id: string;
  /** DB enforcement class: 'advisory' | 'hard' (schema budget_enforcement_chk). */
  enforcement: string;
  /** 'cost_microusd' | 'tokens' (schema budget_unit_chk). */
  unit: string;
  /** 'daily' | 'weekly' | 'monthly' | 'rolling_30d' | 'total' (schema budget_window_chk). */
  window: string;
  /** Cap as a decimal string (µ$ or tokens per `unit`); bigint column serialized by postgres-js. */
  limit_amount: string;
}
export interface ConfigRevisionRow {
  id: string;
  installation_id: string;
  workspace_id: string;
  content_hash: string;
  snapshot: unknown;
  status: string;
}

// ── Reads ───────────────────────────────────────────────────────────────────
export async function readInstallation(
  sql: PgSql,
  installationId: string,
): Promise<InstallationRow | null> {
  const rows = await sql<InstallationRow[]>`
    SELECT id, workspace_id, applied_config_revision
    FROM gateway_installation WHERE id = ${installationId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function readProfiles(sql: PgSql, installationId: string): Promise<ProfileRow[]> {
  return sql<ProfileRow[]>`
    SELECT id, hostname, mode, policy_revision_id, default_route_set
    FROM gateway_ingress_profile
    WHERE installation_id = ${installationId} AND disabled_at IS NULL`;
}

export async function readVirtualKeys(
  sql: PgSql,
  profileIds: string[],
): Promise<VirtualKeyRow[]> {
  if (profileIds.length === 0) return [];
  return sql<VirtualKeyRow[]>`
    SELECT id, profile_id, keyed_hash, scopes, allowed_app_ids,
           budget_account_id, expires_at, revoked_at
    FROM virtual_key WHERE profile_id IN ${sql(profileIds)}`;
}

export async function readRoutes(sql: PgSql, installationId: string): Promise<RouteRow[]> {
  return sql<RouteRow[]>`
    SELECT id, public_name, endpoint_kind, active_revision_id
    FROM gateway_route
    WHERE installation_id = ${installationId}
      AND disabled_at IS NULL AND active_revision_id IS NOT NULL`;
}

export async function readRouteRevision(
  sql: PgSql,
  revisionId: string,
): Promise<RouteRevisionRow | null> {
  const rows = await sql<RouteRevisionRow[]>`
    SELECT id, route_id, mode, timeout_policy, capture_policy, content_hash
    FROM gateway_route_revision WHERE id = ${revisionId} LIMIT 1`;
  return rows[0] ?? null;
}

export async function readTargets(sql: PgSql, routeRevisionId: string): Promise<TargetRow[]> {
  return sql<TargetRow[]>`
    SELECT id, route_revision_id, provider_credential_id, offering_id, adapter_revision,
           base_url, region, weight, priority
    FROM gateway_target WHERE route_revision_id = ${routeRevisionId}`;
}

export async function readCredential(
  sql: PgSql,
  id: string,
): Promise<CredentialRow | null> {
  // Only a LIVE credential may be embedded in the snapshot: never a revoked or invalid one
  // (review bug: this read did not filter revoked_at/status, so a revoked/rotated-out provider key
  // still shipped in the snapshot). A revoked/invalid credential returns null here → assembleSnapshot
  // drops the referencing target, so a dead key never reaches the gateway. status IN
  // ('valid','unvalidated'): 'unvalidated' is the default for a freshly-added, not-yet-probed
  // credential and is still live; 'invalid' and 'revoked' are excluded, as is any revoked_at row.
  const rows = await sql<CredentialRow[]>`
    SELECT id, provider, encrypted_secret, dek_id, base_url, allowed_hosts
    FROM provider_credential
    WHERE id = ${id}
      AND revoked_at IS NULL
      AND status IN ('valid', 'unvalidated')
    LIMIT 1`;
  return rows[0] ?? null;
}

export async function readDek(sql: PgSql, id: string): Promise<DekRow | null> {
  const rows = await sql<DekRow[]>`
    SELECT id, wrapped_dek FROM data_encryption_key WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function readOffering(sql: PgSql, id: string): Promise<OfferingRow | null> {
  const rows = await sql<OfferingRow[]>`
    SELECT id, provider, provider_model_id, adapter_revision, region, capabilities,
           active_price_revision_id
    FROM provider_model_offering WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function readPrice(sql: PgSql, id: string): Promise<PriceRow | null> {
  const rows = await sql<PriceRow[]>`
    SELECT id, fidelity,
           input_per_mtok_microusd, output_per_mtok_microusd,
           cache_read_per_mtok_microusd, cache_write_per_mtok_microusd,
           reasoning_per_mtok_microusd, audio_in_per_mtok_microusd, audio_out_per_mtok_microusd
    FROM provider_price_revision WHERE id = ${id} LIMIT 1`;
  return rows[0] ?? null;
}

export async function readEntitlements(
  sql: PgSql,
  policyRevisionId: string,
): Promise<EntitlementRow[]> {
  return sql<EntitlementRow[]>`
    SELECT policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect
    FROM model_entitlement WHERE policy_revision_id = ${policyRevisionId}`;
}

export async function readRequestConstraints(
  sql: PgSql,
  policyRevisionId: string,
): Promise<RequestConstraintRow[]> {
  return sql<RequestConstraintRow[]>`
    SELECT policy_revision_id, param, max_value, min_value, on_violation
    FROM request_constraint WHERE policy_revision_id = ${policyRevisionId}`;
}

export async function readDataHandling(
  sql: PgSql,
  policyRevisionId: string,
): Promise<DataHandlingRow[]> {
  return sql<DataHandlingRow[]>`
    SELECT policy_revision_id, capture_mode, redaction, allowed_regions
    FROM data_handling_constraint WHERE policy_revision_id = ${policyRevisionId}`;
}

/**
 * Read the budget_account rows referenced by an installation's keys (§16.3). Only the accounts a
 * key actually points at ship in the snapshot — a hard account with no key never gates anything.
 * `"window"` is quoted (reserved word). `limit_amount::text` pins the bigint as an exact decimal.
 */
export async function readBudgetAccounts(
  sql: PgSql,
  ids: string[],
): Promise<BudgetAccountRow[]> {
  if (ids.length === 0) return [];
  return sql<BudgetAccountRow[]>`
    SELECT id, enforcement, unit, "window", limit_amount::text AS limit_amount
    FROM budget_account
    WHERE id IN ${sql(ids)} AND disabled_at IS NULL`;
}

export async function readActiveRevision(
  sql: PgSql,
  installationId: string,
): Promise<ConfigRevisionRow | null> {
  const rows = await sql<ConfigRevisionRow[]>`
    SELECT id, installation_id, workspace_id, content_hash, snapshot, status
    FROM gateway_config_revision
    WHERE installation_id = ${installationId} AND status = 'active' LIMIT 1`;
  return rows[0] ?? null;
}

export async function readRevisionById(
  sql: PgSql,
  revisionId: string,
): Promise<ConfigRevisionRow | null> {
  const rows = await sql<ConfigRevisionRow[]>`
    SELECT id, installation_id, workspace_id, content_hash, snapshot, status
    FROM gateway_config_revision WHERE id = ${revisionId} LIMIT 1`;
  return rows[0] ?? null;
}
