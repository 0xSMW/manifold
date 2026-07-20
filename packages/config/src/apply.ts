// Config publishing lifecycle writes (SPEC §8.2, §6.11).
//
//  apply(db, plan, store)        — one txn: precondition base==active, insert new active
//                                  gateway_config_revision + flip prior to superseded, publish
//                                  to the store, record config_operation.
//  rollback(db, revisionId, store) — republish a prior revision's stored snapshot bytes.
//  keyOnlyPublish(db, ..., store)  — SPEC §8.2 H7: rebuild only the keys section against the
//                                  active route/policy revision and publish (expedited path).
import { ReasonCode } from "@manifold/contracts";
import type { Database } from "@manifold/database";
import type { Snapshot } from "@manifold/ports";
import { assembleSnapshot, buildKeysSection, genId, stampMeta } from "./build.js";
import { computeContentHash, stableStringify } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql } from "./db.js";
import { planApply } from "./plan.js";
import { signSnapshot, type PrivateKeyInput } from "./signing.js";
import type { ConfigOperation, ConfigSnapshot, Plan, SnapshotPublishStore } from "./types.js";

async function setWorkspace(sql: PgSql, workspaceId: string): Promise<void> {
  await sql`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
}

function revisionIdSets(snap: ConfigSnapshot): {
  routeIds: string[];
  policyIds: string[];
  priceIds: string[];
} {
  const routeIds = [...new Set(Object.values(snap.routes).map((r) => r.routeId))].sort();
  const policyIds = Object.keys(snap.policies).sort();
  const priceIds = [
    ...new Set(
      Object.values(snap.offerings)
        .map((o) => o.priceRevisionId)
        .filter((x): x is string => x != null),
    ),
  ].sort();
  return { routeIds, policyIds, priceIds };
}

async function insertOperation(
  sql: PgSql,
  op: Omit<ConfigOperation, "id"> & { workspaceId: string },
  diffJson: unknown = {},
): Promise<ConfigOperation> {
  const id = genId("cfgop");
  await sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, base_config_hash, target_config_hash, plan_hash,
       diff_json, outcome, edge_config_version, tripwire_items, error)
    VALUES
      (${id}, ${op.workspaceId}, ${op.installationId}, ${op.baseConfigHash},
       ${op.targetConfigHash}, ${op.planHash}, ${sql.json(q.jval(diffJson))},
       ${op.outcome}, ${op.edgeConfigVersion},
       ${sql.json(q.jval(op.tripwireItems))},
       ${op.reasonCode ? sql.json(q.jval({ reason_code: op.reasonCode })) : null})`;
  return { id, ...op };
}

/** The plan-identity fields every config_operation copies verbatim (§6.11): who + which hashes. */
type OpIdentity = Pick<
  ConfigOperation,
  "installationId" | "workspaceId" | "baseConfigHash" | "targetConfigHash" | "planHash" | "tripwireItems"
>;
/** The per-outcome fields that vary across reject / no-op / accept / rollback branches. */
type OpOutcome = Pick<
  ConfigOperation,
  "outcome" | "edgeConfigVersion" | "revisionId" | "reasonCode"
>;

/**
 * Assemble the ConfigOperation body (sans id) from a plan's identity fields plus the branch's
 * outcome patch. Collapses the reject / no-op / accept branches of apply() and the rollback
 * record, which previously copied the same six identity fields into each field bag (DRY §9).
 */
function opFromPlan(id: OpIdentity, patch: OpOutcome): Omit<ConfigOperation, "id"> {
  return {
    installationId: id.installationId,
    workspaceId: id.workspaceId,
    baseConfigHash: id.baseConfigHash,
    targetConfigHash: id.targetConfigHash,
    planHash: id.planHash,
    tripwireItems: id.tripwireItems,
    ...patch,
  };
}

/**
 * SPEC §8.2 apply(). One transaction. Returns the recorded ConfigOperation; on a moved base
 * the operation is recorded with outcome 'rejected' and reasonCode CONFIG_PRECONDITION_FAILED
 * (the txn still commits the audit row).
 */
export async function apply(
  db: Database,
  plan: Plan,
  store: SnapshotPublishStore,
): Promise<ConfigOperation> {
  const sql = q.client(db);
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspace(tx, plan.workspaceId);
    const active = await q.readActiveRevision(tx, plan.installationId);
    const activeHash = active?.content_hash ?? null;

    // Optimistic-concurrency precondition (§16.2): base must equal the live active hash.
    if (activeHash !== plan.baseConfigHash) {
      return insertOperation(tx, opFromPlan(plan, {
        outcome: "rejected",
        edgeConfigVersion: null,
        revisionId: null,
        reasonCode: ReasonCode.enum.CONFIG_PRECONDITION_FAILED,
      }), plan.diffJson);
    }

    // Idempotency (§8.2): identical content is a no-op.
    if (plan.targetConfigHash === activeHash) {
      return insertOperation(tx, opFromPlan(plan, {
        outcome: "accepted",
        edgeConfigVersion: null,
        revisionId: active?.id ?? null,
        reasonCode: null,
      }), plan.diffJson);
    }

    const snap = plan.snapshot;
    const revisionId = snap.meta.revision;
    const { routeIds, policyIds, priceIds } = revisionIdSets(snap);

    // Flip prior active → superseded (guard allows active→superseded), then insert new active.
    if (active) {
      await tx`UPDATE gateway_config_revision SET status = 'superseded' WHERE id = ${active.id}`;
    }
    await tx`
      INSERT INTO gateway_config_revision
        (id, workspace_id, installation_id, content_hash, parent_revision_id, snapshot,
         route_ids, policy_ids, price_ids, status)
      VALUES
        (${revisionId}, ${plan.workspaceId}, ${plan.installationId}, ${plan.targetConfigHash},
         ${active?.id ?? null}, ${tx.json(q.jval(snap))},
         ${tx.json(q.jval(routeIds))}, ${tx.json(q.jval(policyIds))}, ${tx.json(q.jval(priceIds))}, 'active')`;

    // Publish to the store (Edge Config / KV). DB is source of truth; store is its cache (§8.2).
    const published = await store.publish(plan.installationId, revisionId, snap as unknown as Snapshot /* publish serializes JSON; policy shape divergence is at rest, GROK_DRY #21 */);

    await tx`
      UPDATE gateway_installation SET applied_config_revision = ${revisionId}
      WHERE id = ${plan.installationId}`;

    return insertOperation(tx, opFromPlan(plan, {
      outcome: "accepted",
      edgeConfigVersion: published.version,
      revisionId,
      reasonCode: null,
    }), plan.diffJson);
  }) as Promise<ConfigOperation>;
}

/**
 * SPEC §8.2 rollback(): republish a prior revision's stored snapshot bytes — no rebuild, so it
 * is byte-identical and its existing signature stays valid. Flips the current active →
 * rolled_back and repoints the installation + store at the prior revision.
 *
 * DB-constraint note: the immutability guard (0001) only permits active→superseded|rolled_back,
 * never superseded→active, and `config_revision_hash_uq` forbids re-inserting a row with the
 * prior content hash. A true "restore to active" is therefore not expressible as a mutation or
 * a re-insert; the authoritative live pointer after rollback is the store + the installation's
 * applied_config_revision (ADR-0007 "republish, never mutate"; §8.2 "the store is a cache of
 * [the DB]"). The prior revision row remains 'superseded'; the current is marked 'rolled_back'.
 */
export async function rollback(
  db: Database,
  revisionId: string,
  store: SnapshotPublishStore,
): Promise<ConfigOperation> {
  const sql = q.client(db);
  return sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    const target = await q.readRevisionById(tx, revisionId);
    if (!target) throw new Error(`revision not found: ${revisionId}`);
    await setWorkspace(tx, target.workspace_id);
    const active = await q.readActiveRevision(tx, target.installation_id);

    if (active && active.id !== target.id) {
      await tx`UPDATE gateway_config_revision SET status = 'rolled_back' WHERE id = ${active.id}`;
    }

    const priorSnap = target.snapshot as ConfigSnapshot;
    const published = await store.publish(target.installation_id, target.id, priorSnap as unknown as Snapshot);
    await tx`
      UPDATE gateway_installation SET applied_config_revision = ${target.id}
      WHERE id = ${target.installation_id}`;

    return insertOperation(tx, opFromPlan(
      {
        installationId: target.installation_id,
        workspaceId: target.workspace_id,
        baseConfigHash: active?.content_hash ?? null,
        targetConfigHash: target.content_hash,
        planHash: null,
        tripwireItems: [],
      },
      {
        outcome: "accepted",
        edgeConfigVersion: published.version,
        revisionId: target.id,
        reasonCode: null,
      },
    ), { rollback: true, restoredRevision: target.id, from: active?.id ?? null });
  }) as Promise<ConfigOperation>;
}

export interface KeyOnlyPublishOptions {
  /** Sign the rebuilt snapshot with this ed25519 key (recommended: §7.3 requires a signature). */
  signingKey?: PrivateKeyInput;
  signingKeyId?: string;
}

/**
 * SPEC §8.2 H7 (scoped key publish): rebuild ONLY the snapshot `keys` section against the
 * currently-active route/policy revision and publish it, so a minted/rotated/revoked key goes
 * live without publishing unrelated route/policy drafts. Route/offering/policy sections are
 * carried over verbatim from the active revision.
 */
export async function keyOnlyPublish(
  db: Database,
  installationId: string,
  store: SnapshotPublishStore,
  opts: KeyOnlyPublishOptions = {},
): Promise<ConfigOperation> {
  const sql = q.client(db);
  const active = await q.readActiveRevision(sql, installationId);
  if (!active) {
    throw new Error(
      `keyOnlyPublish requires an active config revision to rebuild keys against (${installationId})`,
    );
  }
  const base = active.snapshot as ConfigSnapshot;
  const profileIds = Object.values(base.profiles).map((p) => p.id);
  const keys = await buildKeysSection(sql, profileIds);

  // Rebuild only keys; carry route/offering/policy sections over unchanged.
  let next: ConfigSnapshot = {
    ...base,
    keys,
    meta: stampMeta(base.meta),
  };
  next.meta.contentHash = computeContentHash(next);

  // No key change → identical content → no-op (§8.2 idempotency).
  if (stableStringify(base.keys) === stableStringify(keys)) {
    return {
      id: genId("cfgop"),
      installationId,
      workspaceId: active.workspace_id,
      baseConfigHash: active.content_hash,
      targetConfigHash: active.content_hash,
      planHash: null,
      outcome: "accepted",
      edgeConfigVersion: null,
      tripwireItems: [],
      revisionId: active.id,
      reasonCode: null,
    };
  }

  if (opts.signingKey) next = signSnapshot(next, opts.signingKey, opts.signingKeyId);

  const plan = await planApply(db, installationId, next);
  return apply(db, plan, store);
}

// buildSnapshot is re-exported for callers wanting a full rebuild before keyOnlyPublish paths.
export { assembleSnapshot };
