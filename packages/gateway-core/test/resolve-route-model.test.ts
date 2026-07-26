import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot, SnapshotRoute } from "@manifold/ports";
import { legacyPathRouteKey, resolveRoute, routeKey } from "../src/resolveRoute.ts";

function route(routeId: string): SnapshotRoute {
  return {
    routeId,
    revision: `rev_${routeId}`,
    mode: "ordered",
    targets: [],
    timeoutMs: 30_000,
    capturePolicyId: `cap_${routeId}`,
  };
}

function snapshot(routes: Record<string, SnapshotRoute>): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "inst_1",
      revision: "rev_1",
      contentHash: "sha256:x",
      builtAt: "2026-07-24T00:00:00.000Z",
      signature: "sig",
      signingKeyId: "key_1",
    },
    profiles: {},
    keys: {},
    routes,
  };
}

test("resolveRoute selects distinct public models on one endpoint", () => {
  const gpt = route("gpt");
  const claude = route("claude");
  const routes = snapshot({
    [routeKey("profile_1", "chat", "gpt-4o")]: gpt,
    [routeKey("profile_1", "chat", "claude-3")]: claude,
  });

  assert.equal(resolveRoute("profile_1", "chat", "gpt-4o", routes), gpt);
  assert.equal(resolveRoute("profile_1", "chat", "claude-3", routes), claude);
});

test("resolveRoute returns null for a missing public model", () => {
  const routes = snapshot({ [routeKey("profile_1", "chat", "gpt-4o")]: route("gpt") });

  assert.equal(resolveRoute("profile_1", "chat", "missing-model", routes), null);
});

test("resolveRoute keeps same-named models separated by endpoint kind", () => {
  const chat = route("chat");
  const responses = route("responses");
  const routes = snapshot({
    [routeKey("profile_1", "chat", "shared-model")]: chat,
    [routeKey("profile_1", "responses", "shared-model")]: responses,
  });

  assert.equal(resolveRoute("profile_1", "chat", "shared-model", routes), chat);
  assert.equal(resolveRoute("profile_1", "responses", "shared-model", routes), responses);
});

test("resolveRoute falls back to a legacy path-keyed snapshot", () => {
  const legacy = route("legacy-chat");
  const routes = snapshot({ [legacyPathRouteKey("profile_1", "/v1/chat/completions")]: legacy });

  assert.equal(resolveRoute("profile_1", "chat", "gpt-4o", routes), legacy);
});
