import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import type { HotPathObservationEvent, IngestSink, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";

const installationId = "health-identity-installation";
const pepper = new TextEncoder().encode("health-identity-pepper");
const apiKey = "sk-health-identity";

function target(targetId: string, offeringId: string, priority = 0): SnapshotTarget {
  return {
    targetId, offeringId, credentialId: `credential_${targetId}`, dekId: `dek_${targetId}`,
    credentialCiphertext: "", wrappedDek: "", weight: 1, priority,
    baseUrl: `https://${targetId}.provider.test`, region: null,
    allowedHosts: [`${targetId}.provider.test`], authInject: { headers: {} },
  };
}

async function setup(targets: SnapshotTarget[], fetch: GatewayContext["fetcher"]["fetch"]): Promise<{ context: GatewayContext; events: HotPathObservationEvent[] }> {
  const crypto = new FakeCrypto();
  const keyHash = await keyedHashHex(crypto, pepper, apiKey);
  const events: HotPathObservationEvent[] = [];
  const ingest: IngestSink = { emit: async (event) => { events.push(event); } };
  const snapshot: Snapshot = {
    meta: { schema: "manifold.snapshot.v1", installationId, revision: "snapshot_rev_1", contentHash: "sha256:test", builtAt: "2026-07-25T00:00:00.000Z", signature: "", signingKeyId: "signing_key_1" },
    profiles: { "gateway.example.test": { id: "profile_public", mode: "public_app", policyRevision: null, defaultRouteSet: null } },
    keys: { [keyHash]: { id: "key_public", profileId: "profile_public", scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null } },
    routes: {
      "profile_public:chat:public-model": {
        routeId: "route_public", revision: "route_rev_1", mode: "ordered", targets,
        retryPolicy: { max_attempts: 2, backoff_ms: 0 }, timeoutMs: 5_000, capturePolicyId: "capture_none",
      },
    },
    offerings: Object.fromEntries(targets.map((candidate) => [candidate.offeringId, { providerModelId: "provider-model" }])),
  };
  return {
    context: {
      installationId, snapshot, crypto, clock: new FixedClock(), ingest, fetcher: { fetch }, pepper,
      resolveSecret: async () => "provider-secret",
    },
    events,
  };
}

function request(): Request {
  return new Request("https://gateway.example.test/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-model", messages: [] }),
  });
}

async function attemptEvents(events: HotPathObservationEvent[]): Promise<HotPathObservationEvent[]> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  return events.filter((event) => event.kind === "provider_attempt");
}

function assertIdentity(event: HotPathObservationEvent, targetId: string, outcome: string): void {
  assert.equal(event.targetId, targetId);
  assert.equal(event.routeRevisionId, "route_rev_1");
  assert.equal(event.snapshotRevision, "snapshot_rev_1");
  assert.equal(event.attemptOutcome, outcome);
}

test("provider attempt health identity survives success, retry/failover, timeout, and final failure", async (t) => {
  await t.test("success", async () => {
    const { context, events } = await setup([target("target_success", "offering_success")], async () => new Response("ok", { status: 200 }));
    assert.equal((await handleRequest(context, request())).status, 200);
    const attempts = await attemptEvents(events);
    assert.equal(attempts.length, 1);
    assertIdentity(attempts[0]!, "target_success", "success");
  });

  await t.test("retry and failover retain each target identity", async () => {
    let calls = 0;
    const { context, events } = await setup([
      target("target_first", "offering_first"), target("target_second", "offering_second", 1),
    ], async () => {
      calls += 1;
      return new Response(calls === 1 ? "unavailable" : "ok", { status: calls === 1 ? 503 : 200 });
    });
    assert.equal((await handleRequest(context, request())).status, 200);
    const attempts = await attemptEvents(events);
    assert.equal(attempts.length, 2);
    assertIdentity(attempts[0]!, "target_first", "transient_failure");
    assert.deepEqual(attempts[0]!.reasonCodes, ["PROVIDER_HTTP_5XX", "RETRY_ATTEMPT", "FAILOVER_ATTEMPT"]);
    assertIdentity(attempts[1]!, "target_second", "success");
  });

  await t.test("timeout is transient and a final HTTP 4xx is permanent", async () => {
    const timeout = await setup([target("target_timeout", "offering_timeout")], async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    assert.equal((await handleRequest(timeout.context, request())).status, 504);
    assertIdentity((await attemptEvents(timeout.events))[0]!, "target_timeout", "transient_failure");

    const permanent = await setup([target("target_permanent", "offering_permanent")], async () => new Response("invalid", { status: 400 }));
    assert.equal((await handleRequest(permanent.context, request())).status, 400);
    assertIdentity((await attemptEvents(permanent.events))[0]!, "target_permanent", "permanent_failure");
  });
});
