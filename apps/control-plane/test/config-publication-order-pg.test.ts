// Real-Postgres ordering regression for the control-plane publication worker.  It deliberately
// blocks the first external PATCH, then tries to activate a second revision: activation must wait
// behind the installation publication lock, so the external history can only be A then B.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { apply, type ConfigSnapshot, type Plan, type SnapshotPublishStore } from "@manifold/config";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;
let reconcile: (workspaceId: string, operationId: string) => Promise<unknown>;
let storeFor: (snapshot?: ConfigSnapshot) => SnapshotPublishStore | null;
let enqueueKeyPublication: (sql: PgHarness["sql"], workspaceId: string, installationId: string) => Promise<void>;

function snapshot(revision: string, contentHash: string): ConfigSnapshot {
  return { meta: { schema: "manifold.snapshot.v1", installationId: "inst_order", revision, contentHash, builtAt: "2026-07-25T00:00:00.000Z", signature: `sig-${revision}`, signingKeyId: "test" }, profiles: {}, keys: {}, routes: {}, offerings: {}, policies: {}, budgets: {} };
}

function plan(target: ConfigSnapshot, baseConfigHash: string | null): Plan {
  return { installationId: "inst_order", workspaceId: "ws_order", baseConfigHash, targetConfigHash: target.meta.contentHash, planHash: `plan-${target.meta.revision}`, diffJson: { routes: { added: [], removed: [], changed: [] }, keys: { added: [], removed: [], changed: [] }, offerings: { added: [], removed: [], changed: [] }, policies: { added: [], removed: [], changed: [] }, budgets: { added: [], removed: [], changed: [] } }, tripwireItems: [], snapshot: target, noop: false };
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-config-publication-order", poolSize: 8 });
  process.env.DATABASE_URL = pg.url;
  process.env.MANIFOLD_EDGE_CONFIG_ID = "edge-test";
  process.env.MANIFOLD_EDGE_CONFIG_WRITE_TOKEN = "write-test";
  ({
    reconcileConfigOperation: reconcile,
    snapshotStore: storeFor,
    enqueueKeyPublication,
  } = await import("../lib/snapshot.ts"));
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_order','order','Order','local');
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity)
    VALUES ('inst_order','ws_order','Order','{}');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("an older external publication cannot land after a newer active revision", { timeout: 30_000 }, async () => {
  const a = snapshot("cfgrev_order_a", "sha256:order-a");
  const b = snapshot("cfgrev_order_b", "sha256:order-b");
  const publications: string[] = [];
  let remoteRevision: string | null = null;
  let releaseFirst!: () => void;
  const firstPatch = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let sawFirstPatch!: () => void;
  const firstPatchStarted = new Promise<void>((resolve) => { sawFirstPatch = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && url.endsWith("/items")) {
      const body = JSON.parse(String(init.body)) as { items: Array<{ key: string; value: { revision?: string } }> };
      const revision = body.items.find((item) => item.key.startsWith("active_"))?.value.revision;
      assert.ok(revision);
      publications.push(revision);
      if (publications.length === 1) {
        sawFirstPatch();
        await firstPatch;
      }
      remoteRevision = revision;
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/item/active_")) return new Response(JSON.stringify(remoteRevision ? { revision: remoteRevision } : {}));
    return new Response(JSON.stringify({ digest: `digest-${remoteRevision ?? "none"}` }));
  }) as typeof fetch;
  try {
    const store = storeFor(a);
    assert.ok(store);
    const opA = await apply(pg.sql, plan(a, null), store);
    const publishingA = reconcile("ws_order", opA.id);
    await firstPatchStarted;

    let bSettled = false;
    const applyingB = apply(pg.sql, plan(b, a.meta.contentHash), store).then((op) => { bSettled = true; return op; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(bSettled, false, "the newer activation must wait until the older external write is fenced");

    releaseFirst();
    await publishingA;
    const opB = await applyingB;
    await reconcile("ws_order", opB.id);
    assert.deepEqual(publications, ["cfgrev_order_a", "cfgrev_order_b"]);
    const [active] = await pg.sql<{ id: string }[]>`SELECT id FROM gateway_config_revision WHERE installation_id='inst_order' AND status='active'`;
    assert.equal(active?.id, "cfgrev_order_b");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovery selector includes pending and reclaimable coalesced key publication jobs", async () => {
  await pg.sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, claimed_at, created_at, updated_at)
    VALUES
      ('job_key_recovery_pending','ws_order','config_key_publish',${pg.sql.json({ installationId: 'inst_order' })},'key-recovery-pending','pending',0,NULL,now(),now()),
      ('job_key_recovery_stale','ws_order','config_key_publish',${pg.sql.json({ installationId: 'inst_stale' })},'key-recovery-stale','claimed',1,now()-interval '61 seconds',now(),now())`;
  const rows = await pg.sql<{ workspace_id: string; installation_id: string }[]>`
    SELECT workspace_id, installation_id FROM claim_config_key_publication_recovery(20)`;
  assert.deepEqual(Array.from(rows), [
    { workspace_id: 'ws_order', installation_id: 'inst_order' },
    { workspace_id: 'ws_order', installation_id: 'inst_stale' },
  ]);
});

test("key-publication enqueue types the conflicting installation id for jsonb payload generation", async () => {
  await enqueueKeyPublication(pg.sql, "ws_order", "inst_enqueue_typed");
  await enqueueKeyPublication(pg.sql, "ws_order", "inst_enqueue_typed");

  const [job] = await pg.sql<{ payload: { installationId: string; generation?: number }; status: string }[]>`
    SELECT payload, status FROM job_ledger
    WHERE kind='config_key_publish' AND idempotency_key='config_key_publish:inst_enqueue_typed'`;
  assert.deepEqual(job, {
    payload: { installationId: "inst_enqueue_typed", generation: 1 },
    status: "pending",
  });
});

test("recovery retires stale operations before its batch limit and selects only the newest active operation", async () => {
  await pg.sql`
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity)
    VALUES ('inst_recovery','ws_order','Recovery','{}')`;
  await pg.sql`
    INSERT INTO gateway_config_revision (id, workspace_id, installation_id, content_hash, snapshot, status, created_at)
    VALUES
      ('cfgrev_recovery_stale','ws_order','inst_recovery','sha256:recovery-stale','{}','superseded',now()-interval '4 minutes'),
      ('cfgrev_recovery_active','ws_order','inst_recovery','sha256:recovery-active','{}','active',now()-interval '2 minutes')`;
  await pg.sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, diff_json, outcome, revision_id, accelerator_status, created_at)
    SELECT 'cfgop_recovery_stale_' || n, 'ws_order', 'inst_recovery', '{}', 'accepted',
           'cfgrev_recovery_stale', 'reconciliation_required', now() - (n + 10) * interval '1 second'
    FROM generate_series(1, 25) AS n`;
  await pg.sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, diff_json, outcome, revision_id, accelerator_status, created_at)
    VALUES
      ('cfgop_recovery_active_old','ws_order','inst_recovery','{}','accepted','cfgrev_recovery_active','pending',now()-interval '90 seconds'),
      ('cfgop_recovery_active_new','ws_order','inst_recovery','{}','accepted','cfgrev_recovery_active','reconciliation_required',now()-interval '30 seconds')`;
  await pg.sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    SELECT 'job_recovery_stale_' || n, 'ws_order', 'config_publish_reconcile',
           jsonb_build_object('operationId', 'cfgop_recovery_stale_' || n),
           'config_publish:cfgop_recovery_stale_' || n, 'pending', 0, now(), now()
    FROM generate_series(1, 25) AS n`;

  const selected = await pg.sql<{ workspace_id: string; operation_id: string }[]>`
    SELECT workspace_id, operation_id FROM claim_config_publication_recovery(1)`;
  assert.deepEqual(Array.from(selected), [
    { workspace_id: 'ws_order', operation_id: 'cfgop_recovery_active_new' },
  ]);

  const terminalized = await pg.sql<{ operations: string; jobs: string }[]>`
    SELECT
      (SELECT count(*)::text FROM config_operation WHERE id LIKE 'cfgop_recovery_stale_%' AND accelerator_status = 'superseded') AS operations,
      (SELECT count(*)::text FROM job_ledger WHERE id LIKE 'job_recovery_stale_%' AND status = 'superseded') AS jobs`;
  assert.deepEqual(terminalized[0], { operations: '25', jobs: '25' });
});

test("direct reconciliation terminalizes an operation whose revision was superseded", async () => {
  await pg.sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, diff_json, outcome, revision_id, accelerator_status)
    VALUES ('cfgop_recovery_direct_stale','ws_order','inst_recovery','{}','accepted','cfgrev_recovery_stale','pending')`;
  await pg.sql`
    INSERT INTO job_ledger (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES ('job_recovery_direct_stale','ws_order','config_publish_reconcile',
      ${pg.sql.json({ operationId: 'cfgop_recovery_direct_stale', installationId: 'inst_recovery' })},
      'config_publish:cfgop_recovery_direct_stale','pending',0,now(),now())`;

  await assert.rejects(
    reconcile('ws_order', 'cfgop_recovery_direct_stale'),
    { code: 'CONFIG_PRECONDITION_FAILED' },
  );
  const [state] = await pg.sql<{ accelerator_status: string; job_status: string }[]>`
    SELECT o.accelerator_status, j.status AS job_status
    FROM config_operation o
    JOIN job_ledger j ON j.workspace_id = o.workspace_id
      AND j.idempotency_key = 'config_publish:' || o.id
    WHERE o.id = 'cfgop_recovery_direct_stale'`;
  assert.deepEqual(state, { accelerator_status: 'superseded', job_status: 'superseded' });
});
