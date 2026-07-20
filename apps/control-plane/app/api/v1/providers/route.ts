// GET/POST /api/v1/providers (SPEC §10.3).
//   GET  providers:read  — list this workspace's non-revoked provider credentials.
//   POST providers:write — create a credential. The submitted secret is envelope-encrypted
//     (§14.3, ADR-0016/0022): a fresh 256-bit DEK seals it with AES-256-GCM, and the DEK is
//     wrapped by the platform KEK (MANIFOLD_DATA_KEK). We store the REAL ciphertext + a
//     data_encryption_key row holding the wrapped DEK. The gateway later unwraps the DEK with the
//     same KEK and opens the ciphertext in-proc (apps/gateway decryptTargetSecret) — plaintext is
//     never at rest and the KEK never rides the snapshot.
import { randomBytes } from "node:crypto";
import { sealAesGcm, wrapDek, unpackBase64, utf8 } from "@manifold/crypto";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import {
  handle,
  jsonBody,
  ok,
  requireString,
  optionalString,
  optionalStringArray,
} from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dev-only KEK (all-zero 32 bytes) — matches the gateway's DEV_KEK for local runs w/o env. */
const DEV_KEK = new Uint8Array(32);

/** Resolve the KEK from env (base64 of exactly 32 bytes) or fall back to the dev KEK (§14.3). */
function kekFromEnv(): Uint8Array {
  const b64 = process.env.MANIFOLD_DATA_KEK;
  if (!b64) return DEV_KEK;
  const k = unpackBase64(b64);
  if (k.length !== 32) {
    throw new Error("MANIFOLD_DATA_KEK must be base64 of exactly 32 bytes");
  }
  return k;
}

interface ProviderRow {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  status: string;
  last_validated_at: string | null;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "providers:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<ProviderRow[]>`
        SELECT id, provider, label, base_url, status, last_validated_at, created_at
        FROM provider_credential
        WHERE workspace_id = ${principal.workspaceId} AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    );
    return ok(
      {
        data: rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          label: r.label,
          baseUrl: r.base_url,
          status: r.status,
          lastValidatedAt: r.last_validated_at,
          createdAt: r.created_at,
        })),
        next_cursor: null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    const body = await jsonBody(req);
    const provider = requireString(body, "provider");
    const label = requireString(body, "label");
    const secret = requireString(body, "secret");
    const baseUrl = optionalString(body, "baseUrl");
    const allowedHosts = optionalStringArray(body, "allowedHosts");

    // Envelope-encrypt the secret (§14.3): fresh DEK seals it (AES-256-GCM), KEK wraps the DEK.
    const kek = kekFromEnv();
    const kekId = process.env.MANIFOLD_DATA_KEK_ID ?? "kek_dev";
    const dek = new Uint8Array(randomBytes(32));
    const wrappedDek = Buffer.from(wrapDek(kek, dek));
    const ciphertext = Buffer.from(sealAesGcm(dek, utf8(secret)));

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const dekId = genId("dek");
      await sql`
        INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status)
        VALUES (${dekId}, ${principal.workspaceId},
                ${wrappedDek}, ${kekId}, 'active')`;

      const credId = genId("pc");
      await sql`
        INSERT INTO provider_credential
          (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url,
           allowed_hosts, status)
        VALUES
          (${credId}, ${principal.workspaceId}, ${provider}, ${label},
           ${ciphertext}, ${dekId}, ${baseUrl},
           ${sql.json(allowedHosts as never)}, 'unvalidated')`;

      await audit(sql, principal, {
        action: "provider.create",
        targetKind: "provider_credential",
        targetId: credId,
        requestId,
        detail: { provider, label },
      });
      return { credId };
    });

    return ok(
      { id: result.credId, provider, label, status: "unvalidated" },
      requestId,
      201,
    );
  });
}
