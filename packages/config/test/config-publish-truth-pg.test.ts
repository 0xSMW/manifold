import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  apply,
  rollback,
  type ConfigSnapshot,
  type Plan,
  type SnapshotPublishStore,
} from "@manifold/config";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

let pg: PgHarness;
let sql: ReturnType<typeof postgres>;

function snapshot(installationId: string, revision: string, contentHash: string): ConfigSnapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId,
      revision,
      contentHash,
      builtAt: "2026-07-24T00:00:00.000Z",
      signature: `signature-${revision}`,
      signingKeyId: "test",
    },
    profiles: {},
    keys: {},
    routes: {},
    offerings: {},
    policies: {},
    budgets: {},
  };
}

function configPlan(
  installationId: string,
  target: ConfigSnapshot,
  baseConfigHash: string | null,
  tripwire = false,
): Plan {
  return {
    installationId,
    workspaceId: "ws_truth",
    baseConfigHash,
    targetConfigHash: target.meta.contentHash,
    planHash: `plan-${target.meta.revision}`,
    diffJson: {
      routes: { added: [], removed: tripwire ? ["route:old"] : [], changed: [] },
      keys: { added: [], removed: [], changed: [] },
      offerings: { added: [], removed: [], changed: [] },
      policies: { added: [], removed: [], changed: [] },
      budgets: { added: [], removed: [], changed: [] },
    },
    tripwireItems: tripwire
      ? [{ kind: "route_delete", ref: "route:old", detail: {} }]
      : [],
    snapshot: target,
    noop: baseConfigHash === target.meta.contentHash,
  };
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-config-truth" });
  sql = pg.sql;
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region)
    VALUES ('ws_truth','truth','Truth','local');
    INSERT INTO member (id, workspace_id, email, role)
    VALUES ('mbr_admin','ws_truth','admin@example.test','admin');
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity)
    VALUES
      ('inst_boot','ws_truth','Boot','{}'),
      ('inst_fail','ws_truth','Fail','{}'),
      ('inst_approval','ws_truth','Approval','{}'),
      ('inst_rollback','ws_truth','Rollback','{}');
  `);
});

after(async () => {
  await pg.stop();
});

test("apply without accelerator records durable boot_fallback and does not claim gateway confirmation", async () => {
  const target = snapshot("inst_boot", "cfgrev_boot", "sha256:boot");
  const op = await apply(sql, configPlan("inst_boot", target, null), null, [], {
    actorKind: "member",
    actorId: "mbr_admin",
    memberId: "mbr_admin",
  });
  const rows = await sql`
    SELECT serving_mode, accelerator_status, edge_config_version, revision_id
    FROM config_operation WHERE id = ${op.id}`;
  assert.deepEqual(rows[0], {
    serving_mode: "boot_fallback",
    accelerator_status: "not_configured",
    edge_config_version: null,
    revision_id: "cfgrev_boot",
  });
  const installation = await sql`
    SELECT applied_config_revision FROM gateway_installation WHERE id = 'inst_boot'`;
  assert.equal(
    installation[0].applied_config_revision,
    null,
    "control-plane activation must not self-report gateway serving confirmation",
  );
});

test("accelerator apply persists a pending reconciliation job without an inline side effect", async () => {
  const target = snapshot("inst_fail", "cfgrev_fail", "sha256:fail");
  let publishCalls = 0;
  const throwingStore: SnapshotPublishStore = {
    publish: async () => {
      publishCalls += 1;
      throw new Error("accelerator unavailable");
    },
    pointer: async () => null,
    loadActive: async () => target,
  };
  await apply(sql, configPlan("inst_fail", target, null), throwingStore);
  assert.equal(publishCalls, 0, "the keyed worker owns the external publication effect");
  const operations = await sql`
    SELECT accelerator_status, error, revision_id
    FROM config_operation WHERE installation_id = 'inst_fail'`;
  assert.equal(operations[0].accelerator_status, "pending");
  assert.equal(operations[0].revision_id, "cfgrev_fail");
  assert.equal(operations[0].error, null);
  const jobs = await sql`
    SELECT kind, status FROM job_ledger WHERE workspace_id = 'ws_truth'
      AND kind = 'config_publish_reconcile'`;
  assert.deepEqual(jobs[0], { kind: "config_publish_reconcile", status: "pending" });
  const active = await sql`
    SELECT id FROM gateway_config_revision
    WHERE installation_id = 'inst_fail' AND status = 'active'`;
  assert.equal(active[0].id, "cfgrev_fail", "boot fallback remains immediately available");
});

test("persisted approval is plan-bound and single-use; a request assertion cannot forge it", async () => {
  const target = snapshot("inst_approval", "cfgrev_approval", "sha256:approval");
  const planned = configPlan("inst_approval", target, null, true);
  await sql`
    INSERT INTO config_tripwire_approval
      (id, workspace_id, installation_id, plan_hash, kind, ref, approved_by, expires_at)
    VALUES
      ('cfgapr_stale','ws_truth','inst_approval','plan-stale','route_delete','route:old',
       'mbr_admin',now() + interval '15 minutes')`;

  const rejected = await apply(sql, planned, null, [], {
    memberId: "mbr_admin",
    approvalIds: ["cfgapr_stale"],
  });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reasonCode, "CONFIG_TRIPWIRE_HELD");

  await sql`
    INSERT INTO config_tripwire_approval
      (id, workspace_id, installation_id, plan_hash, kind, ref, approved_by, expires_at)
    VALUES
      ('cfgapr_live','ws_truth','inst_approval',${planned.planHash},'route_delete','route:old',
       'mbr_admin',now() + interval '15 minutes')`;
  const accepted = await apply(sql, planned, null, [], {
    memberId: "mbr_admin",
    approvalIds: ["cfgapr_live"],
  });
  const used = await sql`
    SELECT used_at, used_by_operation_id FROM config_tripwire_approval WHERE id = 'cfgapr_live'`;
  assert.ok(used[0].used_at);
  assert.equal(used[0].used_by_operation_id, accepted.id);
  await assert.rejects(
    sql`UPDATE config_tripwire_approval
        SET used_at = NULL, used_by_operation_id = NULL WHERE id = 'cfgapr_live'`,
    /IMMUTABLE_ROW/,
  );
});

test("rollback reactivates the prior byte-identical signed snapshot", async () => {
  const a = snapshot("inst_rollback", "cfgrev_a", "sha256:a");
  const b = snapshot("inst_rollback", "cfgrev_b", "sha256:b");
  await apply(sql, configPlan("inst_rollback", a, null), null);
  await apply(sql, configPlan("inst_rollback", b, a.meta.contentHash), null);
  const op = await rollback(sql, a.meta.revision, null, {
    workspaceId: "ws_truth",
    expectedBaseConfigHash: b.meta.contentHash,
  });
  assert.equal(op.revisionId, a.meta.revision);
  const active = await sql`
    SELECT id, snapshot FROM gateway_config_revision
    WHERE installation_id = 'inst_rollback' AND status = 'active'`;
  assert.equal(active.length, 1);
  assert.equal(active[0].id, a.meta.revision);
  assert.deepEqual(active[0].snapshot, a);
});
