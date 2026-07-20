// Config publishing lifecycle writes (SPEC §8.2, §6.11).
//
//  apply(sql, plan, store)       — one txn: precondition base==active, insert new active
//                                  gateway_config_revision + flip prior to superseded, publish
//                                  to the store, record config_operation.
//  rollback(sql, revisionId, store) — republish a prior revision's stored snapshot bytes.
//  keyOnlyPublish(sql, workspaceId, installationId, store, opts) — SPEC §8.2 H7: rebuild only the
//                                  keys section against the active route/policy revision and publish
//                                  (expedited path; the single core the control-plane wraps).
import { ReasonCode } from "@manifold/contracts";
import { setWorkspaceGuc } from "@manifold/database";
import { assembleSnapshot, buildKeysSection, genId, stampMeta } from "./build.js";
import { computeContentHash, stableStringify } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql } from "./db.js";
import { plan } from "./plan.js";
import { signSnapshot, type PrivateKeyInput } from "./signing.js";
import type {
  Approval,
  ConfigOperation,
  ConfigSnapshot,
  Plan,
  SnapshotPublishStore,
} from "./types.js";

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
 *
 * Destructive changes (route deletions, entitlement removals) are TRIPWIRES (§8.2). apply() is
 * the authoritative gate: it applies them ONLY when every `plan.tripwireItems` entry is covered by
 * an `approvals` entry matching its `{kind, ref}` AND the plan's `planHash`. Any uncovered tripwire
 * → the new revision is NOT inserted; the operation is recorded 'rejected' / CONFIG_TRIPWIRE_HELD.
 * Callers with no destructive changes (e.g. keyOnlyPublish) pass no approvals — an empty tripwire
 * set is trivially covered.
 */
export async function apply(
  sql: PgSql,
  plan: Plan,
  store: SnapshotPublishStore,
  approvals: Approval[] = [],
): Promise<ConfigOperation> {
  // Phase 1 — the DB transaction is the SOURCE OF TRUTH (§8.2). Nothing that advances the external
  // store happens inside it: store.publish used to run mid-txn (before the installation update +
  // config_operation insert), so if any later statement threw, the txn rolled back but the store had
  // ALREADY advanced → the store pointed at a revision the DB no longer considered active (review
  // bug). The store is a cache of committed DB truth, so publish MUST happen only AFTER commit.
  const committed = (await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, plan.workspaceId);
    const active = await q.readActiveRevision(tx, plan.installationId);
    const activeHash = active?.content_hash ?? null;

    // Optimistic-concurrency precondition (§16.2): base must equal the live active hash.
    if (activeHash !== plan.baseConfigHash) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "rejected",
        edgeConfigVersion: null,
        revisionId: null,
        reasonCode: ReasonCode.enum.CONFIG_PRECONDITION_FAILED,
      }), plan.diffJson);
      return { op, publish: null };
    }

    // Idempotency (§8.2): identical content is a no-op (no new revision, nothing to publish).
    if (plan.targetConfigHash === activeHash) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "accepted",
        edgeConfigVersion: null,
        revisionId: active?.id ?? null,
        reasonCode: null,
      }), plan.diffJson);
      return { op, publish: null };
    }

    // Tripwire approval gate (§8.2): a destructive change applies ONLY with a matching approval.
    // Match on {kind, ref} AND the plan's planHash, so an approval minted against a stale plan can
    // never wave through a different destructive change. Any uncovered tripwire → reject (do NOT
    // insert the new active revision); the audit row still commits (CONFIG_TRIPWIRE_HELD).
    const heldTripwires = plan.tripwireItems.filter(
      (it) =>
        !approvals.some(
          (a) => a.kind === it.kind && a.ref === it.ref && a.planHash === plan.planHash,
        ),
    );
    if (heldTripwires.length > 0) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "rejected",
        edgeConfigVersion: null,
        revisionId: null,
        reasonCode: ReasonCode.enum.CONFIG_TRIPWIRE_HELD,
      }), plan.diffJson);
      return { op, publish: null };
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

    await tx`
      UPDATE gateway_installation SET applied_config_revision = ${revisionId}
      WHERE id = ${plan.installationId}`;

    // edge_config_version is left null in this audit row: the publish is a post-commit cache write
    // (below), so its version is not known yet. The returned op is patched with it in memory; the
    // persisted backfill is the followup job's responsibility (TODO below).
    const op = await insertOperation(tx, opFromPlan(plan, {
      outcome: "accepted",
      edgeConfigVersion: null,
      revisionId,
      reasonCode: null,
    }), plan.diffJson);
    return { op, publish: { snap, revisionId } };
  })) as {
    op: ConfigOperation;
    publish: { snap: ConfigSnapshot; revisionId: string } | null;
  };

  // Phase 2 — AFTER the DB txn has committed, publish the snapshot to the store (its cache, §8.2).
  // A failure here leaves the DB ahead of the store — the SAFE direction (the store simply still
  // points at the prior revision; it can never point at a revision the DB rolled back). The gateway
  // keeps serving the prior published snapshot until reconciliation.
  // TODO(§8.2 followup-job): there is no publish-retry job path yet. When one exists, it must retry
  // store.publish for installations whose applied_config_revision is ahead of the store pointer and
  // backfill config_operation.edge_config_version. Until then a publish failure surfaces to the
  // caller (the DB commit stands) so it is never silently lost.
  if (committed.publish) {
    const published = await store.publish(
      plan.installationId,
      committed.publish.revisionId,
      committed.publish.snap /* ConfigSnapshot IS a ports.Snapshot (evaluator-shaped policies) */,
    );
    committed.op.edgeConfigVersion = published.version;
  }
  return committed.op;
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
 *
 * Two-phase like apply(): the DB txn commits FIRST, then store.publish. Publishing inside the txn
 * (as it did) let the store advance to the rolled-back revision even if a later statement threw and
 * rolled the DB back — the store would then point at a revision the DB never committed. Publish is
 * a cache of committed DB truth, so it MUST happen only after commit; a post-commit publish failure
 * leaves the DB ahead of the store (the safe direction).
 */
export async function rollback(
  sql: PgSql,
  revisionId: string,
  store: SnapshotPublishStore,
): Promise<ConfigOperation> {
  // Phase 1 — DB txn (source of truth). Nothing that advances the external store runs inside it.
  const committed = (await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    const target = await q.readRevisionById(tx, revisionId);
    if (!target) throw new Error(`revision not found: ${revisionId}`);
    await setWorkspaceGuc(tx, target.workspace_id);
    const active = await q.readActiveRevision(tx, target.installation_id);

    if (active && active.id !== target.id) {
      await tx`UPDATE gateway_config_revision SET status = 'rolled_back' WHERE id = ${active.id}`;
    }

    await tx`
      UPDATE gateway_installation SET applied_config_revision = ${target.id}
      WHERE id = ${target.installation_id}`;

    // edge_config_version left null here; the publish (post-commit) yields it and the returned op
    // is patched in memory (mirrors apply()).
    const op = await insertOperation(tx, opFromPlan(
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
        edgeConfigVersion: null,
        revisionId: target.id,
        reasonCode: null,
      },
    ), { rollback: true, restoredRevision: target.id, from: active?.id ?? null });
    return {
      op,
      publish: {
        installationId: target.installation_id,
        revisionId: target.id,
        snap: target.snapshot as ConfigSnapshot,
      },
    };
  })) as {
    op: ConfigOperation;
    publish: { installationId: string; revisionId: string; snap: ConfigSnapshot };
  };

  // Phase 2 — republish the prior revision's stored bytes AFTER the DB txn commits.
  const published = await store.publish(
    committed.publish.installationId,
    committed.publish.revisionId,
    committed.publish.snap,
  );
  committed.op.edgeConfigVersion = published.version;
  return committed.op;
}

export interface KeyOnlyPublishOptions {
  /** Sign the rebuilt snapshot with this ed25519 key (recommended: §7.3 requires a signature). */
  signingKey?: PrivateKeyInput;
  signingKeyId?: string;
}

/**
 * SPEC §8.2 H7 (scoped key publish): rebuild ONLY the snapshot `keys` section against the
 * installation's currently-active route/policy revision and publish it, so a minted/rotated/revoked
 * key goes live without publishing unrelated route/policy DRAFTS. Route/offering/policy/budget
 * sections are carried over verbatim from the active revision.
 *
 * This is the single rebuild → sign → plan → apply core behind the control-plane's mint/revoke
 * expedited publish; the CP is a thin wrapper that supplies its client, store and signing key.
 *
 * Returns `null` (a NO-OP, not an error) when the installation has no active revision yet (nothing
 * to rebuild keys against — the key enters on the first full apply) or when the keys section is
 * unchanged (§8.2 idempotency). This is the one empty-active semantics both callers share.
 *
 * Two-phase, like /config/apply, because RLS (§6.16) hides every workspace-scoped row (revision,
 * profiles, keys) unless `manifold.workspace_id` is set: the keys-only target plan is built inside a
 * workspace-scoped txn (phase 1), then applied with the same top-level `sql` (phase 2) — `apply`
 * opens its OWN txn and sets the GUC itself, so it must NOT be handed the scoped phase-1 tx.
 */
export async function keyOnlyPublish(
  sql: PgSql,
  workspaceId: string,
  installationId: string,
  store: SnapshotPublishStore,
  opts: KeyOnlyPublishOptions = {},
): Promise<ConfigOperation | null> {
  // Phase 1 — rebuild the keys section against the active revision inside the workspace GUC.
  const keyPlan = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    const active = await q.readActiveRevision(tx, installationId);
    if (!active) return null; // no active revision yet → nothing to rebuild keys against

    const base = active.snapshot as ConfigSnapshot;
    const profileIds = Object.values(base.profiles).map((p) => p.id);
    const keys = await buildKeysSection(tx, profileIds);
    // No key change → identical content → no-op (§8.2 idempotency); avoid empty revision churn.
    if (stableStringify(base.keys) === stableStringify(keys)) return null;

    // Rebuild only keys; carry route/offering/policy/budget over unchanged. Fresh revision id +
    // build time via stampMeta; contentHash recomputed (meta is excluded from the content hash),
    // then signed if a key was supplied (§7.3 — signSnapshot recomputes + stamps the hash too).
    let next: ConfigSnapshot = { ...base, keys, meta: stampMeta(base.meta) };
    next.meta.contentHash = computeContentHash(next);
    if (opts.signingKey) next = signSnapshot(next, opts.signingKey, opts.signingKeyId);

    // A key-only rebuild changes no routes/entitlements → no tripwires → no approvals required.
    return plan(tx, installationId, next);
  });

  if (!keyPlan) return null;
  // Phase 2 — apply with the top-level client (its own txn re-checks the base precondition and
  // sets the workspace GUC; §8.2 apply()).
  return apply(sql, keyPlan, store);
}

// buildSnapshot is re-exported for callers wanting a full rebuild before keyOnlyPublish paths.
export { assembleSnapshot };
