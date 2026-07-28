// POST /api/v1/admin/seed — internal bootstrap (SPEC §21 verify harness helper).
//
// Creates a workspace + owner member + api_token (all scopes; plaintext returned ONCE) +
// gateway_installation + ingress profile + app + a global reference offering/price so the API is
// immediately usable (mint keys, create routes, plan/apply config). Guarded by the
// MANIFOLD_SEED_SECRET header — this is NOT a public endpoint.
//
// It runs inside the Next server so the workspace packages resolve through the bundler; a plain
// `node scripts/seed.ts` cannot import @manifold/database (its dist uses extension-less imports).
import { adminDb, type Sql } from "@/lib/db";
import { generateSecret } from "@/lib/crypto";
import { genId } from "@/lib/ids";
import { sha256Canonical } from "@manifold/config";
import { wrapInEnvelope, ManifoldError } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { AdminContracts } from "@manifold/contracts";
import { canonicalHostname } from "@/app/api/v1/deployments/_lib";
import { generateSeedInstallationIdentity } from "@/lib/seed-installation-identity";
import { withSeedBootstrapLock } from "@/lib/seed-bootstrap";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep the runtime contract aligned when this app is typechecked against an unbuilt workspace
// dependency. The canonical source of these additions remains AdminContracts in @manifold/contracts.
const SeedRequest = AdminContracts.seed.extend({ hostname: z.string().min(1).optional() });
const SeedResponse = AdminContracts.seedResponse.extend({
  status: z.enum(["seeded", "already_seeded"]),
  apiToken: z.string().nullable(),
  apiTokenShownOnce: z.boolean(),
  tokenId: z.string().nullable(),
  offeringId: z.string().nullable(),
  MANIFOLD_INSTALLATION_ID: z.string(),
  MANIFOLD_INSTALLATION_PRIVATE_KEY: z.string().nullable(),
  installationIdentityPublicKey: z.string(),
  installationPrivateKeyShownOnce: z.boolean(),
});

type ExistingSeed = {
  workspaceId: string;
  slug: string;
  memberId: string;
  installationId: string;
  publicKey: Buffer;
  profileId: string;
  hostname: string;
  appId: string;
};

function configuredHostname(slug: string, requested: string | undefined): string {
  const requireDeployableHostname = (value: string): string => {
    const hostname = canonicalHostname(value);
    if (hostname.endsWith(".local")) {
      throw new ManifoldError({
        status: 422,
        code: "VALIDATION",
        message: "hostname must be publicly deployable and cannot use the .local suffix",
        reasonCodes: [],
        details: { issues: [{ path: "hostname", message: ".local is not a deployable gateway hostname" }] },
      });
    }
    return hostname;
  };
  if (requested !== undefined) return requireDeployableHostname(requested);
  const domain = process.env.MANIFOLD_SEED_GATEWAY_DOMAIN;
  if (!domain) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "hostname is required; provide hostname or configure MANIFOLD_SEED_GATEWAY_DOMAIN",
      reasonCodes: [],
      details: { issues: [{ path: "hostname", message: "hostname or MANIFOLD_SEED_GATEWAY_DOMAIN required" }] },
    });
  }
  return requireDeployableHostname(`${slug}.${requireDeployableHostname(domain)}`);
}

/** Bootstrap intentionally cannot use the workspace-scoped mutation journal: no workspace
 * principal exists until this request creates it. A completed seed is therefore replay-safe by
 * its unique slug: later successful requests return durable identifiers only, never a second
 * API token or installation private key. If a process dies after commit and before its response,
 * those copy-once values cannot be recovered and operators must create replacements normally. */
function requireSeedAdminDb() {
  // This read happens before a workspace can be selected. The normal app connection is RLS scoped
  // and therefore cannot distinguish an absent workspace from an existing one hidden by the GUC.
  // Requiring the already-authorized bootstrap connection prevents a replay from minting a second
  // installation identity merely because the lookup was invisible.
  const privileged = adminDb();
  if (!privileged) {
    throw new ManifoldError({
      status: 500,
      code: "INTERNAL",
      message: "MANIFOLD_SEED_DB_URL is required for safe bootstrap replay and catalog seeding",
      reasonCodes: [],
    });
  }
  return privileged;
}

async function existingSeed(sql: Sql, slug: string): Promise<ExistingSeed | null> {
  const rows = await sql<ExistingSeed[]>`
    SELECT w.id AS "workspaceId", w.slug, m.id AS "memberId", i.id AS "installationId",
           i.public_key AS "publicKey", p.id AS "profileId", p.hostname, a.id AS "appId"
    FROM workspace w
    JOIN member m ON m.workspace_id = w.id AND m.role = 'owner'
    JOIN gateway_installation i ON i.workspace_id = w.id AND i.name = 'Seed Installation'
    JOIN gateway_ingress_profile p ON p.workspace_id = w.id AND p.installation_id = i.id
    JOIN app a ON a.workspace_id = w.id AND a.slug = 'default'
    WHERE w.slug = ${slug}
    ORDER BY m.created_at, i.created_at, p.created_at, a.created_at
    LIMIT 1`;
  return rows[0] ?? null;
}

async function existingWorkspaceSlug(sql: Sql): Promise<string | null> {
  const rows = await sql<{ slug: string }[]>`SELECT slug FROM workspace ORDER BY created_at, id LIMIT 1`;
  return rows[0]?.slug ?? null;
}

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

    const body = await contractBody(req, SeedRequest);
    const slug = body.slug ?? `ws-${Date.now().toString(36)}`;
    const result = await withSeedBootstrapLock(requireSeedAdminDb().$client, async (sql) => {
      const bootstrapSlug = await existingWorkspaceSlug(sql);
      if (bootstrapSlug && bootstrapSlug !== slug) {
        throw new ManifoldError({
          status: 409,
          code: "VALIDATION",
          message: "database is already bootstrapped for a different workspace",
          reasonCodes: ["BOOTSTRAP_WORKSPACE_EXISTS"],
        });
      }
      const prior = await existingSeed(sql, slug);
      if (prior) return { kind: "existing" as const, prior };
      if (bootstrapSlug) {
        throw new ManifoldError({
          status: 409,
          code: "VALIDATION",
          message: "existing workspace is not a complete seed bootstrap",
          reasonCodes: ["BOOTSTRAP_WORKSPACE_INCOMPLETE"],
        });
      }

      const name = body.name ?? "Seed Workspace";
      const email = body.email ?? "owner@example.com";
      const region = body.region ?? "us-east-1";
      const hostname = configuredHostname(slug, body.hostname);
      const short = Math.random().toString(36).slice(2, 8);
      const wsId = genId("ws");
      const token = generateSecret("mf_tok_");
      const installationIdentity = generateSeedInstallationIdentity();

      const modelId = genId("cm");
      const offeringId = genId("off");
      const priceId = genId("prc");
      const priceHash = sha256Canonical({ offeringId, input: 150000, output: 600000 });
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
          (${installationId}, ${wsId}, 'Seed Installation', ${installationIdentity.publicKey}, 'vercel')`;
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
      return { kind: "created" as const, wsId, token, installationIdentity, memberId, tokenId, installationId, profileId, appId, offeringId, hostname };
    });

    if (result.kind === "existing") {
      const { prior } = result;
      return contractOk(SeedResponse, {
        status: "already_seeded", workspaceId: prior.workspaceId, slug: prior.slug, hostname: prior.hostname,
        apiToken: null, apiTokenShownOnce: false, memberId: prior.memberId, tokenId: null,
        installationId: prior.installationId, profileId: prior.profileId, appId: prior.appId, offeringId: null,
        MANIFOLD_INSTALLATION_ID: prior.installationId,
        MANIFOLD_INSTALLATION_PRIVATE_KEY: null,
        installationIdentityPublicKey: prior.publicKey.toString("base64"),
        installationPrivateKeyShownOnce: false,
      }, requestId, 200);
    }

    return contractOk(SeedResponse,
      {
        status: "seeded",
        workspaceId: result.wsId,
        slug,
        hostname: result.hostname,
        apiToken: result.token.plaintext,
        apiTokenShownOnce: true,
        memberId: result.memberId,
        tokenId: result.tokenId,
        installationId: result.installationId,
        profileId: result.profileId,
        appId: result.appId,
        offeringId: result.offeringId,
        MANIFOLD_INSTALLATION_ID: result.installationId,
        MANIFOLD_INSTALLATION_PRIVATE_KEY: result.installationIdentity.privateKeyBase64,
        installationIdentityPublicKey: result.installationIdentity.publicKeyBase64,
        installationPrivateKeyShownOnce: true,
      },
      requestId,
      201,
    );
  });
}
