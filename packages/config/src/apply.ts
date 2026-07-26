// Config publishing lifecycle writes (SPEC §8.2, §6.11).
//
//  apply(sql, plan, store)       — one txn: precondition base==active, insert new active
//                                  gateway_config_revision + flip prior to superseded, publish
//                                  to the store, record config_operation.
//  rollback(sql, revisionId, store) — republish a prior revision's stored snapshot bytes.
//  keyOnlyPublish(sql, workspaceId, installationId, store, opts) — SPEC §8.2 H7: rebuild only the
//                                  keys section against the active route/policy revision and publish
//                                  (expedited path; the single core the control-plane wraps).
//  healthOnlyPublish(...)        — rebuild only active target health states from the durable rollup.
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

async function insertOperation(
  sql: PgSql,
  op: Omit<ConfigOperation, "id"> & { workspaceId: string },
  diffJson: unknown = {},
  meta: {
    operationKind?: "apply" | "rollback" | "key_publish" | "health_publish";
    revisionId?: string | null;
    servingMode?: "boot_fallback" | "edge_config";
    acceleratorStatus?:
      | "not_configured"
      | "pending"
      | "published"
      | "reconciliation_required"
      | "superseded";
    createdBy?: string | null;
    approvedBy?: string | null;
    mutationKey?: string;
  } = {},
): Promise<ConfigOperation> {
  const id = genId("cfgop");
  await sql`
    INSERT INTO config_operation
      (id, workspace_id, installation_id, base_config_hash, target_config_hash, plan_hash,
       diff_json, outcome, operation_kind, revision_id, serving_mode, accelerator_status,
       edge_config_version, tripwire_items, approved_by, error, created_by, completed_at, mutation_key)
    VALUES
      (${id}, ${op.workspaceId}, ${op.installationId}, ${op.baseConfigHash},
       ${op.targetConfigHash}, ${op.planHash}, ${sql.json(q.jval(diffJson))},
       ${op.outcome}, ${meta.operationKind ?? "apply"}, ${meta.revisionId ?? op.revisionId},
       ${meta.servingMode ?? "boot_fallback"},
       ${meta.acceleratorStatus ?? "not_configured"}, ${op.edgeConfigVersion},
       ${sql.json(q.jval(op.tripwireItems))},
       ${meta.approvedBy ?? null},
       ${op.reasonCode ? sql.json(q.jval({ reason_code: op.reasonCode })) : null},
       ${meta.createdBy ?? null},
       ${meta.acceleratorStatus === "pending" ? null : sql`now()`}, ${meta.mutationKey ?? null})`;
  return { id, ...op };
}

export interface ConfigMutationOptions {
  actorKind?: "api_token" | "member";
  actorId?: string;
  memberId?: string;
  approvalIds?: string[];
  operationKind?: "apply" | "rollback" | "key_publish" | "health_publish";
  requestId?: string;
  workspaceId?: string;
  expectedBaseConfigHash?: string | null;
  /** Principal-and-route-bound idempotency identity supplied by the control-plane guard. */
  mutationKey?: string;
}

async function existingMutationOperation(
  sql: PgSql,
  workspaceId: string,
  mutationKey: string | undefined,
): Promise<ConfigOperation | null> {
  if (!mutationKey) return null;
  const rows = await sql<ConfigOperation[]>`
    SELECT id, workspace_id AS "workspaceId", installation_id AS "installationId",
           base_config_hash AS "baseConfigHash", target_config_hash AS "targetConfigHash",
           plan_hash AS "planHash", outcome, edge_config_version AS "edgeConfigVersion",
           revision_id AS "revisionId", tripwire_items AS "tripwireItems",
           error->>'reason_code' AS "reasonCode"
    FROM config_operation
    WHERE workspace_id = ${workspaceId} AND mutation_key = ${mutationKey}
    LIMIT 1 FOR UPDATE`;
  return rows[0] ?? null;
}

async function insertAudit(
  sql: PgSql,
  workspaceId: string,
  options: ConfigMutationOptions,
  action: "config.apply" | "config.rollback",
  targetId: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!options.actorKind || !options.actorId) return;
  await sql`
    INSERT INTO audit_event
      (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
       request_ref, detail, created_at)
    VALUES
      (${genId("aud")}, ${workspaceId}, ${options.actorKind}, ${options.actorId},
       ${action}, 'gateway_config_revision', ${targetId}, ${options.requestId ?? null},
       ${sql.json(q.jval(detail))}, now())`;
}

async function persistPublishSuccess(
  sql: PgSql,
  workspaceId: string,
  operationId: string,
  version: string,
): Promise<void> {
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    await tx`
      UPDATE config_operation
      SET edge_config_version = ${version}, accelerator_status = 'published',
          completed_at = now(), error = NULL
      WHERE id = ${operationId} AND workspace_id = ${workspaceId}`;
  });
}

async function persistPublishFailure(
  sql: PgSql,
  workspaceId: string,
  operationId: string,
  installationId: string,
  revisionId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    await tx`
      UPDATE config_operation
      SET accelerator_status = 'reconciliation_required',
          error = ${tx.json(q.jval({ message, reconciliation_required: true }))}
      WHERE id = ${operationId} AND workspace_id = ${workspaceId}`;
    const key = `config_publish:${operationId}`;
    await tx`
      INSERT INTO job_ledger
        (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
      SELECT ${genId("job")}, ${workspaceId}, 'config_publish_reconcile',
        ${tx.json(q.jval({ operationId, installationId, revisionId }))},
        ${key}, 'pending', 0, now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM job_ledger
        WHERE workspace_id = ${workspaceId} AND idempotency_key = ${key}
      )`;
  });
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
  store: SnapshotPublishStore | null,
  approvals: Approval[] = [],
  options: ConfigMutationOptions = {},
): Promise<ConfigOperation> {
  // Phase 1 — the DB transaction is the SOURCE OF TRUTH (§8.2). Nothing that advances the external
  // store happens inside it: store.publish used to run mid-txn (before the installation update +
  // config_operation insert), so if any later statement threw, the txn rolled back but the store had
  // ALREADY advanced → the store pointed at a revision the DB no longer considered active (review
  // bug). The store is a cache of committed DB truth, so publish MUST happen only AFTER commit.
  const committed = (await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, plan.workspaceId);
    const replayed = await existingMutationOperation(tx, plan.workspaceId, options.mutationKey);
    if (replayed) return { op: replayed, publish: null };
    // Serialize all applies for an installation so the optimistic-concurrency loser is recorded
    // as CONFIG_PRECONDITION_FAILED instead of leaking a partial-index violation.
    await tx`
      SELECT id FROM gateway_installation
      WHERE id = ${plan.installationId} AND workspace_id = ${plan.workspaceId}
      FOR UPDATE`;
    const active = await q.readActiveRevision(tx, plan.installationId);
    const activeHash = active?.content_hash ?? null;

    // Optimistic-concurrency precondition (§16.2): base must equal the live active hash.
    if (activeHash !== plan.baseConfigHash) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "rejected",
        edgeConfigVersion: null,
        revisionId: null,
        reasonCode: ReasonCode.enum.CONFIG_PRECONDITION_FAILED,
      }), plan.diffJson, {
        operationKind: options.operationKind,
        mutationKey: options.mutationKey,
        createdBy: options.memberId ?? null,
      });
      return { op, publish: null };
    }

    // Idempotency (§8.2): identical content is a no-op (no new revision, nothing to publish).
    if (plan.targetConfigHash === activeHash) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "accepted",
        edgeConfigVersion: null,
        revisionId: active?.id ?? null,
        reasonCode: null,
      }), plan.diffJson, {
        operationKind: options.operationKind,
        mutationKey: options.mutationKey,
        revisionId: active?.id ?? null,
        createdBy: options.memberId ?? null,
      });
      return { op, publish: null };
    }

    const approvalIds = [...new Set(options.approvalIds ?? [])];
    const persistedApprovals = approvalIds.length === 0
      ? []
      : await tx<{
          id: string;
          kind: Approval["kind"];
          ref: string;
          plan_hash: string;
          approved_by: string;
          expires_at: string;
          used_at: string | null;
        }[]>`
          SELECT id, kind, ref, plan_hash, approved_by, expires_at, used_at
          FROM config_tripwire_approval
          WHERE workspace_id = ${plan.workspaceId}
            AND installation_id = ${plan.installationId}
            AND id = ANY(${approvalIds})
            AND plan_hash = ${plan.planHash}
            AND used_at IS NULL
            AND expires_at > now()
          FOR UPDATE`;
    const durableApprovals: Approval[] = persistedApprovals
      .filter(
        (approval) =>
          !approval.used_at && approval.plan_hash === plan.planHash,
      )
      .map((approval) => ({
        kind: approval.kind,
        ref: approval.ref,
        planHash: approval.plan_hash,
      }));
    const allApprovals = [...approvals, ...durableApprovals];

    // Tripwire approval gate (§8.2): a destructive change applies ONLY with a matching approval.
    // Match on {kind, ref} AND the plan's planHash, so an approval minted against a stale plan can
    // never wave through a different destructive change. Any uncovered tripwire → reject (do NOT
    // insert the new active revision); the audit row still commits (CONFIG_TRIPWIRE_HELD).
    const heldTripwires = plan.tripwireItems.filter(
      (it) =>
        !allApprovals.some(
          (a) => a.kind === it.kind && a.ref === it.ref && a.planHash === plan.planHash,
        ),
    );
    if (heldTripwires.length > 0) {
      const op = await insertOperation(tx, opFromPlan(plan, {
        outcome: "rejected",
        edgeConfigVersion: null,
        revisionId: null,
        reasonCode: ReasonCode.enum.CONFIG_TRIPWIRE_HELD,
      }), plan.diffJson, {
        operationKind: options.operationKind,
        mutationKey: options.mutationKey,
        createdBy: options.memberId ?? null,
      });
      return { op, publish: null };
    }

    const historical = await tx<{
      id: string;
      snapshot: ConfigSnapshot;
      status: string;
    }[]>`
      SELECT id, snapshot, status FROM gateway_config_revision
      WHERE installation_id = ${plan.installationId}
        AND content_hash = ${plan.targetConfigHash}
      LIMIT 1`;
    const restored = historical[0];
    const snap = restored?.snapshot ?? plan.snapshot;
    const revisionId = restored?.id ?? snap.meta.revision;

    // Flip prior active → superseded (guard allows active→superseded), then insert new active.
    if (active) {
      await tx`UPDATE gateway_config_revision SET status = 'superseded' WHERE id = ${active.id}`;
    }
    if (restored) {
      await tx`UPDATE gateway_config_revision SET status = 'active' WHERE id = ${revisionId}`;
    } else {
      await tx`
        INSERT INTO gateway_config_revision
          (id, workspace_id, installation_id, content_hash, parent_revision_id, snapshot, status,
           created_by)
        VALUES
          (${revisionId}, ${plan.workspaceId}, ${plan.installationId}, ${plan.targetConfigHash},
           ${active?.id ?? null}, ${tx.json(q.jval(snap))}, 'active',
           ${options.memberId ?? null})`;
    }

    // DB activation commits before the external accelerator write. The operation starts pending
    // and is durably completed or marked reconciliation_required after that write.
    const op = await insertOperation(tx, opFromPlan(plan, {
      outcome: "accepted",
      edgeConfigVersion: null,
      revisionId,
      reasonCode: null,
    }), plan.diffJson, {
      operationKind: options.operationKind,
      mutationKey: options.mutationKey,
      revisionId,
      servingMode: store ? "edge_config" : "boot_fallback",
      acceleratorStatus: store ? "pending" : "not_configured",
      createdBy: options.memberId ?? null,
      approvedBy:
        plan.tripwireItems.length > 0
          ? persistedApprovals[0]?.approved_by ?? options.memberId ?? null
          : null,
    });
    // The external mirror is deliberately outside this transaction.  Its durable keyed job is
    // inside it, so a process crash between commit and publish cannot turn a reclaimed HTTP lease
    // into another authoritative config operation (or lose the pending publication).
    if (store) {
      const key = `config_publish:${op.id}`;
      await tx`
        INSERT INTO job_ledger
          (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
        VALUES (${genId("job")}, ${plan.workspaceId}, 'config_publish_reconcile',
          ${tx.json(q.jval({ operationId: op.id, installationId: plan.installationId, revisionId }))},
          ${key}, 'pending', 0, now(), now())
        ON CONFLICT (kind, idempotency_key) DO NOTHING`;
    }
    if (persistedApprovals.length > 0) {
      await tx`
        UPDATE config_tripwire_approval
        SET used_at = now(), used_by_operation_id = ${op.id}
        WHERE id = ANY(${persistedApprovals.map((approval) => approval.id)})
          AND used_at IS NULL
          AND expires_at > now()
          AND plan_hash = ${plan.planHash}`;
    }
    await insertAudit(tx, plan.workspaceId, options, "config.apply", revisionId, {
      operationId: op.id,
      baseConfigHash: plan.baseConfigHash,
      targetConfigHash: plan.targetConfigHash,
      servingMode: store ? "edge_config" : "boot_fallback",
      tripwireItems: plan.tripwireItems,
    });
    return { op, publish: { snap, revisionId } };
  })) as {
    op: ConfigOperation;
    publish: { snap: ConfigSnapshot; revisionId: string } | null;
  };

  // Phase 2 — AFTER the DB txn has committed, publish the snapshot to the store (its cache, §8.2).
  // A failure here leaves the DB ahead of the store — the SAFE direction (the store simply still
  // points at the prior revision; it can never point at a revision the DB rolled back). The gateway
  // keeps serving committed DB truth through boot fallback until reconciliation.
  // A worker claims `config_publish:${op.id}` after commit.  Do not publish from this request:
  // the transaction is the authority and the job claim is the sole external-effect fence.
  return committed.op;
}

/**
 * SPEC §8.2 rollback(): republish a prior revision's stored snapshot bytes — no rebuild, so it
 * is byte-identical and its existing signature stays valid. It marks the current revision
 * rolled_back and reactivates the selected historical row without rebuilding its snapshot.
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
  store: SnapshotPublishStore | null,
  options: ConfigMutationOptions = {},
): Promise<ConfigOperation> {
  if (!options.workspaceId) throw new Error("rollback requires workspaceId");
  const workspaceId = options.workspaceId;
  // Phase 1 — DB txn (source of truth). Nothing that advances the external store runs inside it.
  const committed = (await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    const replayed = await existingMutationOperation(tx, workspaceId, options.mutationKey);
    if (replayed) return { op: replayed, publish: null };
    const target = await q.readRevisionById(tx, revisionId);
    if (!target) throw new Error(`revision not found: ${revisionId}`);
    await tx`SELECT id FROM gateway_installation WHERE id = ${target.installation_id} FOR UPDATE`;
    const active = await q.readActiveRevision(tx, target.installation_id);
    if (
      options.expectedBaseConfigHash !== undefined &&
      active?.content_hash !== options.expectedBaseConfigHash
    ) {
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
          outcome: "rejected",
          edgeConfigVersion: null,
          revisionId: null,
          reasonCode: ReasonCode.enum.CONFIG_PRECONDITION_FAILED,
        },
      ), { rollback: true, restoredRevision: target.id, from: active?.id ?? null }, {
        operationKind: "rollback",
        mutationKey: options.mutationKey,
        createdBy: options.memberId ?? null,
      });
      return { op, publish: null };
    }

    if (active && active.id !== target.id) {
      await tx`UPDATE gateway_config_revision SET status = 'rolled_back' WHERE id = ${active.id}`;
    }
    if (target.status !== "active") {
      await tx`UPDATE gateway_config_revision SET status = 'active' WHERE id = ${target.id}`;
    }

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
    ), { rollback: true, restoredRevision: target.id, from: active?.id ?? null }, {
      operationKind: "rollback",
      mutationKey: options.mutationKey,
      revisionId: target.id,
      servingMode: store ? "edge_config" : "boot_fallback",
      acceleratorStatus: store ? "pending" : "not_configured",
      createdBy: options.memberId ?? null,
    });
    if (store) {
      const key = `config_publish:${op.id}`;
      await tx`
        INSERT INTO job_ledger
          (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
        VALUES (${genId("job")}, ${target.workspace_id}, 'config_publish_reconcile',
          ${tx.json(q.jval({ operationId: op.id, installationId: target.installation_id, revisionId: target.id }))},
          ${key}, 'pending', 0, now(), now())
        ON CONFLICT (kind, idempotency_key) DO NOTHING`;
    }
    await insertAudit(tx, target.workspace_id, options, "config.rollback", target.id, {
      operationId: op.id,
      fromRevisionId: active?.id ?? null,
      restoredRevisionId: target.id,
      byteIdentical: true,
      servingMode: store ? "edge_config" : "boot_fallback",
    });
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
    publish: { installationId: string; revisionId: string; snap: ConfigSnapshot } | null;
  };

  // Phase 2 — republish the prior revision's stored bytes AFTER the DB txn commits.
  // See apply(): the keyed job is the only publication executor.
  return committed.op;
}

export interface KeyOnlyPublishOptions {
  /** Sign the rebuilt snapshot with this ed25519 key (recommended: §7.3 requires a signature). */
  signingKey?: PrivateKeyInput;
  signingKeyId?: string;
}

/** Signing inputs for the health rollup's scoped snapshot publication. */
export interface HealthOnlyPublishOptions {
  /** Health state is gateway admission data, so every emitted revision must be freshly signed. */
  signingKey: PrivateKeyInput;
  signingKeyId?: string;
}

type SnapshotHealthState = "healthy" | "degraded" | "unhealthy" | "unknown";

interface TargetHealthProjection {
  targetId: string;
  sourceState: SnapshotHealthState;
  effectiveState: SnapshotHealthState;
}

function validHealthState(value: string): SnapshotHealthState {
  return value === "healthy" || value === "degraded" || value === "unhealthy" || value === "unknown"
    ? value
    : "unknown";
}

/**
 * Mark exactly the durable health facts incorporated into an active signed revision.  A rollup
 * that raced after the scoped read retains its newer `state`: the `h.state = sourceState` guard
 * makes this update a no-op, so the next coalesced health publication carries that newer fact.
 */
async function markHealthStatesPublished(
  sql: PgSql,
  workspaceId: string,
  installationId: string,
  revisionId: string,
  projections: TargetHealthProjection[],
): Promise<void> {
  if (projections.length === 0) return;
  await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    await tx`
      UPDATE gateway_target_health AS h
      SET published_state = desired.effective_state
      FROM UNNEST(
        ${projections.map((projection) => projection.targetId)}::text[],
        ${projections.map((projection) => projection.sourceState)}::text[],
        ${projections.map((projection) => projection.effectiveState)}::text[]
      ) AS desired(target_id, source_state, effective_state)
      WHERE h.workspace_id = ${workspaceId}
        AND h.installation_id = ${installationId}
        AND h.target_id = desired.target_id
        AND h.state = desired.source_state
        AND EXISTS (
          SELECT 1 FROM gateway_config_revision AS r
          WHERE r.id = ${revisionId}
            AND r.installation_id = ${installationId}
            AND r.status = 'active'
        )`;
  });
}

/**
 * Publish only the active snapshot's target health overlay.  Operator-managed routes, profiles,
 * keys, offerings, policies, and budgets are copied byte-for-byte from the active signed snapshot;
 * this path never rebuilds them from mutable tables.  Projection facts whose expiry has elapsed
 * (and targets without a projection) become `unknown` so a stale health assessment cannot keep a
 * target quarantined indefinitely.
 *
 * Like keyOnlyPublish, planning happens in one RLS-scoped transaction and `apply` rechecks the
 * active content hash in its own transaction.  A route/config write that lands between those phases
 * therefore rejects this health operation instead of allowing a stale base to overwrite it.
 */
export async function healthOnlyPublish(
  sql: PgSql,
  workspaceId: string,
  installationId: string,
  store: SnapshotPublishStore | null,
  opts: HealthOnlyPublishOptions,
): Promise<ConfigOperation | null> {
  const prepared = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as PgSql;
    await setWorkspaceGuc(tx, workspaceId);
    const active = await q.readActiveRevision(tx, installationId);
    if (!active) return null;

    const base = active.snapshot as ConfigSnapshot;
    const targetIds = [...new Set(
      Object.values(base.routes)
        .flatMap((route) => route.targets)
        .flatMap((target) => target.targetId ? [target.targetId] : []),
    )];
    const rows = targetIds.length === 0
      ? []
      : await tx<{ target_id: string; state: string; effective_state: string }[]>`
          SELECT target_id, state,
                 CASE WHEN next_expiry_at > now() THEN state ELSE 'unknown' END AS effective_state
          FROM gateway_target_health
          WHERE workspace_id = ${workspaceId}
            AND installation_id = ${installationId}
            AND target_id IN ${tx(targetIds)}`;
    const byTargetId = new Map<string, TargetHealthProjection>(
      rows.map((row) => [row.target_id, {
        targetId: row.target_id,
        sourceState: validHealthState(row.state),
        effectiveState: validHealthState(row.effective_state),
      }]),
    );
    const projections = [...byTargetId.values()];
    let changed = false;
    const routes = Object.fromEntries(Object.entries(base.routes).map(([key, route]) => [key, {
      ...route,
      targets: route.targets.map((target) => {
        const state = target.targetId
          ? byTargetId.get(target.targetId)?.effectiveState ?? "unknown"
          : "unknown";
        if (target.healthState === state) return target;
        changed = true;
        return { ...target, healthState: state };
      }),
    }]));
    if (!changed) return null;

    let next: ConfigSnapshot = { ...base, routes, meta: stampMeta(base.meta) };
    next.meta.contentHash = computeContentHash(next);
    next = signSnapshot(next, opts.signingKey, opts.signingKeyId);
    return { healthPlan: await plan(tx, installationId, next), projections };
  });

  if (!prepared) return null;
  const op = await apply(sql, prepared.healthPlan, store, [], { operationKind: "health_publish" });
  if (op.outcome === "accepted" && op.revisionId) {
    await markHealthStatesPublished(sql, workspaceId, installationId, op.revisionId, prepared.projections);
  }
  return op;
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
  store: SnapshotPublishStore | null,
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
  return apply(sql, keyPlan, store, [], { operationKind: "key_publish" });
}

// buildSnapshot is re-exported for callers wanting a full rebuild before keyOnlyPublish paths.
export { assembleSnapshot };
