import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "./pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-storage-scheduler", poolSize: 4 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_schedule_a','schedule-a','Schedule A','local');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("scheduler is local to its one ADR-0021 workspace database and hourly enqueue is duplicate-safe", async () => {
  const discovered = await pg.sql<{ workspace_id: string }[]>`SELECT workspace_id FROM storage_scheduler_due_workspaces(1)`;
  assert.deepEqual([...discovered], [{ workspace_id: "ws_schedule_a" }]);

  const first = await pg.sql<{ workspace_id: string; enqueued: boolean }[]>`
    SELECT workspace_id, enqueued FROM enqueue_storage_compaction_schedule('hourly', 25)`;
  assert.deepEqual(first.map((row) => row.enqueued), [true]);
  const second = await pg.sql<{ workspace_id: string; enqueued: boolean }[]>`
    SELECT workspace_id, enqueued FROM enqueue_storage_compaction_schedule('hourly', 25)`;
  assert.deepEqual(second.map((row) => row.enqueued), [false]);
  const jobs = await pg.sql<{ workspace_id: string; count: number }[]>`
    SELECT workspace_id, count(*)::int AS count FROM job_ledger
    WHERE kind='storage.compact' GROUP BY workspace_id ORDER BY workspace_id`;
  assert.deepEqual([...jobs], [{ workspace_id: "ws_schedule_a", count: 1 }]);
});

test("scheduler fails closed if a database violates the one-workspace topology", async () => {
  await pg.sql`INSERT INTO workspace (id, slug, name, region) VALUES ('ws_schedule_invalid','schedule-invalid','Invalid','local')`;
  await assert.rejects(
    () => pg.sql`SELECT workspace_id FROM storage_scheduler_due_workspaces(1)`,
    /database violates ADR-0021 one-workspace scheduler invariant/,
  );
  await pg.sql`DELETE FROM workspace WHERE id = 'ws_schedule_invalid'`;
});

test("due-job discovery preserves the job/workspace identity and excludes unrelated tenant work", async () => {
  await pg.sql`INSERT INTO job_ledger (id, workspace_id, kind, payload, status, run_after, idempotency_key)
    VALUES
      ('job_storage_schedule_due','ws_schedule_a','storage.compact','{}','pending',now(),'scheduler-storage-due'),
      ('job_non_storage','ws_schedule_a','audit_delivery','{}','pending',now(),'scheduler-unrelated')`;
  const due = await pg.sql<{ job_id: string; workspace_id: string }[]>`
    SELECT job_id, workspace_id FROM storage_compaction_due_jobs(20) ORDER BY workspace_id`;
  assert.ok(due.length >= 1);
  assert.ok(due.every((row) => row.workspace_id === "ws_schedule_a"));
  assert.ok(due.some((row) => row.job_id === "job_storage_schedule_due"));
  assert.ok(due.every((row) => row.job_id.startsWith("job_storage_schedule_")));
});

test("scheduler definer seams are executable only by manifold_app and cap discovery input", async () => {
  const grants = await pg.sql<{ routine_name: string; grantee: string }[]>`
    SELECT routine_name, grantee FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name IN
      ('storage_scheduler_workspace_id','storage_scheduler_due_workspaces','enqueue_storage_compaction_schedule','storage_compaction_due_jobs')
    ORDER BY routine_name, grantee`;
  assert.ok(grants.some((row) => row.grantee === "manifold_app"));
  assert.ok(!grants.some((row) => row.grantee === "PUBLIC"));
  await assert.rejects(() => pg.sql`SELECT * FROM storage_scheduler_due_workspaces(101)`, /p_limit must be between 1 and 100/);
});
