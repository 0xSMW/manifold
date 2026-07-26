import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTarget } from "../src/selectTarget.ts";
import type { SnapshotRoute, SnapshotTarget } from "@manifold/ports";

function target(id: string, healthState?: SnapshotTarget["healthState"]): SnapshotTarget {
  return {
    offeringId: id,
    credentialId: `cred_${id}`,
    dekId: `dek_${id}`,
    credentialCiphertext: "",
    wrappedDek: "",
    weight: 1,
    priority: id === "unhealthy" ? 0 : 1,
    ...(healthState ? { healthState } : {}),
    baseUrl: "https://provider.example",
    region: null,
    allowedHosts: ["provider.example"],
    authInject: { headers: {} },
  };
}

function route(targets: SnapshotTarget[]): SnapshotRoute {
  return {
    routeId: "route",
    revision: "revision",
    mode: "ordered",
    targets,
    timeoutMs: 1_000,
    capturePolicyId: "capture",
  };
}

test("selection skips explicitly unhealthy targets", () => {
  const selected = selectTarget(route([
    target("unhealthy", "unhealthy"),
    target("healthy", "healthy"),
  ]));
  assert.equal(selected?.offeringId, "healthy");
});

test("selection returns null when every target is unhealthy", () => {
  assert.equal(selectTarget(route([target("unhealthy", "unhealthy")])), null);
});
