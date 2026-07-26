import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  apply,
  generateSigningKeyPair,
  healthOnlyPublish,
  type ConfigSnapshot,
  type Plan,
  type SnapshotPublishStore,
} from "@manifold/config";
import { verifySnapshot } from "@manifold/config/signing";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

let pg: PgHarness;
let sql: ReturnType<typeof postgres>;
const signing = generateSigningKeyPair();

function snap(revision: string, healthState: "unknown" | "healthy" = "unknown"): ConfigSnapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "inst_health",
      revision,
      contentHash: `sha256:${revision}`,
      builtAt: "2026-07-25T00:00:00.000Z",
      signature: "initial",
      signingKeyId: signing.signingKeyId,
    },
    profiles: {}, keys: {}, offerings: {}, policies: {}, budgets: {},
    routes: {
      "profile:chat:health": {
        routeId: "route_health", revision: "route_rev_health", mode: "ordered",
        timeoutMs: 30_000, capturePolicyId: "default",
        targets: [{
          targetId: "target_health", offeringId: "off_health", credentialId: "cred_health",
          dekId: "dek_health", credentialCiphertext: "ciphertext", wrappedDek: "wrapped",
          weight: 1, priority: 1, healthState, baseUrl: "https://api.openai.com", region: null,
          allowedHosts: ["api.openai.com"], authInject: { headers: { authorization: "Bearer ${secret}" } },
        }],
      },
    },
  };
}

function planFor(snapshot: ConfigSnapshot, base: string | null): Plan {
  return {
    installationId: "inst_health", workspaceId: "ws_health", baseConfigHash: base,
    targetConfigHash: snapshot.meta.contentHash, planHash: `plan:${snapshot.meta.revision}`,
    diffJson: {
      routes: { added: [], removed: [], changed: [] }, keys: { added: [], removed: [], changed: [] },
      offerings: { added: [], removed: [], changed: [] }, policies: { added: [], removed: [], changed: [] },
      budgets: { added: [], removed: [], changed: [] },
    }, tripwireItems: [], snapshot, noop: false,
  };
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-health-publish" });
  sql = pg.sql;
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_health','health','Health','local');
    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision)
      VALUES ('cm_health','health-model','Health model','catalog');
    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status)
      VALUES ('dek_health','ws_health','\\x01','kek','active');
    INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision, capabilities, catalog_revision)
      VALUES ('off_health','cm_health','openai','health-model','["chat"]','adapter','{}','catalog');
    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, allowed_hosts, status)
      VALUES ('cred_health','ws_health','openai','health','\\x01','dek_health','["api.openai.com"]','valid');
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity)
      VALUES ('inst_health','ws_health','Health','{}');
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind)
      VALUES ('route_health','ws_health','inst_health','health','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash)
      VALUES ('route_rev_health','ws_health','route_health','ordered','{}','{"overall_ms":30000}','routehash');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision)
      VALUES ('target_health','ws_health','route_rev_health','cred_health','off_health','adapter');
    UPDATE gateway_route SET active_revision_id = 'route_rev_health' WHERE id = 'route_health';
  `);
  await apply(sql, planFor(snap("cfgrev_health_initial"), null), null);
  await sql`
    INSERT INTO gateway_target_health
      (target_id, workspace_id, installation_id, route_revision_id, snapshot_revision_id,
       state, published_state, next_expiry_at)
    VALUES ('target_health','ws_health','inst_health','route_rev_health','cfgrev_health_initial',
      'unhealthy','unknown', now() + interval '10 minutes')`;
});

after(async () => pg.stop());

test("health-only publish changes only target health and activates a fresh signed revision", async () => {
  const beforeRows = await sql`SELECT snapshot, content_hash FROM gateway_config_revision
    WHERE installation_id = 'inst_health' AND status = 'active'`;
  const op = await healthOnlyPublish(sql, "ws_health", "inst_health", null, {
    signingKey: signing.privateKey, signingKeyId: signing.signingKeyId,
  });
  assert.equal(op?.outcome, "accepted");
  const rows = await sql`SELECT snapshot, operation_kind FROM gateway_config_revision r
    JOIN config_operation o ON o.revision_id = r.id WHERE o.id = ${op?.id}`;
  const before = beforeRows[0].snapshot as ConfigSnapshot;
  const afterSnapshot = rows[0].snapshot as ConfigSnapshot;
  assert.equal(rows[0].operation_kind, "health_publish");
  assert.deepEqual({ ...afterSnapshot, routes: before.routes, meta: before.meta }, before);
  assert.equal(afterSnapshot.routes["profile:chat:health"]!.targets[0]!.healthState, "unhealthy");
  assert.notEqual(afterSnapshot.meta.revision, before.meta.revision);
  assert.equal(verifySnapshot(afterSnapshot, signing.publicKey).ok, true);
  const projection = await sql`SELECT published_state FROM gateway_target_health WHERE target_id = 'target_health'`;
  assert.equal(projection[0].published_state, "unhealthy");
});

test("expired health is published as unknown and retries become a no-op", async () => {
  await sql`UPDATE gateway_target_health SET state = 'healthy', next_expiry_at = now() - interval '1 second'
    WHERE target_id = 'target_health'`;
  const deferredStore: SnapshotPublishStore = {
    publish: async () => { throw new Error("the reconcile worker owns this side effect"); },
    pointer: async () => null,
    loadActive: async () => snap("unused"),
  };
  const op = await healthOnlyPublish(sql, "ws_health", "inst_health", deferredStore, {
    signingKey: signing.privateKey, signingKeyId: signing.signingKeyId,
  });
  assert.equal(op?.outcome, "accepted");
  const active = await sql`SELECT snapshot FROM gateway_config_revision
    WHERE installation_id = 'inst_health' AND status = 'active'`;
  assert.equal((active[0].snapshot as ConfigSnapshot).routes["profile:chat:health"]!.targets[0]!.healthState, "unknown");
  const durable = await sql`SELECT accelerator_status FROM config_operation WHERE id = ${op?.id}`;
  assert.equal(durable[0].accelerator_status, "pending");
  const jobs = await sql`SELECT id FROM job_ledger WHERE workspace_id = 'ws_health'
    AND kind = 'config_publish_reconcile' AND payload->>'operationId' = ${op?.id}`;
  assert.equal(jobs.length, 1, "a retry worker receives the exact committed health revision");
  const retry = await healthOnlyPublish(sql, "ws_health", "inst_health", null, {
    signingKey: signing.privateKey, signingKeyId: signing.signingKeyId,
  });
  assert.equal(retry, null, "unchanged effective health must not churn revisions on retry");
});

test("apply rejects a health snapshot whose base was superseded", async () => {
  const active = await sql`SELECT content_hash FROM gateway_config_revision
    WHERE installation_id = 'inst_health' AND status = 'active'`;
  const stale = snap("cfgrev_health_stale", "healthy");
  const stalePlan = planFor(stale, active[0].content_hash);
  const newer = snap("cfgrev_health_newer", "unknown");
  await apply(sql, planFor(newer, active[0].content_hash), null);
  const rejected = await apply(sql, stalePlan, null, [], { operationKind: "health_publish" });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reasonCode, "CONFIG_PRECONDITION_FAILED");
});
