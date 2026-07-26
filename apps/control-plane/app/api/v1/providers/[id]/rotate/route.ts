import { randomBytes } from "node:crypto";
import {
  credentialAad,
  resolveDataKek,
  sealAesGcm,
  utf8,
  wrapDek,
} from "@manifold/crypto";
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { ManifoldError, jsonBody, ok, wrapInEnvelope } from "@/lib/http";
import { genId } from "@/lib/ids";
import { contractBody, contractOk } from "@/lib/contracts";
import { ProvidersApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireRotateBody(body: Record<string, unknown>): string {
  const unknown = Object.keys(body).filter((key) => key !== "secret");
  const secret = body.secret;
  const issues: Array<{ path: string; message: string }> = unknown.map((key) => ({
    path: key,
    message: "unknown field",
  }));
  if (typeof secret !== "string" || secret.length === 0) {
    issues.push({ path: "secret", message: "required non-empty string" });
  }
  if (issues.length > 0) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "provider rotation request is invalid",
      reasonCodes: [],
      details: { issues },
    });
  }
  return secret as string;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    const { id } = await ctx.params;
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 5, windowMs: 60_000 }, handler: async (sql) => {
    const secret = requireRotateBody(await contractBody(req, ProvidersApi.rotateRequest));

    const kek = resolveDataKek(process.env.MANIFOLD_DATA_KEK);
    const kekId = process.env.MANIFOLD_DATA_KEK_ID ?? "kek_dev";
    const newDek = new Uint8Array(randomBytes(32));
    const newWrappedDek = Buffer.from(wrapDek(kek, newDek));
    const newCiphertext = Buffer.from(
      sealAesGcm(newDek, utf8(secret), credentialAad(id)),
    );
    const newDekId = genId("dek");

    const rotated = await (async () => {
      const existing = await sql<{ id: string; dek_id: string }[]>`
        SELECT id, dek_id
        FROM provider_credential
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}
          AND revoked_at IS NULL
        FOR UPDATE`;
      const current = existing[0];
      if (!current) return null;

      await sql`
        INSERT INTO data_encryption_key
          (id, workspace_id, wrapped_dek, kek_id, status)
        VALUES
          (${newDekId}, ${principal.workspaceId}, ${newWrappedDek}, ${kekId}, 'active')`;
      await sql`
        UPDATE provider_credential
        SET encrypted_secret = ${newCiphertext}, dek_id = ${newDekId},
            status = 'unvalidated', last_validated_at = NULL, updated_at = now()
        WHERE id = ${id} AND workspace_id = ${principal.workspaceId}`;

      // Current creates use one fresh DEK per credential. Preserve compatibility with any imported
      // legacy row that shares a DEK: destroy the old wrapped key only after proving no other
      // credential still references it.
      const otherReferences = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM provider_credential
        WHERE workspace_id = ${principal.workspaceId}
          AND dek_id = ${current.dek_id} AND id <> ${id}`;
      const previousDekDestroyed = Number(otherReferences[0]?.count ?? "0") === 0;
      if (previousDekDestroyed) {
        const destroyedWrappedDek = Buffer.from(randomBytes(newWrappedDek.byteLength));
        await sql`
          UPDATE data_encryption_key
          SET wrapped_dek = ${destroyedWrappedDek}, status = 'revoked', updated_at = now()
          WHERE id = ${current.dek_id} AND workspace_id = ${principal.workspaceId}`;
      }
      await audit(sql, principal, {
        action: "provider.rotate",
        targetKind: "provider_credential",
        targetId: id,
        requestId,
        detail: {
          previousDekId: current.dek_id,
          successorDekId: newDekId,
          previousDekDestroyed,
        },
      });
      return { id };
    })();
    if (!rotated) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "active provider credential not found",
        reasonCodes: [],
      });
    }

    return contractOk(ProvidersApi.rotateResponse,
      {
        id: rotated.id,
        status: "unvalidated",
        rotated: true,
        plaintextStored: false,
      },
      requestId,
    );
    }});
  });
}
