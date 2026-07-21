// Regression test: resolveProfile / normalizeHost must strip the port from a bracketed IPv6 Host
// header before the exact-match snapshot lookup (ADR-0001: profile is bound to the trusted host,
// resolved pre-auth). A correctly-keyed IPv6 profile (keyed by the bracketed literal WITHOUT a
// port) must resolve even when the inbound Host carries `[::1]:8443` — the bug left the port
// attached, so the lookup key never matched and the request 404'd as PROFILE_UNKNOWN.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot, SnapshotProfile } from "@manifold/ports";
import { normalizeHost, resolveProfile } from "../src/resolveProfile.ts";

const profile: SnapshotProfile = {
  id: "profile_ipv6",
  mode: "enterprise_egress",
  policyRevision: null,
  defaultRouteSet: null,
};

function snapshotWithProfile(key: string): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "inst_1",
      revision: "rev_1",
      contentHash: "sha256:x",
      builtAt: "2026-07-21T00:00:00.000Z",
      signature: "sig",
      signingKeyId: "key_1",
    },
    profiles: { [key]: profile },
    keys: {},
    routes: {},
  };
}

test("normalizeHost strips the port from a bracketed IPv6 host", () => {
  assert.equal(normalizeHost("[::1]:8443"), "[::1]");
  assert.equal(normalizeHost("[2001:db8::1]:443"), "[2001:db8::1]");
});

test("normalizeHost leaves a bracketed IPv6 host with no port untouched", () => {
  assert.equal(normalizeHost("[::1]"), "[::1]");
});

test("resolveProfile finds an IPv6-keyed profile even when the inbound Host carries a port", () => {
  const snapshot = snapshotWithProfile("[::1]");
  const resolved = resolveProfile("[::1]:8443", snapshot);
  assert.notEqual(resolved, null);
  assert.equal(resolved?.profileId, "profile_ipv6");
});

test("resolveProfile still returns null for a genuinely unknown IPv6 host", () => {
  const snapshot = snapshotWithProfile("[::1]");
  const resolved = resolveProfile("[::2]:8443", snapshot);
  assert.equal(resolved, null);
});
