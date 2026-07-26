// GET/PATCH /api/v1/keys/{id} — detail and mutable key policy fields.
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { publishKeysOnly } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { wrapInEnvelope, jsonBody, ok, ManifoldError } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { KeysApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { id: string; profile_id: string; profile_mode: string; installation_id: string; display_prefix: string; scopes: unknown; allowed_app_ids: unknown; default_app_id: string | null; default_action_id: string | null; team_id: string | null; cost_center_id: string | null; budget_account_id: string | null; rate_limit: unknown; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; successor_key_id: string | null; successor_expires_at: string | null; successor_revoked_at: string | null; created_at: string };
const fields = new Set(["scopes", "allowedAppIds", "defaultAppId", "defaultActionId", "teamId", "costCenterId", "budgetAccountId", "rateLimit", "expiresAt"]);

function fail(path: string, message: string): never { throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path, message }] } }); }
function list(value: unknown, field: string, fallback: unknown): string[] {
  if (value === undefined) return Array.isArray(fallback) ? fallback.map(String) : [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string" || !x.trim())) fail(field, `${field} must be an array of non-empty strings`);
  const items = (value as string[]).map((x) => x.trim()); if (new Set(items).size !== items.length) fail(field, `${field} must not contain duplicates`); return items;
}
function id(value: unknown, field: string, fallback: string | null): string | null { if (value === undefined) return fallback; if (value === null) return null; if (typeof value !== "string" || !value.trim()) fail(field, `${field} must be a non-empty string or null`); return value.trim(); }
function rate(value: unknown, fallback: unknown): Record<string, number> | null {
  if (value === undefined) return fallback as Record<string, number> | null;
  if (value === null) return null; if (typeof value !== "object" || Array.isArray(value)) fail("rateLimit", "rateLimit must be an object or null");
  const record = value as Record<string, unknown>; const keys = Object.keys(record);
  if (!keys.length || keys.some((k) => !["rpm", "tpm", "burst"].includes(k))) fail("rateLimit", "rateLimit permits only rpm, tpm, and burst");
  for (const key of keys) if (!Number.isSafeInteger(record[key]) || (record[key] as number) <= 0) fail(`rateLimit.${key}`, "rate limit values must be positive safe integers");
  return record as Record<string, number>;
}
function expiry(value: unknown, fallback: string | null): string | null { if (value === undefined) return fallback; if (value === null) return null; if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) fail("expiresAt", "expiresAt must be a future ISO-8601 timestamp or null"); return new Date(value).toISOString(); }
function view(row: Row) { const now = Date.now(); const activeGrace = !!row.successor_key_id && !!row.expires_at && Date.parse(row.expires_at) > now; return { id: row.id, displayPrefix: row.display_prefix, profileId: row.profile_id, profileMode: row.profile_mode, scopes: row.scopes, allowedAppIds: Array.isArray(row.allowed_app_ids) ? row.allowed_app_ids : [], defaultAppId: row.default_app_id, defaultActionId: row.default_action_id, attribution: { teamId: row.team_id, costCenterId: row.cost_center_id, budgetAccountId: row.budget_account_id }, rateLimit: row.rate_limit, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, createdAt: row.created_at, revoked: !!row.revoked_at, expired: !!row.expires_at && Date.parse(row.expires_at) <= now, successorKeyId: row.successor_key_id, successorActive: !!row.successor_key_id && !row.successor_revoked_at && (!row.successor_expires_at || Date.parse(row.successor_expires_at) > now), graceExpiresAt: row.successor_key_id ? row.expires_at : null, rotating: activeGrace && !row.revoked_at }; }
async function fetch(sql: any, workspaceId: string, keyId: string): Promise<Row | null> { return (await sql<Row[]>`SELECT k.id, k.profile_id, p.mode AS profile_mode, p.installation_id, k.display_prefix, k.scopes, k.allowed_app_ids, k.default_app_id, k.default_action_id, k.team_id, k.cost_center_id, k.budget_account_id, k.rate_limit, k.expires_at, k.revoked_at, k.last_used_at, k.successor_key_id, successor.expires_at AS successor_expires_at, successor.revoked_at AS successor_revoked_at, k.created_at FROM virtual_key k JOIN gateway_ingress_profile p ON p.id = k.profile_id AND p.workspace_id = ${workspaceId} LEFT JOIN virtual_key successor ON successor.id = k.successor_key_id AND successor.workspace_id = ${workspaceId} WHERE k.id = ${keyId} AND k.workspace_id = ${workspaceId} LIMIT 1`)[0] ?? null; }

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => { const principal = await authorize(req, "keys:read"); const { id: keyId } = await ctx.params; const row = await withWorkspace(principal.workspaceId, (sql) => fetch(sql, principal.workspaceId, keyId)); if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "virtual key not found", reasonCodes: [] }); return contractOk(KeysApi.detailResponse, view(row), requestId); });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:write"); const { id: keyId } = await ctx.params; return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 20, windowMs: 60_000 }, handler: async (sql) => { const body = await contractBody(req, KeysApi.patchRequest);
    if (!Object.keys(body).length || Object.keys(body).some((key) => !fields.has(key))) fail("body", "PATCH accepts only scopes, allowedAppIds, defaultAppId, defaultActionId, teamId, costCenterId, budgetAccountId, rateLimit, and expiresAt");
    const result = await (async () => {
      const row = await fetch(sql, principal.workspaceId, keyId); if (!row) return { error: "notFound" as const };
      if (row.revoked_at || row.successor_key_id || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return { error: "inactive" as const };
      const scopes = list(body.scopes, "scopes", row.scopes); const allowedAppIds = list(body.allowedAppIds, "allowedAppIds", row.allowed_app_ids); const defaultAppId = id(body.defaultAppId, "defaultAppId", row.default_app_id); const defaultActionId = id(body.defaultActionId, "defaultActionId", row.default_action_id); const teamId = id(body.teamId, "teamId", row.team_id); const costCenterId = id(body.costCenterId, "costCenterId", row.cost_center_id); const budgetAccountId = id(body.budgetAccountId, "budgetAccountId", row.budget_account_id); const rateLimit = rate(body.rateLimit, row.rate_limit); const expiresAt = expiry(body.expiresAt, row.expires_at);
      if (row.profile_mode === "public_app" && (teamId || costCenterId || budgetAccountId)) return { error: "escalation" as const };
      const exists = async (table: "app" | "team" | "cost_center" | "budget_account", value: string | null) => !value || !!(await sql<{ id: string }[]>`SELECT id FROM ${sql(table)} WHERE id = ${value} AND workspace_id = ${principal.workspaceId} LIMIT 1`)[0];
      if (!await exists("app", defaultAppId)) return { error: "defaultAppId" as const }; if (!await exists("team", teamId)) return { error: "teamId" as const }; if (!await exists("cost_center", costCenterId)) return { error: "costCenterId" as const }; if (!await exists("budget_account", budgetAccountId)) return { error: "budgetAccountId" as const };
      for (const appId of allowedAppIds) if (!await exists("app", appId)) return { error: "allowedAppIds" as const };
      if (defaultActionId) { const action = (await sql<{ app_id: string }[]>`SELECT app_id FROM action WHERE id = ${defaultActionId} AND workspace_id = ${principal.workspaceId} AND archived_at IS NULL LIMIT 1`)[0]; if (!action) return { error: "defaultActionId" as const }; if (defaultAppId && action.app_id !== defaultAppId) return { error: "actionAppMismatch" as const }; }
      await sql`UPDATE virtual_key SET scopes = ${sql.json(scopes as never)}, allowed_app_ids = ${sql.json(allowedAppIds as never)}, default_app_id = ${defaultAppId}, default_action_id = ${defaultActionId}, team_id = ${teamId}, cost_center_id = ${costCenterId}, budget_account_id = ${budgetAccountId}, rate_limit = ${rateLimit ? sql.json(rateLimit as never) : null}, expires_at = ${expiresAt} WHERE id = ${keyId} AND workspace_id = ${principal.workspaceId}`;
      await audit(sql, principal, { action: "key.update", targetKind: "virtual_key", targetId: keyId, requestId, detail: { scopes, allowedAppIds, defaultAppId, defaultActionId, teamId, costCenterId, budgetAccountId, rateLimit, expiresAt } });
      return { row: await fetch(sql, principal.workspaceId, keyId), installationId: row.installation_id };
    })();
    if ("error" in result) { if (result.error === "notFound") throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "virtual key not found", reasonCodes: [] }); if (result.error === "inactive") throw new ManifoldError({ status: 422, code: "VALIDATION", message: "inactive virtual keys cannot be updated", reasonCodes: [] }); if (result.error === "escalation") throw new ManifoldError({ status: 422, code: "VALIDATION", message: "public_app keys cannot carry enterprise attribution or budgets", reasonCodes: ["POLICY_PROFILE_ESCALATION"] }); throw new ManifoldError({ status: 422, code: "VALIDATION", message: `${result.error} does not belong to this workspace`, reasonCodes: [] }); }
    const publishResult = await publishKeysOnly(principal.workspaceId, result.installationId); return contractOk(KeysApi.patchResponse, { ...view(result.row!), published: publishResult !== null && publishResult.outcome === "accepted" }, requestId); }});
  });
}
