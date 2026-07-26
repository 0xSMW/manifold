// One real-Postgres convergence proof for durable target health.  It crosses the same seams that
// production uses: app-role fact admission -> control-plane rollup -> signed health-only snapshot
// publication -> gateway-core target selection.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import {
  apply,
  computeContentHash,
  generateSigningKeyPair,
  healthOnlyPublish,
  signSnapshot,
  verifySnapshot,
  type ConfigSnapshot,
  type Plan,
} from "@manifold/config";
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import { recordProviderAttemptHealthFacts, setWorkspaceGuc, type Sql } from "@manifold/database";
import type { Snapshot } from "@manifold/ports";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { seedMinimalGatewayTenant } from "../../../packages/database/test/seed-gateway-tenant.ts";

const APP_PASSWORD = "CHANGEME_APP_PASSWORD";
const WORKSPACE_ID = "ws_the2e";
const INSTALLATION_ID = "inst_the2e";
const PROFILE_ID = "prof_the2e";
const ROUTE_ID = "route_the2e";
const ROUTE_REVISION_ID = "rev_the2e";
const TARGET_A = "tg_the2e";
const TARGET_B = "tg_the2e_b";
const SNAPSHOT_INITIAL = "cfg_the2e_initial";
const API_KEY = "sk-target-health-e2e";
const PEPPER = new TextEncoder().encode("target-health-e2e-pepper");
const HOST = "the2e.gateway.test";
const MODEL = "the2e-public";

let pg: PgHarness;
let appSql: Sql;
let drainRollups: (workspaceId: string, limit?: number) => Promise<{ claimed: number; rolledUp: number; changed: number; retried: number }>;
const signing = generateSigningKeyPair();
let keyHash: string;

function plan(snapshot: ConfigSnapshot, baseConfigHash: string | null): Plan {
  return {
    installationId: INSTALLATION_ID,
    workspaceId: WORKSPACE_ID,
    baseConfigHash,
    targetConfigHash: snapshot.meta.contentHash,
    planHash: `plan:${snapshot.meta.revision}`,
    diffJson: {
      routes: { added: [], removed: [], changed: [] }, keys: { added: [], removed: [], changed: [] },
      offerings: { added: [], removed: [], changed: [] }, policies: { added: [], removed: [], changed: [] },
      budgets: { added: [], removed: [], changed: [] },
    },
    tripwireItems: [], snapshot, noop: false,
  };
}

function unsignedSnapshot(revision: string): ConfigSnapshot {
  const snapshot: ConfigSnapshot = {
    meta: {
      schema: "manifold.snapshot.v1", installationId: INSTALLATION_ID, revision,
      contentHash: "", builtAt: new Date().toISOString(), signature: "", signingKeyId: signing.signingKeyId,
    },
    profiles: { [HOST]: { id: PROFILE_ID, mode: "public_app", policyRevision: null, defaultRouteSet: null } },
    keys: { [keyHash]: { id: "vk_the2e", profileId: PROFILE_ID, scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null } },
    offerings: {
      off_the2e: {
        provider: "openai", providerModelId: "the2e-provider", adapterRevision: "ar1", region: null,
        priceFidelity: null, capabilities: {}, baseUrl: null,
      },
    }, policies: {}, budgets: {},
    routes: {
      [`${PROFILE_ID}:chat:${MODEL}`]: {
        routeId: ROUTE_ID, revision: ROUTE_REVISION_ID, mode: "ordered", timeoutMs: 30_000,
        capturePolicyId: "default", retryPolicy: { max_attempts: 1, backoff_ms: 0 },
        targets: [
          {
            targetId: TARGET_A, offeringId: "off_the2e", credentialId: "cred_the2e", dekId: "dek_the2e",
            credentialCiphertext: "ciphertext-a", wrappedDek: "wrapped-a", weight: 1, priority: 0,
            healthState: "unknown", baseUrl: "https://a.the2e.provider.test", region: null,
            allowedHosts: ["a.the2e.provider.test"], authInject: { headers: {} },
          },
          {
            targetId: TARGET_B, offeringId: "off_the2e", credentialId: "cred_the2e", dekId: "dek_the2e",
            credentialCiphertext: "ciphertext-b", wrappedDek: "wrapped-b", weight: 1, priority: 1,
            healthState: "unknown", baseUrl: "https://b.the2e.provider.test", region: null,
            allowedHosts: ["b.the2e.provider.test"], authInject: { headers: {} },
          },
        ],
      },
    },
  };
  snapshot.meta.contentHash = computeContentHash(snapshot);
  return signSnapshot(snapshot, signing.privateKey, signing.signingKeyId);
}

async function appendFacts(facts: Parameters<typeof recordProviderAttemptHealthFacts>[3]): Promise<number> {
  return appSql.begin(async (tx) => {
    await setWorkspaceGuc(tx as unknown as Sql, WORKSPACE_ID);
    return recordProviderAttemptHealthFacts(tx as unknown as Sql, WORKSPACE_ID, INSTALLATION_ID, facts);
  });
}

async function activeSnapshot(): Promise<ConfigSnapshot> {
  const rows = await pg.sql<{ snapshot: ConfigSnapshot }[]>`
    SELECT snapshot FROM gateway_config_revision
    WHERE workspace_id = ${WORKSPACE_ID} AND installation_id = ${INSTALLATION_ID} AND status = 'active'`;
  assert.equal(rows.length, 1, "one active snapshot exists");
  return rows[0]!.snapshot;
}

async function dispatch(snapshot: ConfigSnapshot): Promise<string> {
  const calls: string[] = [];
  const context: GatewayContext = {
    installationId: INSTALLATION_ID, snapshot: snapshot as Snapshot, crypto: new FakeCrypto(), clock: new FixedClock(), pepper: PEPPER,
    ingest: { emit: async () => {} }, resolveSecret: async () => "provider-secret",
    fetcher: { fetch: async (request) => {
      calls.push(new URL(request.url).hostname);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    } },
  };
  const response = await handleRequest(context, new Request(`https://${HOST}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [] }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  return calls[0]!;
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-target-health-e2e", poolSize: 8 });
  const appUrl = pg.url.replace("postgres:postgres@", `manifold_app:${APP_PASSWORD}@`);
  appSql = postgres(appUrl, { max: 4, prepare: false, onnotice: () => {} }) as unknown as Sql;
  // The control-plane rollup uses its production lazy `db()/withWorkspace` seam; load it only
  // after DATABASE_URL points at this ephemeral app-role database.
  process.env.DATABASE_URL = appUrl;
  ({ drainTargetHealthRollups: drainRollups } = await import("../lib/target-health.ts"));
  keyHash = await keyedHashHex(new FakeCrypto(), PEPPER, API_KEY);
  pg.psql(`
    ${seedMinimalGatewayTenant({ prefix: "the2e", hostname: HOST, keyHashHex: "aa".repeat(32) })}
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url)
    VALUES ('${TARGET_B}', '${WORKSPACE_ID}', '${ROUTE_REVISION_ID}', 'cred_the2e', 'off_the2e', 'ar1', 'https://b.the2e.provider.test');
  `);
  const initial = unsignedSnapshot(SNAPSHOT_INITIAL);
  const applied = await apply(pg.sql, plan(initial, null), null);
  assert.equal(applied.outcome, "accepted", "initial signed snapshot activates");
}, { timeout: 180_000 });

after(async () => {
  if (appSql) await (appSql as unknown as postgres.Sql).end({ timeout: 5 });
  if (pg) await pg.stop();
});

test("five transient facts quarantine one target in a fresh signed snapshot, then three successes recover it", { timeout: 60_000 }, async () => {
  // Keep all synthetic evidence safely behind database wall time. Facts a few milliseconds in
  // the future are intentionally excluded by the production `occurred_at <= now()` fence and made
  // this recovery assertion scheduler-dependent under the parallel suite.
  const failureAt = Date.now() - 10_000;
  const now = new Date(failureAt).toISOString();
  const failures = Array.from({ length: 5 }, (_, index) => ({
    sourceEventId: `failure-${index}`, targetId: TARGET_A, routeRevisionId: ROUTE_REVISION_ID,
    snapshotRevisionId: SNAPSHOT_INITIAL, outcome: "transient_failure" as const, httpStatus: 503,
    reasonCodes: ["PROVIDER_HTTP_5XX"], occurredAt: now,
  }));
  const stale = {
    sourceEventId: "stale-snapshot", targetId: TARGET_A, routeRevisionId: ROUTE_REVISION_ID,
    snapshotRevisionId: "cfg_the2e_stale", outcome: "transient_failure" as const, httpStatus: 503,
    reasonCodes: ["PROVIDER_HTTP_5XX"], occurredAt: now,
  };
  assert.equal(await appendFacts([...failures, failures[0]!, stale]), 5,
    "five unique active-snapshot facts are admitted; duplicate and stale attribution are ignored");
  assert.equal(await appendFacts([failures[0]!, stale]), 0, "redelivery is idempotent under the app role");

  const firstDrain = await drainRollups(WORKSPACE_ID, 10);
  assert.equal(firstDrain.claimed, 1);
  assert.equal(firstDrain.rolledUp, 1);
  assert.equal(firstDrain.retried, 0);
  const health = await pg.sql<{ state: string; sample_count: number }[]>`
    SELECT state, sample_count FROM gateway_target_health WHERE workspace_id = ${WORKSPACE_ID} AND target_id = ${TARGET_A}`;
  assert.deepEqual(Array.from(health), [{ state: "unhealthy", sample_count: 5 }]);

  const before = await activeSnapshot();
  const firstPublish = await healthOnlyPublish(appSql as unknown as ReturnType<typeof postgres>, WORKSPACE_ID, INSTALLATION_ID, null, {
    signingKey: signing.privateKey, signingKeyId: signing.signingKeyId,
  });
  assert.equal(firstPublish?.outcome, "accepted");
  const quarantined = await activeSnapshot();
  assert.notEqual(quarantined.meta.revision, before.meta.revision, "health publication activates a fresh revision");
  assert.equal(verifySnapshot(quarantined, signing.publicKey).ok, true, "published health snapshot is signed");
  const routeKey = `${PROFILE_ID}:chat:${MODEL}`;
  assert.equal(quarantined.routes[routeKey]!.targets[0]!.healthState, "unhealthy");
  assert.deepEqual(
    { ...quarantined, meta: before.meta, routes: { ...quarantined.routes, [routeKey]: { ...quarantined.routes[routeKey]!, targets: before.routes[routeKey]!.targets } } },
    before,
    "health-only publication preserves every non-health snapshot field byte-for-byte",
  );
  assert.equal(await dispatch(quarantined), "b.the2e.provider.test", "gateway-core skips the quarantined target");

  const recoveryAt = failureAt + 5_000;
  const successes = Array.from({ length: 3 }, (_, index) => ({
    sourceEventId: `recovery-${index}`, targetId: TARGET_A, routeRevisionId: ROUTE_REVISION_ID,
    snapshotRevisionId: quarantined.meta.revision, outcome: "success" as const, httpStatus: 200,
    reasonCodes: [], occurredAt: new Date(recoveryAt + index).toISOString(),
  }));
  assert.equal(await appendFacts(successes), 3);
  const secondDrain = await drainRollups(WORKSPACE_ID, 10);
  assert.deepEqual(secondDrain, { claimed: 1, rolledUp: 1, changed: 1, retried: 0 },
    "three literal newest successes recover despite older failures still in the window");
  const recoveredOp = await healthOnlyPublish(appSql as unknown as ReturnType<typeof postgres>, WORKSPACE_ID, INSTALLATION_ID, null, {
    signingKey: signing.privateKey, signingKeyId: signing.signingKeyId,
  });
  assert.equal(recoveredOp?.outcome, "accepted");
  const recovered = await activeSnapshot();
  assert.equal(recovered.routes[routeKey]!.targets[0]!.healthState, "healthy");
  assert.equal(await dispatch(recovered), "a.the2e.provider.test", "recovered target becomes eligible and ordered selection picks it");
});
