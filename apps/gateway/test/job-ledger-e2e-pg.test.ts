// Real Postgres/RLS coverage for the durable job ledger.  This deliberately uses the
// non-superuser production role: a superuser would silently bypass the job_ledger policy.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import postgres from "postgres";
import type { Sql } from "@manifold/database";
import type { HotPathObservationEvent } from "@manifold/ports";
import { JobLedgerService, type JobLedgerServiceOptions } from "../src/jobLedger.ts";
import { createReadinessHandler } from "../api/ready.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

const APP_PASSWORD = "CHANGEME_APP_PASSWORD";
const WORKSPACE_A = "ws_job_a";
const WORKSPACE_B = "ws_job_b";
const FIXED_START = new Date("2026-07-24T00:00:00.000Z");

let pg: PgHarness;
let appSql: Sql;
let now = new Date(FIXED_START);
let traceSequence = 0;

before(async () => {
  pg = await startPg({ namePrefix: "mf-job-ledger-e2e", poolSize: 8 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE_A}', 'job-a', 'Job Ledger A', 'local'),
      ('${WORKSPACE_B}', 'job-b', 'Job Ledger B', 'local');
  `);
  const appUrl = pg.url.replace("postgres:postgres@", `manifold_app:${APP_PASSWORD}@`);
  appSql = postgres(appUrl, { max: 8, prepare: false, onnotice: () => {} }) as unknown as Sql;
}, { timeout: 180_000 });

after(async () => {
  if (appSql) await (appSql as unknown as postgres.Sql).end({ timeout: 5 });
  if (pg) await pg.stop();
});

beforeEach(async () => {
  now = new Date(FIXED_START);
  await pg.sql`DELETE FROM job_ledger`;
});

function readinessStatus(service: JobLedgerService): Promise<Response> {
  return createReadinessHandler({
    getRuntime: async () => ({
      installationId: "inst_job_a",
      checkReady: () => service.checkReady(WORKSPACE_A),
      snapshots: {
        async checkReady() {
          return {
            snapshot: { meta: { installationId: "inst_job_a", revision: "test-revision" } },
            verifiedAtMs: Date.now(),
          };
        },
      },
    }),
  })(new Request("https://gateway.test/api/ready"));
}

test("readiness requires the direct restricted manifold_app role and writes no probe job", async () => {
  const service = ledger(async () => {});
  await service.checkReady(WORKSPACE_A);
  const before = await pg.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM job_ledger`;
  assert.equal(before[0]?.count, "0");

  const migrationOwner = ledger(async () => {}, pg.sql as unknown as Sql);
  await assert.rejects(
    migrationOwner.checkReady(WORKSPACE_A),
    /restricted manifold_app/,
    "a migration-owner URL must never make runtime readiness pass",
  );
  assert.equal((await readinessStatus(migrationOwner)).status, 503);
});

test("readiness returns 503 when any gateway worker write capability is revoked", async () => {
  const service = ledger(async () => {});
  const capabilities = [
    {
      name: "distributed admission",
      revoke: () => pg.sql`REVOKE INSERT ON gateway_rate_limit_state FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON gateway_rate_limit_state TO manifold_app`,
    },
    {
      name: "observation projection",
      revoke: () => pg.sql`REVOKE INSERT ON observation FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON observation TO manifold_app`,
    },
    {
      name: "usage projection",
      revoke: () => pg.sql`REVOKE INSERT ON usage_record FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON usage_record TO manifold_app`,
    },
    {
      name: "cost accounting",
      revoke: () => pg.sql`REVOKE INSERT ON cost_ledger FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON cost_ledger TO manifold_app`,
    },
    {
      name: "budget accounting",
      revoke: () => pg.sql`REVOKE UPDATE ON budget_reservation FROM manifold_app`,
      grant: () => pg.sql`GRANT UPDATE ON budget_reservation TO manifold_app`,
    },
    {
      name: "audit evidence",
      revoke: () => pg.sql`REVOKE INSERT ON audit_event FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON audit_event TO manifold_app`,
    },
    {
      name: "audit delivery destination lookup triggered by audit evidence",
      revoke: () => pg.sql`REVOKE SELECT ON audit_destination FROM manifold_app`,
      grant: () => pg.sql`GRANT SELECT ON audit_destination TO manifold_app`,
    },
    {
      name: "audit delivery job enqueue triggered by audit evidence",
      revoke: () => pg.sql`REVOKE INSERT ON audit_delivery_job FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON audit_delivery_job TO manifold_app`,
    },
    {
      name: "target-health ingest",
      revoke: () => pg.sql`REVOKE INSERT ON gateway_target_health_observation FROM manifold_app`,
      grant: () => pg.sql`GRANT INSERT ON gateway_target_health_observation TO manifold_app`,
    },
    {
      name: "job ledger",
      revoke: () => pg.sql`REVOKE UPDATE ON job_ledger FROM manifold_app`,
      grant: () => pg.sql`GRANT UPDATE ON job_ledger TO manifold_app`,
    },
  ];

  for (const capability of capabilities) {
    await capability.revoke();
    try {
      await assert.rejects(
        service.checkReady(WORKSPACE_A),
        /gateway runtime table privileges are unavailable/,
        `${capability.name} must fail the runtime privilege matrix`,
      );
      assert.equal((await readinessStatus(service)).status, 503, `${capability.name} must fail public readiness`);
    } finally {
      await capability.grant();
    }
  }
});

function payload(workspaceId: string, label: string) {
  const traceId = `01K${String(++traceSequence).padStart(23, "0")}`;
  const event = (kind: HotPathObservationEvent["kind"], seq: number): HotPathObservationEvent => ({
    traceId,
    kind,
    seq,
    occurredAt: FIXED_START.toISOString(),
    profileId: `profile_${label}`,
    keyId: "key_1",
    routeId: "route_1",
    offeringId: "offering_1",
    status: kind === "terminal" ? 200 : null,
    reasonCodes: [],
  });
  return {
    version: 1 as const,
    workspaceId,
    producerId: `producer_${label}`,
    events: [event("accepted", 0), event("terminal", 1)],
  };
}

function ledger(handler: JobLedgerServiceOptions["observationIngestHandler"], sql = appSql) {
  return new JobLedgerService({
    sql,
    now: () => new Date(now),
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: () => 0,
    claimTimeoutMs: 1_000,
    observationIngestHandler: handler,
  });
}

async function row(id: string) {
  const rows = await pg.sql<{
    status: string;
    attempts: number;
    run_after: Date;
    claimed_at: Date | null;
    claimed_by: string | null;
    last_error: { code: string; message: string } | null;
  }[]>`
    SELECT status, attempts, run_after, claimed_at, claimed_by, last_error
    FROM job_ledger WHERE id = ${id}
  `;
  assert.equal(rows.length, 1, "the enqueued job must exist in real Postgres");
  return rows[0]!;
}

test("under manifold_app RLS, enqueue is idempotent and persists one tenant row", async () => {
  now = new Date(FIXED_START);
  const service = ledger(async () => {});
  const input = payload(WORKSPACE_A, "idem");
  const first = await service.enqueueObservationIngest(input);
  const second = await service.enqueueObservationIngest(input);

  assert.equal(first.enqueued, true);
  assert.ok(first.id);
  assert.deepEqual(second, { id: null, enqueued: false });
  const rows = await pg.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM job_ledger
    WHERE kind = 'observation.ingest.v1' AND idempotency_key = ${`workspace:${WORKSPACE_A}:trace:${input.events[0]!.traceId}`}
  `;
  assert.equal(rows[0]!.count, "1");
});

test("two concurrent manifold_app claimers cannot double-claim one due job", async () => {
  now = new Date(FIXED_START);
  const service = ledger(async () => {});
  const enqueued = await service.enqueueObservationIngest(payload(WORKSPACE_A, "race"));
  assert.ok(enqueued.id);

  const [one, two] = await Promise.all([
    service.claim(WORKSPACE_A, "worker-one", 1),
    service.claim(WORKSPACE_A, "worker-two", 1),
  ]);
  assert.equal(one.length + two.length, 1, "SKIP LOCKED must assign the row to exactly one worker");
  const persisted = await row(enqueued.id);
  assert.equal(persisted.status, "claimed");
  assert.ok(["worker-one", "worker-two"].includes(persisted.claimed_by ?? ""));
});

test("successful drain marks done and invokes the handler once", async () => {
  now = new Date(FIXED_START);
  let calls = 0;
  const service = ledger(async () => { calls += 1; });
  const enqueued = await service.enqueueObservationIngest(payload(WORKSPACE_A, "success"));
  assert.ok(enqueued.id);

  assert.deepEqual(await service.drain(WORKSPACE_A, "success-worker"), {
    claimed: 1, completed: 1, retried: 0, dead: 0,
  });
  assert.equal(calls, 1);
  const persisted = await row(enqueued.id);
  assert.equal(persisted.status, "done");
  assert.equal(persisted.claimed_at, null);
  assert.equal(persisted.claimed_by, null);
});

test("failed work retries with a redacted error then reaches dead at max attempts", async () => {
  now = new Date(FIXED_START);
  let calls = 0;
  const service = ledger(async () => {
    calls += 1;
    throw new Error("postgres://alice:password@db.example/jobs token=top-secret");
  });
  const enqueued = await service.enqueueObservationIngest({
    ...payload(WORKSPACE_A, "failure"), maxAttempts: 2,
  });
  assert.ok(enqueued.id);

  assert.deepEqual(await service.drain(WORKSPACE_A, "failure-worker"), {
    claimed: 1, completed: 0, retried: 1, dead: 0,
  });
  const retried = await row(enqueued.id);
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 1);
  assert.equal(retried.run_after.getTime(), FIXED_START.getTime() + 100);
  assert.ok(retried.last_error);
  assert.doesNotMatch(retried.last_error!.message, /alice|password@|db\.example|top-secret/);
  assert.match(retried.last_error!.message, /REDACTED/);

  now = new Date(FIXED_START.getTime() + 100);
  assert.deepEqual(await service.drain(WORKSPACE_A, "failure-worker"), {
    claimed: 1, completed: 0, retried: 0, dead: 1,
  });
  const dead = await row(enqueued.id);
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, 2);
  assert.equal(calls, 2);
});

test("a stale claim is recovered by a later drain", async () => {
  now = new Date(FIXED_START);
  const claimant = ledger(async () => {});
  const enqueued = await claimant.enqueueObservationIngest(payload(WORKSPACE_A, "stale"));
  assert.ok(enqueued.id);
  assert.equal((await claimant.claim(WORKSPACE_A, "abandoned-worker", 1)).length, 1);

  let calls = 0;
  now = new Date(FIXED_START.getTime() + 1_001);
  const recovery = ledger(async () => { calls += 1; });
  assert.deepEqual(await recovery.drain(WORKSPACE_A, "recovery-worker"), {
    claimed: 1, completed: 1, retried: 0, dead: 0,
  });
  assert.equal(calls, 1);
  assert.equal((await row(enqueued.id)).status, "done");
});

test("workspace-scoped claim cannot claim another tenant's pending job", async () => {
  now = new Date(FIXED_START);
  const service = ledger(async () => {});
  const own = await service.enqueueObservationIngest(payload(WORKSPACE_A, "own"));
  const foreign = await service.enqueueObservationIngest(payload(WORKSPACE_B, "foreign"));
  assert.ok(own.id && foreign.id);

  const claimedA = await service.claim(WORKSPACE_A, "tenant-a-worker", 10);
  assert.deepEqual(claimedA.map((job) => job.id), [own.id]);
  assert.equal((await row(foreign.id)).status, "pending", "tenant B's job remains invisible to tenant A");
  const claimedB = await service.claim(WORKSPACE_B, "tenant-b-worker", 10);
  assert.deepEqual(claimedB.map((job) => job.id), [foreign.id]);
});
