import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { buildSnapshot } from "../../../packages/config/src/index.ts";
import { handleRequest, type GatewayContext } from "../../../packages/gateway-core/src/handleRequest.ts";
import { deriveProviderIdempotencyKey } from "../../../packages/gateway-core/src/retry.ts";
import { FakeCrypto, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { insertRevision, parseRevision } from "../app/api/v1/routes/[id]/route-utils.ts";

type Sql = ReturnType<typeof postgres>;
let pg: PgHarness;
let sql: Sql;

before(async () => {
  pg = await startPg({ namePrefix: "mf-route-idempotency" });
  sql = pg.sql;
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_retry','ws-retry','Retry','local');
    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES ('mdl_retry','retry','Retry','catalog');
    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES ('dek_retry','ws_retry','\\xdeadbeef','kek_retry','active');
    INSERT INTO provider_model_offering (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision, capabilities, catalog_revision)
      VALUES ('off_retry','mdl_retry','openai','retry-native','["chat"]','adapter_retry','{"providerIdempotency":"supported"}','catalog');
    INSERT INTO provider_credential (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status)
      VALUES ('cred_retry','ws_retry','openai','retry credential','\\xc0ffee','dek_retry',NULL,'["api.openai.com"]','valid');
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES ('inst_retry','ws_retry','Retry installation','{}');
    INSERT INTO gateway_ingress_profile (id, workspace_id, installation_id, hostname, mode, auth_config)
      VALUES ('profile_retry','ws_retry','inst_retry','retry.local','public_app','{}');
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_retry_a','ws_retry','inst_retry','retry-a','chat'),
      ('route_retry_b','ws_retry','inst_retry','retry-b','chat');
  `);
});

after(async () => { await pg.stop(); });

function input(maxAttempts = 2) {
  return parseRevision({
    targets: [{ clientRef: "client-target", providerCredentialId: "cred_retry", offeringId: "off_retry" }],
    retryPolicy: {
      maxAttempts,
      retryOn: ["5xx"],
      providerIdempotency: { targetRef: "client-target", headerName: "idempotency-key" },
    },
  });
}

test("real PG: server-generated target ids bind the supported contract through the signed snapshot", async () => {
  const first = await insertRevision(sql as never, "ws_retry", "route_retry_a", null, input());
  const [firstTarget] = await sql<{ id: string }[]>`SELECT id FROM gateway_target WHERE route_revision_id = ${first.revisionId}`;
  const [firstPolicy] = await sql<{ retry_policy: { provider_idempotency: { target_id: string; header_name: string } } }[]>`SELECT retry_policy FROM gateway_route_revision WHERE id = ${first.revisionId}`;
  assert.notEqual(firstTarget.id, "client-target");
  assert.deepEqual(firstPolicy.retry_policy.provider_idempotency, { target_id: firstTarget.id, header_name: "idempotency-key" });

  await sql`UPDATE gateway_route SET active_revision_id = ${first.revisionId} WHERE id = 'route_retry_a'`;
  const snapshot = await buildSnapshot(sql as never, "inst_retry");
  const route = snapshot.routes["profile_retry:chat:retry-a"]!;
  assert.equal(route.targets[0]?.targetId, firstTarget.id);
  assert.deepEqual(route.retryPolicy?.provider_idempotency, firstPolicy.retry_policy.provider_idempotency);

  const crypto = new FakeCrypto();
  const key = "sk-retry-pg";
  const pepper = new TextEncoder().encode("retry-pg-pepper");
  const providerKey = await deriveProviderIdempotencyKey(crypto, pepper, "inst_retry", firstTarget.id, "provider-retry-key");
  const hash = await keyedHashHex(crypto, pepper, key);
  snapshot.keys[hash] = {
    id: "key_retry", profileId: "profile_retry", scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null,
  };
  let calls = 0;
  const context: GatewayContext = {
    installationId: "inst_retry", snapshot, crypto, clock: new FixedClock(), pepper,
    ingest: { async emit() {} }, resolveSecret: async () => "provider-secret",
    fetcher: { fetch: async (request) => {
      calls += 1;
      assert.equal(request.headers.get("idempotency-key"), providerKey);
      assert.notEqual(request.headers.get("idempotency-key"), "provider-retry-key");
      return new Response(calls === 1 ? "retry" : "ok", { status: calls === 1 ? 503 : 200 });
    } },
  };
  const response = await handleRequest(context, new Request("https://retry.local/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "provider-retry-key" },
    body: JSON.stringify({ model: "retry-a", messages: [] }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls, 2, "the signed, capability-backed contract retries only its generated target");
});

test("real PG: successor and cross-route clientRef reuse create fresh target primary keys", async () => {
  const successor = await insertRevision(sql as never, "ws_retry", "route_retry_a", null, input(3));
  const otherRoute = await insertRevision(sql as never, "ws_retry", "route_retry_b", null, input());
  const rows = await sql<{ route_revision_id: string; id: string }[]>`
    SELECT route_revision_id, id FROM gateway_target
    WHERE route_revision_id IN ${sql([successor.revisionId, otherRoute.revisionId])}
    ORDER BY route_revision_id`;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]?.id, rows[1]?.id);
  assert.ok(rows.every((row) => row.id !== "client-target"));
});

test("real PG: an unsupported offering adapter cannot persist a provider idempotency contract", async () => {
  await sql`UPDATE provider_model_offering SET capabilities = '{}' WHERE id = 'off_retry'`;
  await assert.rejects(
    insertRevision(sql as never, "ws_retry", "route_retry_b", null, input(4)),
    /providerIdempotency: 'supported'/,
  );
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM gateway_route_revision WHERE route_id = 'route_retry_b'`;
  assert.equal(rows[0]?.count, "1");
  const snapshot = await buildSnapshot(sql as never, "inst_retry");
  assert.equal(snapshot.routes["profile_retry:chat:retry-a"]?.retryPolicy?.provider_idempotency, undefined,
    "a direct stale DB policy loses replay authority when its adapter capability is removed");
});
