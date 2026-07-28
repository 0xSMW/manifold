import assert from "node:assert/strict";
import test from "node:test";
import { runStorageDrainPass, storageDrainPassStatus } from "../app/api/v1/internal/storage/drain/route";
import { runStorageMeasurementPass, storageMeasurementPassStatus } from "../app/api/v1/internal/storage/measure/route";
import { ManifoldError } from "../lib/http";
import { requireStorageCronAuthorization } from "../lib/storage-scheduler";

test("storage measurement failures emit safe correlated diagnostics while retaining count-only results", async () => {
  const diagnostics: unknown[] = [];
  const result = await runStorageMeasurementPass("req_test", {
    dueWorkspaces: async () => [{ workspaceId: "workspace_test" }],
    measure: async () => {
      throw new Error("postgres://alice:password@db.internal/manifold SELECT * FROM vault");
    },
    reportDiagnostic: (signal) => diagnostics.push(signal),
  });

  assert.deepEqual(result, { workspaces: 1, measured: 0, compactionsQueued: 0, failed: 1 });
  assert.deepEqual(diagnostics, [{
    type: "manifold.storage.measure.failed.v1",
    requestId: "req_test",
    stage: "measure",
    workspaceId: "workspace_test",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /postgres:|password|SELECT|vault/i);
  assert.equal(storageMeasurementPassStatus(result), 503);
});

test("storage drain failures emit safe job context while retaining count-only results", async () => {
  const diagnostics: unknown[] = [];
  const result = await runStorageDrainPass("req_test", {
    dueJobs: async () => [{ jobId: "job_test", workspaceId: "workspace_test" }],
    hasTime: () => true,
    compact: async () => {
      throw new Error("https://provider.example/?api_key=top-secret raw provider body");
    },
    reportDiagnostic: (signal) => diagnostics.push(signal),
  });

  assert.deepEqual(result, {
    discovered: 1,
    done: 0,
    blocked: 0,
    contention: 0,
    incomplete: 0,
    notFound: 0,
    failed: 1,
  });
  assert.deepEqual(diagnostics, [{
    type: "manifold.storage.drain.failed.v1",
    requestId: "req_test",
    stage: "drain",
    workspaceId: "workspace_test",
    jobId: "job_test",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /provider\.example|api_key|top-secret|raw provider/i);
  assert.equal(storageDrainPassStatus(result), 503);
});

test("storage Cron status remains successful for partial and fully successful bounded passes", async () => {
  const measurement = await runStorageMeasurementPass("req_measure_partial", {
    dueWorkspaces: async () => [{ workspaceId: "workspace_ok" }, { workspaceId: "workspace_failed" }],
    measure: async (workspaceId) => {
      if (workspaceId === "workspace_failed") throw new Error("database credentials must remain private");
      return { compactionJobId: null };
    },
    reportDiagnostic: () => {},
  });
  assert.deepEqual(measurement, { workspaces: 2, measured: 1, compactionsQueued: 0, failed: 1 });
  assert.equal(storageMeasurementPassStatus(measurement), 200);
  assert.equal(storageMeasurementPassStatus({ workspaces: 1, measured: 1, compactionsQueued: 0, failed: 0 }), 200);

  const drain = await runStorageDrainPass("req_drain_partial", {
    dueJobs: async () => [{ jobId: "job_ok", workspaceId: "workspace_ok" }, { jobId: "job_failed", workspaceId: "workspace_failed" }],
    hasTime: () => true,
    compact: async (jobId) => {
      if (jobId === "job_failed") throw new Error("provider secret must remain private");
      return { status: "done", beforeBytes: 1, afterBytes: 0, freedBytes: 1 };
    },
    reportDiagnostic: () => {},
  });
  assert.deepEqual(drain, { discovered: 2, done: 1, blocked: 0, contention: 0, incomplete: 0, notFound: 0, failed: 1 });
  assert.equal(storageDrainPassStatus(drain), 200);
  assert.equal(storageDrainPassStatus({ discovered: 1, done: 1, blocked: 0, contention: 0, incomplete: 0, notFound: 0, failed: 0 }), 200);
});

test("storage discovery rejections are safely signaled and converted to a generic envelope error", async () => {
  const diagnostics: unknown[] = [];
  await assert.rejects(
    runStorageMeasurementPass("req_measure", {
      dueWorkspaces: async () => {
        throw new Error("postgres://alice:password@db.internal/manifold SELECT * FROM vault");
      },
      measure: async () => ({ compactionJobId: null }),
      reportDiagnostic: (signal) => diagnostics.push(signal),
    }),
    (error: unknown) => error instanceof ManifoldError
      && error.status === 500
      && error.message === "internal error"
      && error.retryable,
  );
  assert.deepEqual(diagnostics, [{
    type: "manifold.storage.measure.failed.v1",
    requestId: "req_measure",
    stage: "discovery",
  }]);

  const drainDiagnostics: unknown[] = [];
  await assert.rejects(
    runStorageDrainPass("req_drain", {
      dueJobs: async () => {
        throw new Error("postgres://alice:password@db.internal/manifold SELECT * FROM job_ledger");
      },
      hasTime: () => true,
      compact: async () => ({ status: "not_found" }),
      reportDiagnostic: (signal) => drainDiagnostics.push(signal),
    }),
    (error: unknown) => error instanceof ManifoldError
      && error.status === 500
      && error.message === "internal error"
      && error.retryable,
  );
  assert.deepEqual(drainDiagnostics, [{
    type: "manifold.storage.drain.failed.v1",
    requestId: "req_drain",
    stage: "discovery",
  }]);
  assert.doesNotMatch(JSON.stringify([...diagnostics, ...drainDiagnostics]), /postgres:|password|SELECT|vault|job_ledger/i);
});

test("terminal blocked compaction emits a bounded safe blocker signal", async () => {
  const diagnostics: unknown[] = [];
  const result = await runStorageDrainPass("req_test", {
    dueJobs: async () => [{ jobId: "job_test", workspaceId: "workspace_test" }],
    hasTime: () => true,
    compact: async () => ({
      status: "blocked",
      blocker: { code: "RETENTION_PREREQUISITES_MISSING", missing: ["raw provider body"] },
      beforeBytes: 1,
      afterBytes: 1,
      freedBytes: 0,
    }),
    reportDiagnostic: (signal) => diagnostics.push(signal),
  });
  assert.equal(result.blocked, 1);
  assert.deepEqual(diagnostics, [{
    type: "manifold.storage.drain.blocked.v1",
    requestId: "req_test",
    workspaceId: "workspace_test",
    jobId: "job_test",
    blockerCode: "RETENTION_PREREQUISITES_MISSING",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /raw provider/i);
  assert.equal(storageDrainPassStatus(result), 200);
});

test("storage Cron rejects configured secrets with surrounding whitespace", () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = " padded-secret ";
  try {
    assert.throws(
      () => requireStorageCronAuthorization(new Request("https://control-plane.test/internal", {
        headers: { authorization: "Bearer padded-secret" },
      })),
      (error: unknown) => error instanceof ManifoldError && error.status === 403,
    );
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
