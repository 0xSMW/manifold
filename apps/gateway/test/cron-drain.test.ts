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

  const failing = createCronDrainHandler({
    getRuntime: async () => {
      throw new Error("postgres://alice:password@db.internal/manifold");
    },
    getSecret: () => "test-cron-secret",
  });
  const response = await failing(cronRequest("Bearer test-cron-secret"));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: false, error: "job drain failed" });
});
