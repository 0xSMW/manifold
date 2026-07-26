// GET/POST /api/v1/providers (SPEC §10.3).
//   GET  providers:read  — list this workspace's non-revoked provider credentials.
//   POST providers:write — create a credential. The submitted secret is envelope-encrypted
//     (§14.3, ADR-0016/0022): a fresh 256-bit DEK seals it with AES-256-GCM, and the DEK is
//     wrapped by the platform KEK (MANIFOLD_DATA_KEK). We store the REAL ciphertext + a
//     data_encryption_key row holding the wrapped DEK. The gateway later unwraps the DEK with the
//     same KEK and opens the ciphertext in-proc (apps/gateway decryptTargetSecret) — plaintext is
//     never at rest and the KEK never rides the snapshot.
import { randomBytes } from "node:crypto";
import { credentialAad, resolveDataKek, sealAesGcm, wrapDek, utf8 } from "@manifold/crypto";
import { authorize } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { runMutationGuard } from "@/lib/mutation-guard";
import { audit } from "@/lib/audit";
import { genId } from "@/lib/ids";
import {
  wrapInEnvelope,
  jsonBody,
  ok,
  ManifoldError,
} from "@/lib/http";
import { defaultProviderAllowedHosts } from "@/lib/provider-validation";
import { contractBody, contractOk } from "@/lib/contracts";
import { ProvidersApi } from "@manifold/contracts";

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

interface CreateProviderInput {
  provider: string;
  label: string;
  secret: string;
  baseUrl: string | null;
  allowedHosts: string[];
}

function validationError(issues: Array<{ path: string; message: string }>): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message: "provider credential request is invalid",
    reasonCodes: [],
    details: { issues },
  });
}

function parseCreateProvider(body: Record<string, unknown>): CreateProviderInput {
  const known = new Set(["provider", "label", "secret", "baseUrl", "allowedHosts"]);
  const issues = Object.keys(body)
    .filter((key) => !known.has(key))
    .map((key) => ({ path: key, message: "unknown field" }));

  const provider =
    typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!provider || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    issues.push({ path: "provider", message: "required provider id" });
  }
  if (!label) issues.push({ path: "label", message: "required non-empty string" });
  if (!secret) issues.push({ path: "secret", message: "required non-empty string" });

  let baseUrl: string | null = null;
  if (body.baseUrl !== undefined && body.baseUrl !== null) {
    if (typeof body.baseUrl !== "string") {
      issues.push({ path: "baseUrl", message: "must be an HTTPS URL" });
    } else {
      try {
        const parsed = new URL(body.baseUrl);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
          throw new Error("invalid base URL");
        }
        parsed.hash = "";
        baseUrl = parsed.toString().replace(/\/$/, "");
      } catch {
        issues.push({ path: "baseUrl", message: "must be an HTTPS URL without userinfo" });
      }
    }
  }

  let allowedHosts: string[] = [];
  if (body.allowedHosts !== undefined) {
    if (
      !Array.isArray(body.allowedHosts) ||
      !body.allowedHosts.every((entry) => typeof entry === "string")
    ) {
      issues.push({ path: "allowedHosts", message: "must be an array of hostnames" });
    } else {
      for (const raw of body.allowedHosts) {
        const host = raw.trim().toLowerCase().replace(/\.+$/, "");
        try {
          const parsed = new URL(`https://${host}`);
          if (
            !host ||
            parsed.hostname !== host ||
            parsed.port ||
            parsed.pathname !== "/" ||
            parsed.search ||
            parsed.hash
          ) {
            throw new Error("invalid host");
          }
          allowedHosts.push(host);
        } catch {
          issues.push({ path: "allowedHosts", message: `invalid hostname '${raw}'` });
        }
      }
      allowedHosts = [...new Set(allowedHosts)];
    }
  }
  if (!baseUrl && allowedHosts.length === 0) {
    allowedHosts = defaultProviderAllowedHosts(provider);
  }
  if (baseUrl && !allowedHosts.includes(new URL(baseUrl).hostname.toLowerCase())) {
    issues.push({
      path: "allowedHosts",
      message: "must explicitly include the configured baseUrl hostname",
    });
  }
  if (issues.length > 0) validationError(issues);
  return { provider, label, secret, baseUrl, allowedHosts };
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:read");
    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<ProviderRow[]>`
        SELECT id, provider, label, base_url, status, last_validated_at, created_at
        FROM provider_credential
        WHERE workspace_id = ${principal.workspaceId} AND revoked_at IS NULL
        ORDER BY created_at DESC`,
    );
    return contractOk(ProvidersApi.listResponse,
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
        nextCursor: null,
      },
      requestId,
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "providers:write");
    return runMutationGuard({ request: req, principal, requestId, rateLimit: { limit: 10, windowMs: 60_000 }, handler: async (sql) => {
    const { provider, label, secret, baseUrl, allowedHosts } = parseCreateProvider(await contractBody(req, ProvidersApi.createRequest));

    // Envelope-encrypt the secret (§14.3): fresh DEK seals it (AES-256-GCM), KEK wraps the DEK. The
    // seal binds the credential-identity AAD (credentialAad(credId)) so the ciphertext cannot be swapped
    // with another credential's under the shared workspace DEK — the gateway opens with the SAME AAD.
    const kek = resolveDataKek(process.env.MANIFOLD_DATA_KEK);
    const kekId = process.env.MANIFOLD_DATA_KEK_ID ?? "kek_dev";
    const dek = new Uint8Array(randomBytes(32));
    const wrappedDek = Buffer.from(wrapDek(kek, dek));
    const credId = genId("pc"); // minted BEFORE the seal so its id is the AAD binding
    const ciphertext = Buffer.from(sealAesGcm(dek, utf8(secret), credentialAad(credId)));

      const dekId = genId("dek");
      await sql`
        INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status)
        VALUES (${dekId}, ${principal.workspaceId},
                ${wrappedDek}, ${kekId}, 'active')`;

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
    return contractOk(ProvidersApi.createResponse,
      { id: credId, provider, label, status: "unvalidated" },
      requestId,
      201,
    );
    }});
  });
}
