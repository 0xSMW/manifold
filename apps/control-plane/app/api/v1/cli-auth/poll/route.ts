import { generateSecret, keyedHash } from "@/lib/crypto";
import { rawSql, withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { CliAuthorizationPollRequest, CliAuthorizationPollResponse } from "@manifold/contracts";
import { genId } from "@/lib/ids";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
type Lookup = { id: string; workspace_id: string; status: string; scopes: unknown; client_id: string; client_name: string; verification_origin: string; interval_seconds: number; expires_at: string; poll_not_before: string };
function state(status: "authorization_pending" | "slow_down" | "denied" | "expired", requestId: string, interval?: number) { return contractOk(CliAuthorizationPollResponse, { status, ...(interval ? { interval } : {}) }, requestId); }

/** POST /api/v1/cli-auth/poll — device-code exchange; token plaintext appears only on this response. */
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => {
  const { deviceCode } = await contractBody(req, CliAuthorizationPollRequest);
  const lookup = (await rawSql()<Lookup[]>`SELECT * FROM auth_lookup_cli_authorization(${keyedHash(deviceCode)})`)[0];
  // Exact codes are high entropy; keep an unknown code's response equivalent to an expired grant.
  if (!lookup) return state("expired", requestId);
  return withWorkspace(lookup.workspace_id, async (sql) => {
    const rows = await sql<Lookup[]>`SELECT id, workspace_id, status, scopes, client_id, client_name, verification_origin,
      interval_seconds, expires_at, poll_not_before FROM cli_authorization
      WHERE id = ${lookup.id} AND workspace_id = ${lookup.workspace_id} AND device_code_hash = ${keyedHash(deviceCode)} FOR UPDATE`;
    const row = rows[0]; if (!row) return state("expired", requestId);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await sql`UPDATE cli_authorization SET status = 'expired' WHERE id = ${row.id} AND workspace_id = ${row.workspace_id} AND status <> 'issued'`;
      return state("expired", requestId);
    }
    if (row.status === "issued" || row.status === "expired") return state("expired", requestId);
    if (row.status === "denied") return state("denied", requestId);
    if (new Date(row.poll_not_before).getTime() > Date.now()) {
      const interval = Math.min(30, row.interval_seconds + 5);
      await sql`UPDATE cli_authorization SET interval_seconds = ${interval}, last_polled_at = now(),
        poll_not_before = now() + (${interval} * interval '1 second') WHERE id = ${row.id} AND workspace_id = ${row.workspace_id}`;
      return state("slow_down", requestId, interval);
    }
    if (row.status === "pending") {
      await sql`UPDATE cli_authorization SET last_polled_at = now(), poll_not_before = now() + (${row.interval_seconds} * interval '1 second') WHERE id = ${row.id} AND workspace_id = ${row.workspace_id}`;
      return state("authorization_pending", requestId, row.interval_seconds);
    }
    const approved = await sql<{ approved_by: string | null; user_id: string | null; disabled_at: string | null; accepted_at: string | null }[]>`SELECT c.approved_by, m.user_id, m.disabled_at, m.accepted_at FROM cli_authorization c LEFT JOIN member m ON m.id = c.approved_by AND m.workspace_id = c.workspace_id WHERE c.id = ${row.id} AND c.workspace_id = ${row.workspace_id} FOR UPDATE`;
    if (!approved[0]?.approved_by || !approved[0].user_id || approved[0].disabled_at || !approved[0].accepted_at) return state("expired", requestId);
    const verified = await sql<{ session_version: number }[]>`SELECT * FROM auth_lookup_verified_member(${row.workspace_id}, ${approved[0].approved_by})`;
    if (!verified[0]) return state("expired", requestId);
    const token = generateSecret("mf_tok_"); const tokenId = genId("tok");
    await sql`INSERT INTO api_token (id, workspace_id, display_prefix, keyed_hash, scopes, created_by, kind, user_id, created_at)
      VALUES (${tokenId}, ${row.workspace_id}, ${token.displayPrefix}, ${token.keyedHash}, ${sql.json(row.scopes as never)}, ${approved[0].approved_by}, 'personal', ${approved[0].user_id}, now())`;
    const issued = await sql<{ id: string }[]>`UPDATE cli_authorization SET status = 'issued', issued_token_id = ${tokenId}, last_polled_at = now()
      WHERE id = ${row.id} AND workspace_id = ${row.workspace_id} AND status = 'approved' AND issued_token_id IS NULL RETURNING id`;
    if (!issued[0]) throw new ManifoldError({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "device authorization was already exchanged", reasonCodes: [] });
    await sql`INSERT INTO audit_event (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id, detail, created_at)
      VALUES (${genId("aud")}, ${row.workspace_id}, 'cli', ${row.id}, 'cli.token.issue', 'api_token', ${tokenId},
        ${sql.json({ clientId: row.client_id, authorizationId: row.id } as never)}, now())`;
    return contractOk(CliAuthorizationPollResponse, { status: "approved", accessToken: token.plaintext, tokenType: "Bearer", scopes: Array.isArray(row.scopes) ? row.scopes.filter((scope): scope is string => typeof scope === "string") : [] }, requestId);
  });
}); }
