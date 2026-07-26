// POST /api/v1/keys/{id}/rotate — mint a copy-once successor and bound predecessor grace.
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { drainKeyPublication, enqueueKeyPublication } from "@/lib/snapshot";
import { audit } from "@/lib/audit";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import { wrapInEnvelope, jsonBody, ok, ManifoldError } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { KeysApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_GRACE_SECONDS = 15 * 60;
const MIN_GRACE_SECONDS = 60;
const MAX_GRACE_SECONDS = 24 * 60 * 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "keys:write"); const { id } = await ctx.params;
    let queuedInstallationId: string | null = null;
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 5, windowMs: 60_000 }, sensitiveReplay: true, afterCommit: async () => { if (queuedInstallationId) await drainKeyPublication(principal.workspaceId, queuedInstallationId); }, handler: async (sql) => {
    const body = await contractBody(req, KeysApi.rotateRequest);
    if (Object.keys(body).some((key) => key !== "graceSeconds")) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "rotate accepts only graceSeconds", reasonCodes: [] });
    const supplied = body.graceSeconds;
    const graceSeconds = supplied === undefined ? DEFAULT_GRACE_SECONDS : supplied;
    if (!Number.isSafeInteger(graceSeconds) || (graceSeconds as number) < MIN_GRACE_SECONDS || (graceSeconds as number) > MAX_GRACE_SECONDS) throw new ManifoldError({ status: 422, code: "VALIDATION", message: `graceSeconds must be an integer between ${MIN_GRACE_SECONDS} and ${MAX_GRACE_SECONDS}`, reasonCodes: [], details: { issues: [{ path: "graceSeconds", message: "out of range" }] } });
    const secret = generateSecret("sk-mf-"); const successorId = genId("key");
    const rotated = await (async () => {
      const predecessor = (await sql<{ id: string; profile_id: string; installation_id: string; scopes: unknown; allowed_app_ids: unknown; default_app_id: string | null; default_action_id: string | null; team_id: string | null; cost_center_id: string | null; budget_account_id: string | null; rate_limit: unknown; expires_at: string | null; revoked_at: string | null; successor_key_id: string | null }[]>`SELECT k.id, k.profile_id, p.installation_id, k.scopes, k.allowed_app_ids, k.default_app_id, k.default_action_id, k.team_id, k.cost_center_id, k.budget_account_id, k.rate_limit, k.expires_at, k.revoked_at, k.successor_key_id FROM virtual_key k JOIN gateway_ingress_profile p ON p.id = k.profile_id AND p.workspace_id = ${principal.workspaceId} WHERE k.id = ${id} AND k.workspace_id = ${principal.workspaceId} LIMIT 1 FOR UPDATE OF k`)[0];
      if (!predecessor) return { error: "notFound" as const };
      if (predecessor.revoked_at || predecessor.successor_key_id || (predecessor.expires_at && Date.parse(predecessor.expires_at) <= Date.now())) return { error: "inactive" as const };
      const requestedGraceEnds = new Date(Date.now() + (graceSeconds as number) * 1000);
      const graceEnds = predecessor.expires_at && Date.parse(predecessor.expires_at) < requestedGraceEnds.getTime() ? new Date(predecessor.expires_at) : requestedGraceEnds;
      await sql`INSERT INTO virtual_key (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, default_app_id, default_action_id, team_id, cost_center_id, budget_account_id, rate_limit, expires_at) VALUES (${successorId}, ${principal.workspaceId}, ${predecessor.profile_id}, ${secret.displayPrefix}, ${secret.keyedHash}, ${sql.json(predecessor.scopes as never)}, ${sql.json(predecessor.allowed_app_ids as never)}, ${predecessor.default_app_id}, ${predecessor.default_action_id}, ${predecessor.team_id}, ${predecessor.cost_center_id}, ${predecessor.budget_account_id}, ${predecessor.rate_limit ? sql.json(predecessor.rate_limit as never) : null}, NULL)`;
      await sql`UPDATE virtual_key SET successor_key_id = ${successorId}, expires_at = ${graceEnds.toISOString()} WHERE id = ${id} AND workspace_id = ${principal.workspaceId} AND successor_key_id IS NULL`;
      await audit(sql, principal, { action: "key.rotate", targetKind: "virtual_key", targetId: id, requestId, detail: { successorKeyId: successorId, graceSeconds, graceExpiresAt: graceEnds.toISOString(), graceSemantics: "predecessor expires_at is the rotation grace cutoff" } });
      return { installationId: predecessor.installation_id, graceExpiresAt: graceEnds.toISOString() };
    })();
    if ("error" in rotated) throw new ManifoldError({ status: rotated.error === "notFound" ? 404 : 422, code: rotated.error === "notFound" ? "NOT_FOUND" : "VALIDATION", message: rotated.error === "notFound" ? "virtual key not found" : "KEY_NOT_ACTIVE: key is revoked, expired, or already rotating", reasonCodes: [] });
    await enqueueKeyPublication(sql, principal.workspaceId, rotated.installationId);
    queuedInstallationId = rotated.installationId;
    return contractOk(KeysApi.rotateResponse, { predecessorKeyId: id, successorKeyId: successorId, displayPrefix: secret.displayPrefix, plaintext: secret.plaintext, graceExpiresAt: rotated.graceExpiresAt, graceSemantics: "The predecessor remains valid until graceExpiresAt, stored as its expiresAt; the successor is active immediately.", published: false }, requestId, 201);
    }});
  });
}
