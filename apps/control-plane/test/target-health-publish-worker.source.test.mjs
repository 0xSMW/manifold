import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const workerPath = new URL("../lib/target-health-publish.ts", import.meta.url);

test("target-health publication worker uses bounded fenced RLS claims and capped retry", async () => {
  const source = await readFile(workerPath, "utf8");

  assert.match(source, /withWorkspace\(workspaceId/);
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /randomUUID\(\)/);
  assert.match(source, /claimed_at <= now\(\) - \$\{TARGET_HEALTH_PUBLICATION_LEASE_SECONDS\}/);
  assert.match(source, /attempts >= max_attempts/);
  assert.match(source, /attempts < max_attempts/);
  assert.match(source, /claimed_by = \$\{job\.claimed_by\}/);
  assert.match(source, /Math\.min\(MAX_BACKOFF_SECONDS, 5 \* 2 \*\*/);
  assert.match(source, /TARGET_HEALTH_PUBLICATION_LIMIT = 25/);
});

test("target-health publication worker treats null as a successful no-op and accepts durable hand-off", async () => {
  const source = await readFile(workerPath, "utf8");

  assert.match(source, /publishHealthOnly\(workspaceId, job\.installation_id\)/);
  assert.match(source, /operation === null\) result\.noop \+= 1/);
  assert.match(source, /operation\.outcome === "accepted"\) result\.published \+= 1/);
  assert.match(source, /TARGET_HEALTH_PUBLICATION_FAILED/);
  assert.match(source, /published: 0, noop: 0, retried: 0, dead: 0/);
});
