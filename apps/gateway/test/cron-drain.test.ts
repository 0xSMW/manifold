import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCronDrainHandler,
  isAuthorizedCronRequest,
  type CronDrainRuntime,
} from "../api/internal/jobs/drain.ts";

const cronRequest = (authorization?: string) =>
  new Request("https://gateway.test/api/internal/jobs/drain", {
    headers: authorization ? { authorization } : undefined,
  });

test("cron drain accepts only the documented exact Bearer CRON_SECRET credential", () => {
  const secret = "test-cron-secret";
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer ${secret}`), secret), true);
  assert.equal(isAuthorizedCronRequest(cronRequest(), secret), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`bearer ${secret}`), secret), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer  ${secret}`), secret), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer ${secret}x`), secret), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer ${secret}`), undefined), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer ${secret}`), " "), false);
  assert.equal(isAuthorizedCronRequest(cronRequest(`Bearer ${secret}`), ` ${secret}`), false);
});

test("cron drain invokes one bounded ledger pass and returns non-cacheable JSON", async () => {
  let calls = 0;
  const diagnostics: unknown[] = [];
  const runtime: CronDrainRuntime = {
    workspaceId: "workspace_test",
    ledger: {
      async drain(workspaceId, workerId, batchSize) {
        calls += 1;
        assert.equal(workspaceId, "workspace_test");
        assert.equal(workerId, "cron-test-worker");
        assert.equal(batchSize, 100);
        return { claimed: 2, completed: 1, retried: 1, dead: 0 };
      },
    },
  };
  const handler = createCronDrainHandler({
    getRuntime: async () => runtime,
    getSecret: () => "test-cron-secret",
    workerId: () => "cron-test-worker",
    reportDiagnostic: (signal) => diagnostics.push(signal),
  });

  const response = await handler(cronRequest("Bearer test-cron-secret"));

  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    claimed: 2,
    completed: 1,
    retried: 1,
    dead: 0,
  });
  assert.deepEqual(diagnostics, [{
    type: "manifold.gateway.job_drain.completed.v1",
    workspaceId: "workspace_test",
    workerId: "cron-test-worker",
    claimed: 2,
    completed: 1,
    retried: 1,
    dead: 0,
  }]);
});

test("cron drain rejects before runtime initialization and returns a generic non-cacheable failure", async () => {
  let initialized = false;
  const unauthenticated = createCronDrainHandler({
    getRuntime: async () => {
      initialized = true;
      throw new Error("should not run");
    },
    getSecret: () => "test-cron-secret",
  });
  const unauthorized = await unauthenticated(cronRequest("Bearer wrong"));
  assert.equal(initialized, false);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("cache-control"), "no-store");

  const runtimeDiagnostics: unknown[] = [];
  const failing = createCronDrainHandler({
    getRuntime: async () => {
      throw new Error("postgres://alice:password@db.internal/manifold");
    },
    getSecret: () => "test-cron-secret",
    reportDiagnostic: (signal) => runtimeDiagnostics.push(signal),
  });
  const response = await failing(cronRequest("Bearer test-cron-secret"));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false, error: "job drain failed" });
  assert.deepEqual(runtimeDiagnostics, [{
    type: "manifold.gateway.job_drain.failed.v1",
    stage: "runtime",
  }]);
  assert.doesNotMatch(JSON.stringify(runtimeDiagnostics), /postgres:|password|db\.internal/i);
});

test("cron drain failure emits only safe worker context while preserving the generic client error", async () => {
  const diagnostics: unknown[] = [];
  const handler = createCronDrainHandler({
    getRuntime: async () => ({
      workspaceId: "workspace_test",
      ledger: {
        async drain() {
          throw new Error("SELECT * FROM secret_credentials WHERE password = 'not-for-logs'");
        },
      },
    }),
    getSecret: () => "test-cron-secret",
    workerId: () => "cron-test-worker",
    reportDiagnostic: (signal) => diagnostics.push(signal),
  });

  const response = await handler(cronRequest("Bearer test-cron-secret"));

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: "job drain failed" });
  assert.deepEqual(diagnostics, [{
    type: "manifold.gateway.job_drain.failed.v1",
    stage: "drain",
    workspaceId: "workspace_test",
    workerId: "cron-test-worker",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SELECT|password|not-for-logs/i);
});
