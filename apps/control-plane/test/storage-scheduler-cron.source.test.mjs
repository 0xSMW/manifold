import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const base = new URL("../app/api/v1/internal/storage/", import.meta.url);
const configPath = new URL("../vercel.json", import.meta.url);

test("storage Cron routes are Node-only, bearer-authenticated, bounded, and count-only on worker errors", async () => {
  const [auth, measure, drain, direct, schedules] = await Promise.all([
    readFile(new URL("../../../../../lib/storage-scheduler.ts", base), "utf8"),
    readFile(new URL("measure/route.ts", base), "utf8"),
    readFile(new URL("drain/route.ts", base), "utf8"),
    readFile(new URL("../storage-compact/route.ts", base), "utf8"),
    readFile(new URL("../../../../../lib/storage-scheduler-routes.ts", base), "utf8"),
  ]);
  assert.match(auth, /process\.env\.CRON_SECRET/);
  assert.match(auth, /presented\.startsWith\("Bearer "\)/);
  assert.match(auth, /timingSafeEqual\(actual, secret\)/);
  assert.match(auth, /STORAGE_SCHEDULER_WORKSPACE_LIMIT = 1/);
  assert.match(auth, /STORAGE_SCHEDULER_DRAIN_LIMIT = 1/);
  assert.match(auth, /STORAGE_SCHEDULER_DRAIN_BUDGET_MS = 50_000/);
  assert.match(measure, /export const runtime = "nodejs"/);
  assert.match(measure, /runDirectStorageMeasurement\(workspaceId\)/);
  assert.match(measure, /storage_scheduler_due_workspaces/);
  assert.match(measure, /catch \{/);
  assert.doesNotMatch(measure, /error\.message|console\.error/);
  assert.match(drain, /runDirectCompaction\(jobId, workspaceId/);
  assert.match(drain, /storage_compaction_due_jobs/);
  assert.match(drain, /storageSchedulerHasTime\(deadline\)/);
  assert.match(drain, /catch \{/);
  assert.match(direct, /deadline:\s*Date\.now\(\)\s*\+\s*DIRECT_COMPACTION_BUDGET_MS/);
  assert.match(direct, /maxClosedHours:\s*1/);
  assert.match(direct, /maxPartitions:\s*1/);
  assert.match(direct, /maxMaintenanceBatches:\s*1/);
  assert.match(schedules, /enqueue_storage_compaction_schedule/);
  assert.match(schedules, /rows\.filter\(\(row\) => row\.enqueued\)/);
  assert.match(schedules, /contractQuery\(new URL\(req\.url\)\.searchParams, InternalContracts\.emptyQuery\)/);
});

test("storage schedules preserve all existing crons and declare measurement, cadence triggers, and a frequent drain", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const expected = [
    ["/api/v1/internal/storage/drain", "*/1 * * * *"],
    ["/api/v1/internal/storage/measure", "*/15 * * * *"],
    ["/api/v1/internal/storage/compact/hourly", "0 * * * *"],
    ["/api/v1/internal/storage/compact/daily", "10 0 * * *"],
    ["/api/v1/internal/storage/compact/monthly", "30 0 1 * *"],
  ];
  for (const [path, schedule] of expected) assert.ok(config.crons.some((entry) => entry.path === path && entry.schedule === schedule));
  assert.ok(config.crons.some((entry) => entry.path === "/api/v1/internal/target-health/cron"));
  assert.equal(config.functions["app/api/v1/internal/storage/drain/route.ts"].maxDuration, 60);
  assert.equal(config.functions["app/api/v1/internal/storage-compact/route.ts"].maxDuration, 30);
});
