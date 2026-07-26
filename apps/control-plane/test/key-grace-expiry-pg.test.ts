import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;
let sweep: (requestId: string) => Promise<{ workspaces: number; expired: number; published: number; reconciled: number; retried: number }>;

before(async () => {
  pg = await startPg({ namePrefix: "mf-key-grace-expiry" });
  process.env.DATABASE_URL = pg.url;
  process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY = Buffer.alloc(32).toString("base64");
  ({ sweepExpiredKeyRotationGrace: sweep } = await import("../lib/keys/grace-expiry.ts"));
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_expire_a','expire-a','Expire A','local'), ('ws_expire_b','expire-b','Expire B','local');
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_expire_a','ws_expire_a','Expire A','{}'), ('inst_expire_b','ws_expire_b','Expire B','{}');
    INSERT INTO gateway_ingress_profile (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_expire_a','ws_expire_a','inst_expire_a','expire-a.test','public_app','{}'),
      ('prof_expire_b','ws_expire_b','inst_expire_b','expire-b.test','public_app','{}');
    INSERT INTO virtual_key (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, successor_key_id, expires_at) VALUES
      ('key_successor_a','ws_expire_a','prof_expire_a','mf_as',decode('ab', 'hex'),'{}',NULL,NULL),
      ('key_successor_b','ws_expire_b','prof_expire_b','mf_bs',decode('bb', 'hex'),'{}',NULL,NULL),
      ('key_expire_a','ws_expire_a','prof_expire_a','mf_a',decode('aa', 'hex'),'{}','key_successor_a',now()-interval '1 second'),
      ('key_future_b','ws_expire_b','prof_expire_b','mf_b',decode('ba', 'hex'),'{}','key_successor_b',now()+interval '1 hour');
    INSERT INTO gateway_config_revision (id, workspace_id, installation_id, content_hash, snapshot, status) VALUES
      ('cfgrev_before_expiry','ws_expire_a','inst_expire_a','sha256:before-expiry',
       '{"meta":{"schema":"manifold.snapshot.v1","installationId":"inst_expire_a","revision":"cfgrev_before_expiry","contentHash":"sha256:before-expiry","builtAt":"2026-07-25T00:00:00.000Z"},"profiles":{"prof_expire_a":{"id":"prof_expire_a"}},"keys":{"stale":"must-be-removed"},"routes":{},"offerings":{},"policies":{},"budgets":{}}'::jsonb,
       'active');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("grace expiry revokes only due predecessors, audits once, and completes the key-only work", async () => {
  const first = await sweep("req_grace_first");
  assert.deepEqual(first, { workspaces: 1, expired: 1, published: 1, reconciled: 0, retried: 0 });
  const [expired] = await pg.sql<{ revoked_at: string | null }[]>`SELECT revoked_at::text FROM virtual_key WHERE id='key_expire_a'`;
  const [future] = await pg.sql<{ revoked_at: string | null }[]>`SELECT revoked_at::text FROM virtual_key WHERE id='key_future_b'`;
  assert.ok(expired?.revoked_at);
  assert.equal(future?.revoked_at, null, "the worker must not cross workspace or expire future grace");
  const audits = await pg.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_event WHERE workspace_id='ws_expire_a' AND action='key.rotation_grace_expire'`;
  assert.equal(audits[0]?.n, "1");
  const [active] = await pg.sql<{ id: string; keys: Record<string, unknown> }[]>`
    SELECT id, snapshot->'keys' AS keys FROM gateway_config_revision
    WHERE installation_id='inst_expire_a' AND status='active'`;
  assert.equal(Object.values(active?.keys ?? {}).some((key) => (key as { id?: string }).id === "key_expire_a"), false,
    "the expedited snapshot publication must remove the revoked predecessor");
  assert.equal(Object.values(active?.keys ?? {}).some((key) => (key as { id?: string }).id === "key_successor_a"), true,
    "the successor remains in the keys-only snapshot");
  const jobs = await pg.sql<{ status: string; operation_id: string | null }[]>`SELECT status, operation_id FROM key_rotation_expiry_publish WHERE workspace_id='ws_expire_a'`;
  assert.deepEqual(Array.from(jobs), [{ status: "done", operation_id: null }]);

  // Model an accelerator failure after the DB activation committed. The next sweep must reconcile
  // that exact keys-only operation, rather than re-expiring the key or emitting another audit.
  await pg.sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, diff_json, outcome, operation_kind, revision_id,
       serving_mode, accelerator_status)
    VALUES ('cfgop_expire_a','ws_expire_a','inst_expire_a','{}'::jsonb,'accepted','key_publish',
      ${active!.id},'edge_config','reconciliation_required')`;
  await pg.sql`
    UPDATE key_rotation_expiry_publish
    SET status='pending', operation_id='cfgop_expire_a', completed_at=NULL
    WHERE workspace_id='ws_expire_a' AND installation_id='inst_expire_a'`;
  const retry = await sweep("req_grace_retry");
  assert.deepEqual(retry, { workspaces: 1, expired: 0, published: 0, reconciled: 1, retried: 0 });
  const [operation] = await pg.sql<{ accelerator_status: string; reconciliation_attempts: number }[]>`
    SELECT accelerator_status, reconciliation_attempts FROM config_operation WHERE id='cfgop_expire_a'`;
  assert.deepEqual(operation, { accelerator_status: "not_configured", reconciliation_attempts: 1 });
  const afterRetry = await pg.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_event WHERE workspace_id='ws_expire_a' AND action='key.rotation_grace_expire'`;
  assert.equal(afterRetry[0]?.n, "1", "retry must not create a duplicate expiry audit event");
});
