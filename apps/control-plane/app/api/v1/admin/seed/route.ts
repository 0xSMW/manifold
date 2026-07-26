// POST /api/v1/admin/seed — internal bootstrap (SPEC §21 verify harness helper).
//
// Creates a workspace + owner member + api_token (all scopes; plaintext returned ONCE) +
// gateway_installation + ingress profile + app + a global reference offering/price so the API is
// immediately usable (mint keys, create routes, plan/apply config). Guarded by the
// MANIFOLD_SEED_SECRET header — this is NOT a public endpoint.
//
// It runs inside the Next server so the workspace packages resolve through the bundler; a plain
// `node scripts/seed.ts` cannot import @manifold/database (its dist uses extension-less imports).
import { withWorkspace, adminDb, type Sql } from "@/lib/db";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import { sha256Canonical } from "@manifold/config";
import { wrapInEnvelope, jsonBody, ok, optionalString, ManifoldError } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { AdminContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALL_SCOPES = [
  "routes:read", "routes:write",
  "keys:read", "keys:write",
  "providers:read", "providers:write",
  "policies:read", "policies:write", "policies:approve",
  "budgets:read", "budgets:write",
  "observations:read",
  "registry:read", "registry:write",
  "config:read", "config:write",
  "audit:read",
  "storage:read", "storage:write",
  "deployments:read", "deployments:write",
  "system:read",
];

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const secret = process.env.MANIFOLD_SEED_SECRET;
    const presented = req.headers.get("x-seed-secret");
    if (!secret || presented !== secret) {
      throw new ManifoldError({
        status: 403,
        code: "FORBIDDEN",
        message: "invalid or missing seed secret",
        reasonCodes: [],
      });
    }

    const body = await contractBody(req, AdminContracts.seed);
    const slug = body.slug ?? `ws-${Date.now().toString(36)}`;
    const name = body.name ?? "Seed Workspace";
    const email = body.email ?? "owner@example.com";
    const region = body.region ?? "us-east-1";
    const short = Math.random().toString(36).slice(2, 8);
    const hostname = `${slug}-${short}.gateway.local`;

    const wsId = genId("ws");
    const token = generateSecret("mf_tok_");

    // Global reference/catalog data (RLS-excluded, §6.4): a canonical model + offering + price so a
    // route target can reference an offering. Migration 0002 REVOKEs writes on these tables from the
    // app role (anti-forgery: a compromised app must not rewrite pricing), specifying that catalog
    // seeding runs "as the migration owner (postgres)". So insert them via the privileged admin
    // connection when configured; fall back to the request connection for dev DBs where the app role
    // is unrestricted.
    const modelId = genId("cm");
    const offeringId = genId("off");
    const priceId = genId("prc");
    const priceHash = sha256Canonical({ offeringId, input: 150000, output: 600000 });
    const insertReferenceData = async (sql: Sql) => {
      await sql`
        INSERT INTO canonical_model
          (id, canonical_slug, family, display_name, catalog_revision)
        VALUES (${modelId}, ${"gpt-4o-mini-" + short}, 'gpt', 'GPT-4o mini', 'seed')`;
      await sql`
        INSERT INTO provider_model_offering
          (id, canonical_model_id, provider, provider_model_id, endpoint_kinds,
           adapter_revision, capabilities, catalog_revision)
        VALUES
          (${offeringId}, ${modelId}, 'openai', ${"gpt-4o-mini-" + short},
           ${sql.json(["chat"] as never)}, 'openai@1', ${sql.json({} as never)}, 'seed')`;
      await sql`
        INSERT INTO provider_price_revision
          (id, offering_id, input_per_mtok_microusd, output_per_mtok_microusd,
           currency, unit, fidelity, content_hash)
        VALUES
          (${priceId}, ${offeringId}, ${150000}, ${600000}, 'USD', 'per_mtok',
           'provider_verified', ${priceHash})`;
      await sql`
        UPDATE provider_model_offering SET active_price_revision_id = ${priceId}, updated_at = now()
        WHERE id = ${offeringId}`;
    };

    const refDb = adminDb();
    if (refDb) await refDb.$client.begin((tx) => insertReferenceData(tx as unknown as Sql));

    const result = await withWorkspace(wsId, async (sql) => {
      await sql`
        INSERT INTO workspace (id, slug, name, region)
        VALUES (${wsId}, ${slug}, ${name}, ${region})`;

      const memberId = genId("mbr");
      await sql`
        INSERT INTO member (id, workspace_id, email, name, role, accepted_at)
        VALUES (${memberId}, ${wsId}, ${email}, 'Seed Owner', 'owner', now())`;

      const tokenId = genId("tok");
      await sql`
        INSERT INTO api_token
          (id, workspace_id, display_prefix, keyed_hash, scopes, created_by)
        VALUES
          (${tokenId}, ${wsId}, ${token.displayPrefix}, ${token.keyedHash},
           ${sql.json(ALL_SCOPES as never)}, ${memberId})`;

      const installationId = genId("inst");
      await sql`
        INSERT INTO gateway_installation
          (id, workspace_id, name, public_key, edition)
        VALUES
          (${installationId}, ${wsId}, 'Seed Installation',
           ${Buffer.from("PLACEHOLDER_INSTALLATION_PUBLIC_KEY")}, 'vercel')`;

      const profileId = genId("prof");
      await sql`
        INSERT INTO gateway_ingress_profile
          (id, workspace_id, installation_id, hostname, mode, network_exposure, auth_config)
        VALUES
          (${profileId}, ${wsId}, ${installationId}, ${hostname}, 'public_app', 'public',
           ${sql.json({ kind: "virtual_key" } as never)})`;

      const appId = genId("app");
      await sql`
        INSERT INTO app (id, workspace_id, slug, name, status, default_capture_policy)
        VALUES (${appId}, ${wsId}, 'default', 'Default App', 'active',
                ${sql.json({ mode: "redacted" } as never)})`;

      // Dev fallback: no privileged admin connection configured → the app role is assumed
      // unrestricted here, so seed the reference catalog on the request connection.
      if (!refDb) await insertReferenceData(sql);

      return { memberId, tokenId, installationId, profileId, appId };
    });

    return contractOk(AdminContracts.seedResponse,
      {
        workspaceId: wsId,
        slug,
        hostname,
        apiToken: token.plaintext, // shown once
        memberId: result.memberId,
        tokenId: result.tokenId,
        installationId: result.installationId,
        profileId: result.profileId,
        appId: result.appId,
        offeringId,
      },
      requestId,
      201,
    );
  });
}
