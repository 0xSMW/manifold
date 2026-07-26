// POST /api/v1/providers/{id}/validate (SPEC §10.3, providers:write).
// Credential/decryption reads finish before provider egress begins. Only the result write and its
// audit event share the second short transaction, so a slow upstream cannot hold a DB transaction.
import {
  credentialAad,
  openAesGcm,
  resolveDataKek,
  unwrapDek,
} from "@manifold/crypto";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { audit } from "@/lib/audit";
import { ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { validateProviderCredential } from "@/lib/provider-validation";
import { contractOk, contractOptionalEmptyBody } from "@/lib/contracts";
import { ProvidersApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CredentialRow {
  id: string;
  provider: string;
  encrypted_secret: Uint8Array;
  dek_id: string;
  base_url: string | null;
  allowed_hosts: unknown;
  wrapped_dek: Uint8Array;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function decryptSecret(row: CredentialRow): string {
  try {
    const kek = resolveDataKek(process.env.MANIFOLD_DATA_KEK);
    const dek = unwrapDek(kek, row.wrapped_dek);
    const plaintext = openAesGcm(
      dek,
      row.encrypted_secret,
      credentialAad(row.id),
    );
    const secret = new TextDecoder().decode(plaintext);
    if (!secret) throw new Error("empty credential");
    return secret;
  } catch {
    throw new ManifoldError({
      status: 500,
      code: "INTERNAL",
      message: "provider credential could not be decrypted",
      reasonCodes: ["PROVIDER_CREDENTIAL_UNAVAILABLE"],
    });
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    const { id } = await ctx.params;
    await contractOptionalEmptyBody(req.clone(), ProvidersApi.emptyRequest);
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
    const credential = await (async () => {
      const rows = await sql<CredentialRow[]>`
        SELECT pc.id, pc.provider, pc.encrypted_secret, pc.dek_id, pc.base_url,
               pc.allowed_hosts, dek.wrapped_dek
        FROM provider_credential pc
        JOIN data_encryption_key dek
          ON dek.id = pc.dek_id AND dek.workspace_id = pc.workspace_id
        WHERE pc.id = ${id} AND pc.workspace_id = ${principal.workspaceId}
          AND pc.revoked_at IS NULL AND dek.status = 'active'
        LIMIT 1`;
      return rows[0] ?? null;
    })();
    if (!credential) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "provider credential not found",
        reasonCodes: [],
      });
    }

    const secret = decryptSecret(credential);
    const validation = await validateProviderCredential({
      provider: credential.provider,
      secret,
      baseUrl: credential.base_url,
      allowedHosts: stringArray(credential.allowed_hosts),
    });
    const status = validation.outcome === "valid" ? "valid" : "invalid";

    const updated = await (async () => {
      const rows = await sql<{ id: string }[]>`
        UPDATE provider_credential
        SET status = ${status}, last_validated_at = now(), updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
          AND dek_id = ${credential.dek_id}
          AND encrypted_secret = ${Buffer.from(credential.encrypted_secret)}
        RETURNING id`;
      if (!rows[0]) return null;
      await audit(sql, principal, {
        action: "provider.validate",
        targetKind: "provider_credential",
        targetId: id,
        requestId,
        detail: {
          outcome: validation.outcome,
          classification: validation.classification,
          upstreamStatus: validation.upstreamStatus,
        },
      });
      return rows[0];
    })();
    if (!updated) {
      throw new ManifoldError({
        status: 409,
        code: "INTERNAL",
        message: "provider credential changed during validation; retry",
        reasonCodes: ["PROVIDER_CREDENTIAL_CHANGED"],
        retryable: true,
      });
    }

    return contractOk(ProvidersApi.validateResponse,
      {
        id: updated.id,
        status,
        validated: validation.outcome === "valid",
        outcome: validation.outcome,
        classification: validation.classification,
        upstreamStatus: validation.upstreamStatus,
        message: validation.message,
        responseTruncated: validation.responseTruncated,
      },
      requestId,
    );
    }});
  });
}
