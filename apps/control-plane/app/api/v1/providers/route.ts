// GET/POST /api/v1/providers (SPEC §10.3).
//   GET  providers:read  — list this workspace's non-revoked provider credentials.
//   POST providers:write — create a credential. Envelope encryption of the secret is OUT OF
//     SCOPE here (§14.3): we store a PLACEHOLDER ciphertext + a data_encryption_key row so
//     routes/targets can reference a credential and the snapshot builder can carry ciphertext.
//     TODO(§14.3): replace placeholder with AES-256-GCM envelope encryption (DEK wrapped by KEK).
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
    const baseUrl = optionalString(body, "baseUrl");
    const allowedHosts = optionalStringArray(body, "allowedHosts");

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const dekId = genId("dek");
      // Placeholder wrapped DEK (§14.3 TODO: wrap a real AES-256-GCM DEK with the KEK).
      await sql`
        INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status)
        VALUES (${dekId}, ${principal.workspaceId},
                ${Buffer.from("PLACEHOLDER_WRAPPED_DEK")}, 'kek_dev_placeholder', 'active')`;

      const credId = genId("pc");
      // Placeholder ciphertext (§14.3 TODO: envelope-encrypt the real secret).
      await sql`
        INSERT INTO provider_credential
          (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url,
           allowed_hosts, status)
        VALUES
          (${credId}, ${principal.workspaceId}, ${provider}, ${label},
           ${Buffer.from("PLACEHOLDER_CIPHERTEXT")}, ${dekId}, ${baseUrl},
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
