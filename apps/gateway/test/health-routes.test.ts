import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealthHandler, GET as health } from "../api/health.ts";
import { createReadinessHandler, GET as ready, vercelDeploymentProvenance } from "../api/ready.ts";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function runtime(overrides: Partial<{ installationId: string; revision: string; builtAt: string; verifiedAtMs: number }> = {}) {
  const installationId = overrides.installationId ?? "installation_test";
  let loadedFor: string | undefined;
  let admissionChecks = 0;
  return {
    state: {
      installationId,
      async checkReady() {
        admissionChecks += 1;
      },
      snapshots: {
        async checkReady(id: string) {
          loadedFor = id;
          return {
            snapshot: {
              meta: {
                installationId,
                revision: overrides.revision ?? "snapshot-r17",
                builtAt: overrides.builtAt ?? "2026-07-01T00:00:00.000Z",
              },
            },
            verifiedAtMs: overrides.verifiedAtMs ?? NOW - 30_000,
          };
        },
      },
    },
    loadedFor: () => loadedFor,
    admissionChecks: () => admissionChecks,
  };
}

test("liveness is dependency-free and never cacheable", async () => {
  const response = await createHealthHandler()(new Request("https://gateway.test/api/health"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await health(new Request("https://gateway.test/api/health"))).status, 200);
});

test("readiness uses the last verified fetch rather than an unchanged snapshot publication time", async () => {
  const fixture = runtime();
  const response = await createReadinessHandler({
    getRuntime: async () => fixture.state,
    now: () => NOW,
    provenance: () => ({ deploymentId: "dpl_gateway_1", sourceRevision: "a1b2c3d4" }),
  })(new Request("https://gateway.test/api/ready"));

  assert.equal(fixture.loadedFor(), "installation_test");
  assert.equal(fixture.admissionChecks(), 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-manifold-deployment-id"), "dpl_gateway_1");
  assert.equal(response.headers.get("x-manifold-source-revision"), "a1b2c3d4");
  assert.deepEqual(await response.json(), {
    ok: true,
    snapshot: {
      revision: "snapshot-r17",
      verifiedAt: "2026-07-24T11:59:30.000Z",
      ageMs: 30_000,
    },
  });
});

test("readiness emits no provenance when trusted Vercel metadata is absent or malformed", async () => {
  assert.equal(vercelDeploymentProvenance({}), null);
  assert.equal(vercelDeploymentProvenance({ VERCEL_DEPLOYMENT_ID: "dpl_ok", VERCEL_GIT_COMMIT_SHA: "not a sha" }), null);
  assert.deepEqual(
    vercelDeploymentProvenance({ VERCEL_DEPLOYMENT_ID: "dpl_ok", VERCEL_GIT_COMMIT_SHA: "A1B2C3D4" }),
    { deploymentId: "dpl_ok", sourceRevision: "a1b2c3d4" },
  );
});

test("readiness rejects malformed snapshot verification results without exposing failure details", async () => {
  for (const fixture of [
    runtime({ revision: "" }),
    runtime({ verifiedAtMs: NOW + 1 }),
  ]) {
    const response = await createReadinessHandler({
      getRuntime: async () => fixture.state,
      now: () => NOW,
    })(new Request("https://gateway.test/api/ready"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
  }
});

test("readiness converts snapshot or durable dependency failures to a generic unavailable response", async () => {
  const unavailableSnapshot = runtime();
  unavailableSnapshot.state.snapshots.checkReady = async () => {
    throw new Error("control plane unavailable");
  };
  const snapshotResponse = await createReadinessHandler({
    getRuntime: async () => unavailableSnapshot.state,
  })(new Request("https://gateway.test/api/ready"));
  assert.equal(snapshotResponse.status, 503);

  const warmDbFailure = runtime();
  warmDbFailure.state.checkReady = async () => {
    throw new Error("postgres://user:password@host/private-db");
  };
  const response = await createReadinessHandler({
    getRuntime: async () => warmDbFailure.state,
  })(new Request("https://gateway.test/api/ready"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
  assert.equal((await ready(new Request("https://gateway.test/api/ready"))).status, 503);
});
