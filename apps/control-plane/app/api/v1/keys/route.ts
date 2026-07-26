// GET/POST /api/v1/keys — virtual-key inventory and minting (SPEC §8.5, §10.3).
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { drainKeyPublication, enqueueKeyPublication } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import { wrapInEnvelope, jsonBody, ok, requireString, ManifoldError } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { KeysApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RateLimit = { rpm?: number; tpm?: number; burst?: number };
type KeyInput = {
  profileId: string; scopes: string[]; allowedAppIds: string[]; defaultAppId: string | null;
  defaultActionId: string | null; teamId: string | null; costCenterId: string | null;
  budgetAccountId: string | null; rateLimit: RateLimit | null; expiresAt: string | null;
};
const MINT_FIELDS = new Set(["profileId", "scopes", "allowedAppIds", "defaultAppId", "defaultActionId", "teamId", "costCenterId", "budgetAccountId", "rateLimit", "expiresAt"]);

interface KeyRow {
  id: string; display_prefix: string; profile_id: string; profile_mode: string;
  scopes: unknown; allowed_app_ids: unknown; default_app_id: string | null;
  default_action_id: string | null; team_id: string | null; cost_center_id: string | null;
  budget_account_id: string | null; rate_limit: unknown; expires_at: string | null;
  revoked_at: string | null; last_used_at: string | null; successor_key_id: string | null;
  successor_expires_at: string | null; successor_revoked_at: string | null; created_at: string;
}

function validation(field: string, message: string): never {
  throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path: field, message }] } });
}
function optionalId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) validation(field, `${field} must be a non-empty string or null`);
  return value.trim();
}
function stringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) validation(field, `${field} must be an array of non-empty strings`);
  const values = (value as string[]).map((item) => item.trim());
  if (new Set(values).size !== values.length) validation(field, `${field} must not contain duplicates`);
  return values;
}
function rateLimit(body: Record<string, unknown>): RateLimit | null {
  const value = body.rateLimit;
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) validation("rateLimit", "rateLimit must be an object or null");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (!keys.length || keys.some((key) => !["rpm", "tpm", "burst"].includes(key))) validation("rateLimit", "rateLimit permits only rpm, tpm, and burst");
  for (const key of keys) if (!Number.isSafeInteger(candidate[key]) || (candidate[key] as number) <= 0) validation(`rateLimit.${key}`, "rate limit values must be positive safe integers");
  return candidate as RateLimit;
}
function expiry(body: Record<string, unknown>): string | null {
  const value = body.expiresAt;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) validation("expiresAt", "expiresAt must be a future ISO-8601 timestamp or null");
  return new Date(value).toISOString();
}
function input(body: Record<string, unknown>): KeyInput {
  if (Object.keys(body).some((field) => !MINT_FIELDS.has(field))) validation("body", "POST accepts only profileId, scopes, allowedAppIds, defaultAppId, defaultActionId, teamId, costCenterId, budgetAccountId, rateLimit, and expiresAt");
  return { profileId: requireString(body, "profileId"), scopes: stringArray(body, "scopes"), allowedAppIds: stringArray(body, "allowedAppIds"), defaultAppId: optionalId(body, "defaultAppId"), defaultActionId: optionalId(body, "defaultActionId"), teamId: optionalId(body, "teamId"), costCenterId: optionalId(body, "costCenterId"), budgetAccountId: optionalId(body, "budgetAccountId"), rateLimit: rateLimit(body), expiresAt: expiry(body) };
}

function status(row: KeyRow) {
  const now = Date.now();
  const graceExpiresAt = row.successor_key_id ? row.expires_at : null;
  return {
    revoked: row.revoked_at !== null,
    expired: !!row.expires_at && Date.parse(row.expires_at) <= now,
    successorKeyId: row.successor_key_id,
    successorActive: !!row.successor_key_id && !row.successor_revoked_at && (!row.successor_expires_at || Date.parse(row.successor_expires_at) > now),
    graceExpiresAt,
    rotating: !!row.successor_key_id && !!row.expires_at && Date.parse(row.expires_at) > now && !row.revoked_at,
  };
}
function serialize(row: KeyRow) {
  return { id: row.id, displayPrefix: row.display_prefix, profileId: row.profile_id, profileMode: row.profile_mode, scopes: row.scopes, allowedAppIds: Array.isArray(row.allowed_app_ids) ? row.allowed_app_ids : [], defaultAppId: row.default_app_id, defaultActionId: row.default_action_id, attribution: { teamId: row.team_id, costCenterId: row.cost_center_id, budgetAccountId: row.budget_account_id }, rateLimit: row.rate_limit, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, createdAt: row.created_at, ...status(row) };
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) => sql<KeyRow[]>`
      SELECT k.id, k.display_prefix, k.profile_id, p.mode AS profile_mode, k.scopes, k.allowed_app_ids,
             k.default_app_id, k.default_action_id, k.team_id, k.cost_center_id, k.budget_account_id,
             k.rate_limit, k.expires_at, k.revoked_at, k.last_used_at, k.successor_key_id,
             successor.expires_at AS successor_expires_at, successor.revoked_at AS successor_revoked_at, k.created_at
      FROM virtual_key k
      JOIN gateway_ingress_profile p ON p.id = k.profile_id AND p.workspace_id = ${principal.workspaceId}
      LEFT JOIN virtual_key successor ON successor.id = k.successor_key_id AND successor.workspace_id = ${principal.workspaceId}
      WHERE k.workspace_id = ${principal.workspaceId} ORDER BY k.created_at DESC`);
    return contractOk(KeysApi.listResponse, { data: rows.map(serialize), nextCursor: null }, requestId);
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:write");
    let queuedInstallationId: string | null = null;
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, sensitiveReplay: true, afterCommit: async () => { if (queuedInstallationId) await drainKeyPublication(principal.workspaceId, queuedInstallationId); }, handler: async (sql) => {
    const value = input(await contractBody(req, KeysApi.mintRequest));
    const secret = generateSecret("sk-mf-");
    const keyId = genId("key");
    const created = await (async () => {
      const profile = (await sql<{ id: string; installation_id: string; mode: string }[]>`SELECT id, installation_id, mode FROM gateway_ingress_profile WHERE id = ${value.profileId} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!profile) return { error: "profile" as const };
      if (profile.mode === "public_app" && (value.teamId || value.costCenterId || value.budgetAccountId)) return { error: "escalation" as const };
      const check = async (table: "app" | "team" | "cost_center" | "budget_account", id: string | null) => !id || !!(await sql<{ id: string }[]>`SELECT id FROM ${sql(table)} WHERE id = ${id} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!await check("app", value.defaultAppId)) return { error: "defaultAppId" as const };
      if (!await check("team", value.teamId)) return { error: "teamId" as const };
      if (!await check("cost_center", value.costCenterId)) return { error: "costCenterId" as const };
      if (!await check("budget_account", value.budgetAccountId)) return { error: "budgetAccountId" as const };
      for (const appId of value.allowedAppIds) if (!await check("app", appId)) return { error: "allowedAppIds" as const };
      if (value.defaultActionId) {
        const action = (await sql<{ id: string; app_id: string }[]>`SELECT id, app_id FROM action WHERE id = ${value.defaultActionId} AND workspace_id = ${principal.workspaceId} AND archived_at IS NULL LIMIT 1`)[0];
        if (!action) return { error: "defaultActionId" as const };
        if (value.defaultAppId && action.app_id !== value.defaultAppId) return { error: "actionAppMismatch" as const };
      }
      await sql`INSERT INTO virtual_key (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, default_app_id, default_action_id, team_id, cost_center_id, budget_account_id, rate_limit, expires_at) VALUES (${keyId}, ${principal.workspaceId}, ${value.profileId}, ${secret.displayPrefix}, ${secret.keyedHash}, ${sql.json(value.scopes as never)}, ${sql.json(value.allowedAppIds as never)}, ${value.defaultAppId}, ${value.defaultActionId}, ${value.teamId}, ${value.costCenterId}, ${value.budgetAccountId}, ${value.rateLimit ? sql.json(value.rateLimit as never) : null}, ${value.expiresAt})`;
      await audit(sql, principal, { action: "key.mint", targetKind: "virtual_key", targetId: keyId, requestId, detail: value });
      return { keyId, installationId: profile.installation_id };
    })();
    if ("error" in created) {
      if (created.error === "profile") throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "ingress profile not found", reasonCodes: [] });
      if (created.error === "escalation") throw new ManifoldError({ status: 422, code: "VALIDATION", message: "public_app keys cannot carry enterprise attribution or budgets", reasonCodes: ["POLICY_PROFILE_ESCALATION"] });
      throw new ManifoldError({ status: 422, code: "VALIDATION", message: `${created.error} does not belong to this workspace`, reasonCodes: [], details: { issues: [{ path: created.error, message: "unknown, cross-tenant, or incompatible reference" }] } });
    }
    await enqueueKeyPublication(sql, principal.workspaceId, created.installationId);
    queuedInstallationId = created.installationId;
    return contractOk(KeysApi.mintResponse, { keyId, displayPrefix: secret.displayPrefix, plaintext: secret.plaintext, published: false }, requestId, 201);
    }});
  });
}
