import assert from "node:assert/strict";
import { test } from "node:test";
import { createHealthHandler, GET as health } from "../api/health.ts";
import { createReadinessHandler, GET as ready } from "../api/ready.ts";

const NOW = Date.parse("2026-07-24T12:00:00.000Z");

function runtime(overrides: Partial<{ installationId: string; revision: string; builtAt: string }> = {}) {
  const installationId = overrides.installationId ?? "installation_test";
  let loadedFor: string | undefined;
  return {
    state: {
      installationId,
      snapshots: {
        async loadActive(id: string) {
          loadedFor = id;
          return {
            meta: {
              installationId,
              revision: overrides.revision ?? "snapshot-r17",
              builtAt: overrides.builtAt ?? "2026-07-24T11:59:30.000Z",
            },
          };
        },
      },
    },
    loadedFor: () => loadedFor,
  };
}

test("liveness is dependency-free and never cacheable", async () => {
  const response = await createHealthHandler()(new Request("https://gateway.test/api/health"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await health(new Request("https://gateway.test/api/health"))).status, 200);
});

test("readiness loads the active snapshot for the runtime installation and exposes safe metadata", async () => {
  const fixture = runtime();
  const response = await createReadinessHandler({
    getRuntime: async () => fixture.state,
    now: () => NOW,
    maxSnapshotAgeMs: 60_000,
  })(new Request("https://gateway.test/api/ready"));

  assert.equal(fixture.loadedFor(), "installation_test");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    snapshot: {
      revision: "snapshot-r17",
      builtAt: "2026-07-24T11:59:30.000Z",
      ageMs: 30_000,
    },
  });
});

test("readiness rejects stale or malformed snapshot metadata without exposing failure details", async () => {
  for (const fixture of [
    runtime({ builtAt: "2026-07-24T11:58:59.999Z" }),
    runtime({ builtAt: "not-a-date" }),
    runtime({ revision: "" }),
  ]) {
    const response = await createReadinessHandler({
      getRuntime: async () => fixture.state,
      now: () => NOW,
      maxSnapshotAgeMs: 60_000,
    })(new Request("https://gateway.test/api/ready"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
  }
});

test("readiness converts dependency failures to a generic unavailable response", async () => {
  const response = await createReadinessHandler({
    getRuntime: async () => {
      throw new Error("postgres://user:password@host/private-db");
    },
  })(new Request("https://gateway.test/api/ready"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
  assert.equal((await ready(new Request("https://gateway.test/api/ready"))).status, 503);
});
