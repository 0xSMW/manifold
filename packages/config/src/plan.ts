// plan(sql, installationId, target) — SPEC §8.2 `plan()`. Diffs a freshly-built target
// snapshot against the current active gateway_config_revision and produces
// {baseConfigHash, targetConfigHash, planHash, diffJson, tripwireItems}. Route deletions and
// entitlement removals are tripwires (destructive changes needing approval, §8.2). Paired with
// `apply()` (apply.ts) — the two lifecycle halves now share the plan()/apply() naming.
import { sha256Canonical, stableStringify } from "./canonical.js";
import * as q from "./db.js";
import type { PgSql } from "./db.js";
import type {
  ConfigPolicy,
  ConfigSnapshot,
  Plan,
  PlanDiff,
  TripwireItem,
} from "./types.js";

type Rec = Record<string, unknown>;

/** added / removed / changed key sets between two record maps (changed = value differs). */
function diffMaps(base: Rec, target: Rec): { added: string[]; removed: string[]; changed: string[] } {
  const baseKeys = new Set(Object.keys(base));
  const targetKeys = new Set(Object.keys(target));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of targetKeys) if (!baseKeys.has(k)) added.push(k);
  for (const k of baseKeys) {
    if (!targetKeys.has(k)) {
      removed.push(k);
    } else if (stableStringify(base[k]) !== stableStringify(target[k])) {
      changed.push(k);
    }
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

function emptySnapshotSections(snap: Partial<ConfigSnapshot> | null): {
  profiles: Rec;
  keys: Rec;
  routes: Rec;
  offerings: Rec;
  policies: Rec;
  budgets: Rec;
} {
  return {
    profiles: (snap?.profiles as Rec) ?? {},
    keys: (snap?.keys as Rec) ?? {},
    routes: (snap?.routes as Rec) ?? {},
    offerings: (snap?.offerings as Rec) ?? {},
    policies: (snap?.policies as Rec) ?? {},
    // `budgets` is part of the signed content (canonical.ts) — a budget-only edit changes the
    // content hash, so it is NOT a no-op. Diff it here too so the plan surfaces the change (a
    // hard→advisory enforcement flip / an account removal shows up in diffJson.budgets).
    budgets: (snap?.budgets as Rec) ?? {},
  };
}

export async function plan(
  sql: PgSql,
  installationId: string,
  target: ConfigSnapshot,
): Promise<Plan> {
  const inst = await q.readInstallation(sql, installationId);
  if (!inst) throw new Error(`installation not found: ${installationId}`);
  const active = await q.readActiveRevision(sql, installationId);
  const base = active ? (active.snapshot as ConfigSnapshot) : null;

  const b = emptySnapshotSections(base);
  const t = emptySnapshotSections(target);

  const diffJson: PlanDiff = {
    routes: diffMaps(b.routes, t.routes),
    keys: diffMaps(b.keys, t.keys),
    offerings: diffMaps(b.offerings, t.offerings),
    policies: diffMaps(b.policies, t.policies),
    budgets: diffMaps(b.budgets, t.budgets),
  };

  // Tripwires (§8.2): destructive changes require approval.
  const tripwireItems: TripwireItem[] = [];
  for (const routeKey of diffJson.routes.removed) {
    tripwireItems.push({ kind: "route_delete", ref: routeKey, detail: {} });
  }
  // Entitlement removals: an entitlement present in a base policy that is gone from the target.
  // Both `allow` AND `deny` removals are tripwires: dropping a `deny` silently OPENS access to
  // whatever it used to block, which is exactly as destructive as dropping an `allow` (review bug
  // — this loop previously covered `allow` only, so a deny-entitlement removal shipped with no
  // approval gate at all). `effect` is folded into the ref so an allow-removal and a deny-removal
  // for the same subject+model never collide under one {kind, ref} approval.
  for (const prid of Object.keys(b.policies)) {
    const basePol = b.policies[prid] as ConfigPolicy | undefined;
    const targetPol = t.policies[prid] as ConfigPolicy | undefined;
    for (const effect of ["allow", "deny"] as const) {
      const refOf = (e: { subjectKind: string; subjectRef: string | null; offeringId: string | null; canonicalModelId: string | null }) =>
        `${effect}:${e.subjectKind}:${e.subjectRef ?? "*"}=>${e.offeringId ?? e.canonicalModelId ?? "*"}`;
      const baseSet = new Set(
        (basePol?.entitlements ?? []).filter((e) => e.effect === effect).map(refOf),
      );
      const targetSet = new Set(
        (targetPol?.entitlements ?? []).filter((e) => e.effect === effect).map(refOf),
      );
      for (const ref of baseSet) {
        if (!targetSet.has(ref)) {
          tripwireItems.push({ kind: "entitlement_removal", ref, detail: { policyRevision: prid, effect } });
        }
      }
    }
  }
  // Budget enforcement relaxation: a budget account present in both base and target whose
  // enforcement flips 'hard' -> anything else (i.e. 'advisory'). A hard budget stops dispatch at
  // cap; silently downgrading it to advisory removes that enforcement with no visible route/
  // entitlement change to signal it (review bug — no tripwire covered this at all), so a
  // budget-only edit could relax spend enforcement without approval.
  for (const id of Object.keys(b.budgets)) {
    const baseBudget = b.budgets[id] as { enforcement?: string } | undefined;
    const targetBudget = t.budgets[id] as { enforcement?: string } | undefined;
    if (baseBudget?.enforcement === "hard" && targetBudget && targetBudget.enforcement !== "hard") {
      tripwireItems.push({
        kind: "budget_enforcement_relaxed",
        ref: id,
        detail: { from: baseBudget.enforcement, to: targetBudget.enforcement },
      });
    }
  }

  const baseConfigHash = active?.content_hash ?? null;
  const targetConfigHash = target.meta.contentHash;
  const planHash = sha256Canonical({ baseConfigHash, targetConfigHash, diffJson });

  return {
    installationId,
    workspaceId: inst.workspace_id,
    baseConfigHash,
    targetConfigHash,
    planHash,
    diffJson,
    tripwireItems,
    snapshot: target,
    noop: baseConfigHash === targetConfigHash,
  };
}
