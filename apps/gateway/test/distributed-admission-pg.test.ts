// Real Postgres coverage for strict fleet-wide gateway admission.  Every
// adapter here uses the production manifold_app role, so tenant isolation is
// load-bearing rather than masked by the migration-owner superuser.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";
import type { Sql } from "@manifold/database";
import { PostgresDistributedAdmission } from "../src/admission.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { seedMinimalGatewayTenant } from "../../../packages/database/test/seed-gateway-tenant.ts";

const APP_PASSWORD = "CHANGEME_APP_PASSWORD";
const A = { workspace: "ws_adma", installation: "inst_adma", key: "vk_adma" };
const B = { workspace: "ws_admb", installation: "inst_admb", key: "vk_admb" };
let pg: PgHarness;
let appSql: Sql;
let seq = 0;

function trace(label: string): string {
  seq += 1;
  return `trace-admission-${label}-${seq}`;
}

function service(
  tenant = A,
  options: Partial<{ installationConcurrency: number; perKeyConcurrency: number }> = {},
): PostgresDistributedAdmission {
  return new PostgresDistributedAdmission({
    sql: appSql,
    workspaceId: tenant.workspace,
    installationConcurrency: options.installationConcurrency ?? 20,
    perKeyConcurrency: options.perKeyConcurrency ?? 20,
  });
}

function input(label: string, overrides: Partial<{ estimatedTokens: number; rateLimit: { rpm?: number; tpm?: number; burst?: number } }> = {}) {
  return {
    installationId: A.installation,
    virtualKeyId: A.key,
    traceId: trace(label),
    estimatedTokens: overrides.estimatedTokens ?? 1,
    rateLimit: overrides.rateLimit,
  };
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-admission", poolSize: 16 });
  pg.psql(
    seedMinimalGatewayTenant({ prefix: "adma", hostname: "adma.local", keyHashHex: "11".repeat(32) }) +
    seedMinimalGatewayTenant({ prefix: "admb", hostname: "admb.local", keyHashHex: "22".repeat(32) }),
  );
  const appUrl = pg.url.replace("postgres:postgres@", `manifold_app:${APP_PASSWORD}@`);
  appSql = postgres(appUrl, { max: 16, prepare: false, onnotice: () => {} }) as unknown as Sql;
}, { timeout: 180_000 });

after(async () => {
  if (appSql) await (appSql as unknown as postgres.Sql).end({ timeout: 5 });
  if (pg) await pg.stop();
});

beforeEach(async () => {
  seq = 0;
  await pg.sql`DELETE FROM gateway_concurrency_lease`;
  await pg.sql`DELETE FROM gateway_rate_limit_state`;
});

test("concurrent separate instances admit exactly cap and deny cap plus one", async () => {
  const one = service(A, { installationConcurrency: 2, perKeyConcurrency: 2 });
  const two = service(A, { installationConcurrency: 2, perKeyConcurrency: 2 });
  const decisions = await Promise.all([
    one.admit(input("cap-a")), two.admit(input("cap-b")), one.admit(input("cap-c")),
  ]);
  assert.equal(decisions.filter((d) => d.allowed).length, 2);
  assert.equal(decisions.filter((d) => !d.allowed && d.reason === "concurrency").length, 1);
});

test("RPM and TPM do not oversell across separate service instances", async () => {
  const one = service();
  const two = service();
  const rpm = { rpm: 2, tpm: 100, burst: 2 };
  const rpmResults = await Promise.all([
    one.admit(input("rpm-a", { rateLimit: rpm })),
    two.admit(input("rpm-b", { rateLimit: rpm })),
    one.admit(input("rpm-c", { rateLimit: rpm })),
  ]);
  assert.equal(rpmResults.filter((d) => d.allowed).length, 2);
  assert.equal(rpmResults.filter((d) => !d.allowed && d.reason === "rpm").length, 1);

  await pg.sql`DELETE FROM gateway_concurrency_lease`;
  await pg.sql`DELETE FROM gateway_rate_limit_state`;
  const tpm = { rpm: 100, tpm: 10, burst: 100 };
  const tpmResults = await Promise.all([
    one.admit(input("tpm-a", { estimatedTokens: 6, rateLimit: tpm })),
    two.admit(input("tpm-b", { estimatedTokens: 6, rateLimit: tpm })),
  ]);
  assert.equal(tpmResults.filter((d) => d.allowed).length, 1);
  assert.equal(tpmResults.filter((d) => !d.allowed && d.reason === "tpm").length, 1);
});

test("tightening a bucket clamps prior balance instead of minting a fresh burst", async () => {
  const authority = service();
  const first = await authority.admit(input("initial", { rateLimit: { rpm: 1, tpm: 100, burst: 1 } }));
  assert.equal(first.allowed, true);
  const tightened = await authority.admit(input("tightened", { rateLimit: { rpm: 2, tpm: 100, burst: 2 } }));
  assert.equal(tightened.allowed, false);
  if (!tightened.allowed) assert.equal(tightened.reason, "rpm");
});

test("duplicate trace is one active lease and one rate debit; release is idempotent", async () => {
  const authority = service(A, { installationConcurrency: 1, perKeyConcurrency: 1 });
  const replay = input("duplicate", { rateLimit: { rpm: 2, tpm: 20, burst: 2 } });
  const first = await authority.admit(replay);
  const second = await authority.admit(replay);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  const leases = await pg.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM gateway_concurrency_lease`;
  assert.equal(leases[0]?.count, "1");
  const bucket = await pg.sql<{ request_tokens: number }[]>`
    SELECT request_tokens FROM gateway_rate_limit_state WHERE installation_id = ${A.installation} AND virtual_key_id = ${A.key}
  `;
  assert.equal(bucket[0]?.request_tokens, 1);
  if (first.allowed) { await first.release(); await first.release(); }
  const released = await pg.sql<{ state: string }[]>`SELECT state FROM gateway_concurrency_lease WHERE id = ${replay.traceId}`;
  assert.equal(released[0]?.state, "released");
});

test("expired crash lease is reclaimed before enforcing the next admission", async () => {
  const authority = service(A, { installationConcurrency: 1, perKeyConcurrency: 1 });
  const held = await authority.admit(input("crashed"));
  assert.equal(held.allowed, true);
  await pg.sql`
    UPDATE gateway_concurrency_lease SET expires_at = clock_timestamp() - interval '1 second'
    WHERE installation_id = ${A.installation}
  `;
  const recovered = await authority.admit(input("recovered"));
  assert.equal(recovered.allowed, true);
  const states = await pg.sql<{ state: string }[]>`
    SELECT state FROM gateway_concurrency_lease WHERE installation_id = ${A.installation} ORDER BY created_at
  `;
  assert.ok(states.some((row) => row.state === "expired"));
  assert.ok(states.some((row) => row.state === "active"));
});

test("manifold_app cannot read, admit, or release another workspace's leases", async () => {
  const authorityB = service(B, { installationConcurrency: 1, perKeyConcurrency: 1 });
  const held = await authorityB.admit({
    installationId: B.installation, virtualKeyId: B.key, traceId: trace("workspace-b"), estimatedTokens: 1,
  });
  assert.equal(held.allowed, true);
  const authorityA = service(A, { installationConcurrency: 1, perKeyConcurrency: 1 });
  await authorityA.release(held.allowed ? `trace-admission-workspace-b-1` : "unreachable");
  const row = await pg.sql<{ state: string }[]>`
    SELECT state FROM gateway_concurrency_lease WHERE id = ${"trace-admission-workspace-b-1"}
  `;
  assert.equal(row[0]?.state, "active");
  const denied = await authorityA.admit({
    installationId: B.installation, virtualKeyId: B.key, traceId: trace("cross-workspace"), estimatedTokens: 1,
  });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.reason, "unavailable");
});
