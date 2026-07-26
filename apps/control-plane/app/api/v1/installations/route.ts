import { generateKeyPairSync } from "node:crypto";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { requireMutationIdempotencyKey, runMutationGuard } from "@/lib/mutation-guard";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import { jsonBody, ManifoldError, ok, requireString, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk, contractQuery } from "@/lib/contracts";
import { InstallationContracts } from "@manifold/contracts";
import {
  assertOnlyFields,
  decodePublicKey,
  enumField,
  INSTALLATION_EDITIONS,
  optionalObject,
  validateWorkloadIdentity,
} from "@/app/api/v1/deployments/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { id: string; name: string; edition: string; applied_config_revision: string | null; last_seen_at: string | null; disabled_at: string | null; created_at: string };
function page(req: Request) { return contractQuery(new URL(req.url).searchParams, InstallationContracts.listQuery); }

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:read");
    const { limit, cursor } = page(req);
    const rows = await withWorkspace(principal.workspaceId, async (sql) => sql<Row[]>`
      SELECT id, name, edition, applied_config_revision, last_seen_at, disabled_at, created_at
      FROM gateway_installation
      WHERE workspace_id = ${principal.workspaceId} AND (${cursor ?? null}::text IS NULL OR id < ${cursor ?? null})
      ORDER BY id DESC LIMIT ${limit + 1}`);
    const data = rows.slice(0, limit).map((r) => ({ id: r.id, name: r.name, edition: r.edition, appliedConfigRevision: r.applied_config_revision, lastSeenAt: r.last_seen_at, status: r.disabled_at ? "disabled" : "active", createdAt: r.created_at }));
    return contractOk(InstallationContracts.listResponse, { data, nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null }, requestId);
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "deployments:write");
    requireMutationIdempotencyKey(req);
    const body = await contractBody(req.clone(), InstallationContracts.create);
    const rawBody = body as Record<string, unknown>;
    const name = requireString(rawBody, "name").trim();
    if (!name) {
      // requireString rejects an empty input; this also rejects whitespace-only names.
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "name must contain non-whitespace characters",
        reasonCodes: [],
        details: { issues: [{ path: "name", message: "non-whitespace string required" }] },
      });
    }
    const edition = enumField(rawBody, "edition", INSTALLATION_EDITIONS, "vercel");
    const workloadIdentity = validateWorkloadIdentity(optionalObject(rawBody, "workloadIdentity"));
    if (body.publicKey !== undefined && workloadIdentity) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "provide either publicKey or workloadIdentity, not both",
        reasonCodes: [],
        details: { issues: [{ path: "workloadIdentity", message: "mutually exclusive with publicKey" }] },
      });
    }

    let publicKey: Buffer | null;
    let generatedPrivateKey: string | null = null;
    let generatedPublicKey: string | null = null;
    if (body.publicKey !== undefined) {
      publicKey = decodePublicKey(body.publicKey);
    } else if (workloadIdentity) {
      publicKey = null;
    } else {
      const pair = generateKeyPairSync("ed25519");
      publicKey = pair.publicKey.export({ format: "der", type: "spki" });
      generatedPublicKey = publicKey.toString("base64");
      generatedPrivateKey = pair.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64");
    }

    const installationId = genId("inst");
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 20, windowMs: 60_000 }, handler: async (sql) => {
      await sql`
        INSERT INTO gateway_installation
          (id, workspace_id, name, public_key, workload_identity, edition)
        VALUES
          (${installationId}, ${principal.workspaceId}, ${name},
           ${publicKey},
           ${workloadIdentity ? sql.json(workloadIdentity as never) : null}, ${edition})`;
      await audit(sql, principal, {
        action: "installation.register",
        targetKind: "gateway_installation",
        targetId: installationId,
        requestId,
        detail: { name, edition, identityKind: workloadIdentity ? "workload_identity" : "public_key" },
      });
      return contractOk(InstallationContracts.createResponse,
      {
        id: installationId,
        name,
        edition,
        status: "active",
        ...(generatedPrivateKey
          ? {
              installationIdentityPublicKey: generatedPublicKey,
              installationIdentityPrivateKey: generatedPrivateKey,
              privateKeyShownOnce: true,
            }
          : {}),
      },
      requestId,
      201,
      );
    }});
  });
}
