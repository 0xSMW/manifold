// Route-level guard contracts. The implementation behavior (24h durable replay, changed-body
// conflict, and fixed-window limits) is exercised against Postgres in mutation-guard-pg.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../app/api/v1/config/", import.meta.url);

function source(family) {
  return readFileSync(new URL(`${family}/route.ts`, root), "utf8");
}

test("every config mutation family uses a durable guard with an explicit rate limit", () => {
  const routes = {
    apply: "runPostCommitMutationGuard",
    approvals: "runMutationGuard",
    reconcile: "runPostCommitMutationGuard",
    rollback: "runPostCommitMutationGuard",
  };

  for (const [family, guard] of Object.entries(routes)) {
    const text = source(family);
    assert.match(text, new RegExp(`return ${guard}\\(\\{`));
    assert.match(text, /rateLimit: \{ limit: \d+, windowMs: 60_000 \}/);
  }
});

test("publication-affecting families keep the post-commit guard boundary", () => {
  for (const family of ["apply", "reconcile", "rollback"]) {
    assert.match(source(family), /runPostCommitMutationGuard/);
  }
  assert.doesNotMatch(source("approvals"), /runPostCommitMutationGuard/);
});

test("key mutations enqueue in the guarded transaction and dispatch only after commit", () => {
  const keyRoot = new URL("../app/api/v1/keys/", import.meta.url);
  for (const file of ["route.ts", "[id]/rotate/route.ts", "[id]/revoke/route.ts"]) {
    const text = readFileSync(new URL(file, keyRoot), "utf8");
    assert.match(text, /enqueueKeyPublication\(sql,/);
    assert.match(text, /afterCommit: async \(\) =>/);
    assert.match(text, /drainKeyPublication/);
    assert.doesNotMatch(text, /await publishKeysOnly\(/);
  }
});

test("publication reclaims are fenced and observe the pointer before an external publish", () => {
  const snapshot = readFileSync(new URL("../lib/snapshot.ts", import.meta.url), "utf8");
  assert.match(snapshot, /claimed_by = \$\{fence\}/);
  assert.match(snapshot, /publishStore\.pointer\(row\.installation_id,\s*\{\s*signal\s*\}\)/);
  assert.match(snapshot, /pointer\?\.revision === row\.revision_id/);
  assert.match(snapshot, /const PUBLICATION_REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(snapshot, /const PUBLICATION_LEASE_SECONDS = 60/);
  assert.match(snapshot, /AbortSignal\.timeout\(PUBLICATION_REQUEST_TIMEOUT_MS\)/);
});

test("rollback reports persisted operation publication state", () => {
  const rollback = source("rollback");
  assert.match(rollback, /SELECT serving_mode, accelerator_status, edge_config_version FROM config_operation/);
  assert.match(rollback, /servingMode: publication\?\.serving_mode/);
  assert.doesNotMatch(rollback, /servingMode: publishStore \? "edge_config"/);
});
