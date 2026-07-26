import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const routePath = new URL("../app/api/v1/internal/target-health/cron/route.ts", import.meta.url);
const vercelPath = new URL("../vercel.json", import.meta.url);

test("target-health Cron is Node-only, authenticated, bounded, and non-cacheable", async () => {
  const source = await readFile(routePath, "utf8");

  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /process\.env\.CRON_SECRET/);
  assert.match(source, /presented\.startsWith\("Bearer "\)/);
  assert.match(source, /timingSafeEqual\(actual, secret\)/);
  assert.match(source, /target_health_due_workspaces\(\$\{WORKSPACE_LIMIT\}\)/);
  assert.match(source, /const WORKSPACE_LIMIT = 25/);
  assert.match(source, /drainTargetHealthRollups\(workspaceId, ROLLUP_LIMIT_PER_WORKSPACE\)/);
  assert.match(source, /drainTargetHealthPublications\(workspaceId, PUBLICATION_LIMIT_PER_WORKSPACE\)/);
  assert.match(source, /for \(const \{ workspace_id: workspaceId \} of rows\)/);
  assert.match(source, /published:/);
  assert.match(source, /noop:/);
  assert.match(source, /dead:/);
  assert.match(source, /contractOk\(InternalContracts\.targetHealthCronResponse/);
});

test("target-health Cron is scheduled every minute without replacing existing Cron entries", async () => {
  const config = JSON.parse(await readFile(vercelPath, "utf8"));
  const health = config.crons.filter((entry) => entry.path === "/api/v1/internal/target-health/cron");

  assert.deepEqual(health, [{ path: "/api/v1/internal/target-health/cron", schedule: "*/1 * * * *" }]);
  assert.ok(config.crons.some((entry) => entry.path === "/api/v1/internal/audit-delivery/cron"));
  assert.ok(config.crons.some((entry) => entry.path === "/api/v1/internal/keys/grace-expiry"));
});
