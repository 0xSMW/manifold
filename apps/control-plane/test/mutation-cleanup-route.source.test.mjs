import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const routePath = new URL("../app/api/v1/internal/mutation-cleanup/route.ts", import.meta.url);
const vercelPath = new URL("../vercel.json", import.meta.url);
const migrationPath = new URL("../../../packages/database/migrations/0028_mutation_replay_cleanup.sql", import.meta.url);

test("mutation cleanup Cron requires an exact bearer secret and runs a bounded database worker", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /export const runtime = "nodejs"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /const BATCH_LIMIT = 200/);
  assert.match(source, /presented\.startsWith\("Bearer "\)/);
  assert.match(source, /actual\.length === secret\.length && timingSafeEqual\(actual, secret\)/);
  assert.match(source, /contractQuery\(new URL\(req\.url\)\.searchParams, EmptyRequest\)/);
  assert.match(source, /cleanup_expired_mutation_guards\(\$\{BATCH_LIMIT\}\)/);
  assert.match(source, /replayRowsDeleted/);
  assert.match(source, /rateBucketsDeleted/);
  assert.match(source, /contractOk\(InternalContracts\.mutationCleanupResponse/);
  assert.doesNotMatch(source, /CRON_SECRET[^\n]*\breturn ok/);
});

test("mutation cleanup Cron is scheduled without replacing existing jobs", async () => {
  const config = JSON.parse(await readFile(vercelPath, "utf8"));
  assert.deepEqual(config.crons.filter((entry) => entry.path === "/api/v1/internal/mutation-cleanup"), [
    { path: "/api/v1/internal/mutation-cleanup", schedule: "*/5 * * * *" },
  ]);
  assert.ok(config.crons.some((entry) => entry.path === "/api/v1/internal/audit-delivery/cron"));
});

test("cleanup worker migration keeps online indexes and a narrow definer seam", async () => {
  const source = await readFile(migrationPath, "utf8");
  assert.match(source, /NONTRANSACTIONAL MIGRATION/);
  assert.match(source, /CREATE INDEX CONCURRENTLY "mutation_idempotency_cleanup_expiry_idx"/);
  assert.match(source, /CREATE INDEX CONCURRENTLY "mutation_rate_limit_bucket_cleanup_expiry_idx"/);
  assert.match(source, /SET search_path = pg_catalog, public/);
  assert.match(source, /FROM public\.mutation_idempotency/);
  assert.match(source, /FROM public\.mutation_rate_limit_bucket/);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.cleanup_expired_mutation_guards\(integer\) FROM PUBLIC/);
  assert.match(source, /GRANT EXECUTE ON FUNCTION public\.cleanup_expired_mutation_guards\(integer\) TO manifold_app/);
});
