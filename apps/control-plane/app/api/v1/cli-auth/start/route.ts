import { rawSql, withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { CliAuthorizationStartRequest, CliAuthorizationStartResponse } from "@manifold/contracts";
import { allowedClient, deviceHash, newDeviceCode, newUserCode, requestedScopes, verificationOrigin } from "@/lib/settings/cli-authorization";
import { genId } from "@/lib/ids";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const INTERVAL_SECONDS = 5; const TTL_MINUTES = 10;

/** POST /api/v1/cli-auth/start — pre-auth, internal RFC 8628-shaped device authorization. */
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => {
  const body = await contractBody(req, CliAuthorizationStartRequest);
  const client = allowedClient(body.clientId); const scopes = requestedScopes(body.scopes); const origin = verificationOrigin();
  const workspace = (await rawSql()<{ id: string }[]>`SELECT id FROM auth_lookup_workspace_slug(${body.workspaceSlug})`)[0];
  // Keep the response indistinguishable from an invalid client/workspace binding to limit tenant discovery.
  if (!workspace) throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "device authorization could not be started", reasonCodes: ["CLI_AUTH_BINDING_INVALID"] });
  const deviceCode = newDeviceCode();
  let userCode = newUserCode();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();
  await withWorkspace(workspace.id, async (sql) => {
    // Rate-limit pre-auth starts by allowlisted client and workspace. The pending-row count is
    // bounded and cannot be bypassed by arbitrary caller-provided identities.
    const recent = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM cli_authorization
      WHERE workspace_id = ${workspace.id} AND client_id = ${client.id} AND created_at > now() - interval '1 minute'`;
    if ((recent[0]?.count ?? 0) >= 10) throw new ManifoldError({ status: 429, code: "RATE_LIMITED", message: "device authorization start rate limit exceeded", reasonCodes: ["CLI_AUTH_START_RATE_LIMIT"], retryable: true });
    // Very unlikely global user-code collision: regenerate a bounded number of times.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const inserted = await sql<{ id: string }[]>`INSERT INTO cli_authorization
        (id, workspace_id, device_code_hash, user_code, status, scopes, client_id, client_name,
         verification_origin, interval_seconds, poll_not_before, expires_at, created_at)
        VALUES (${genId("clia")}, ${workspace.id}, ${deviceHash(deviceCode)}, ${userCode}, 'pending',
          ${sql.json(scopes as never)}, ${client.id}, ${client.name}, ${origin}, ${INTERVAL_SECONDS}, now(), ${expiresAt}, now())
        ON CONFLICT (user_code) DO NOTHING RETURNING id`;
      if (inserted[0]) return;
      userCode = newUserCode();
    }
    throw new Error("could not allocate unique CLI user code");
  });
  const verificationUri = `${origin}/settings?cli_auth=${encodeURIComponent(userCode)}`;
  return contractOk(CliAuthorizationStartResponse, { deviceCode, userCode, verificationUri, interval: INTERVAL_SECONDS, expiresIn: TTL_MINUTES * 60, client: client.name }, requestId, 201);
}); }
