import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeRequestDrain,
  requestDrainFailureOperationalSignal,
} from "../src/vercelRuntime.ts";

test("request-triggered drain rejection emits a secret-safe structured diagnostic", async () => {
  const diagnostics: unknown[] = [];
  await observeRequestDrain(
    Promise.reject(new Error("postgres://user:password@db.internal:5432/manifold?sslmode=require")),
    "workspace_test",
    "installation_test",
    "gateway:iad1:worker_test",
    (workspaceId, installationId, workerId) => diagnostics.push(
      requestDrainFailureOperationalSignal(workspaceId, installationId, workerId),
    ),
  );

  assert.deepEqual(diagnostics, [{
    type: "manifold.gateway.request_drain.failed.v1",
    workspaceId: "workspace_test",
    installationId: "installation_test",
    workerId: "gateway:iad1:worker_test",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /postgres:|password|db\.internal/i);
});
