// planApply(db, installationId, target) — SPEC §8.2 `plan()`. Diffs a freshly-built target
// snapshot against the current active gateway_config_revision and produces
// {baseConfigHash, targetConfigHash, planHash, diffJson, tripwireItems}. Route deletions and
// entitlement removals are tripwires (destructive changes needing approval, §8.2).
import type { Database } from "@manifold/database";
import { sha256Canonical, stableStringify } from "./canonical.js";
import * as q from "./db.js";
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
} {
  return {
    profiles: (snap?.profiles as Rec) ?? {},
    keys: (snap?.keys as Rec) ?? {},
    routes: (snap?.routes as Rec) ?? {},
    offerings: (snap?.offerings as Rec) ?? {},
    policies: (snap?.policies as Rec) ?? {},
  };
}

export async function planApply(
  db: Database,
  installationId: string,
  target: ConfigSnapshot,
): Promise<Plan> {
  const sql = q.client(db);
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
  };

  // Tripwires (§8.2): destructive changes require approval.
  const tripwireItems: TripwireItem[] = [];
  for (const routeKey of diffJson.routes.removed) {
    tripwireItems.push({ kind: "route_delete", ref: routeKey, detail: {} });
  }
  // Entitlement removals: an `allow` present in a base policy that is gone from the target.
  for (const prid of Object.keys(b.policies)) {
    const basePol = b.policies[prid] as ConfigPolicy | undefined;
    const targetPol = t.policies[prid] as ConfigPolicy | undefined;
    const baseAllows = new Set(
      (basePol?.entitlements ?? [])
        .filter((e) => e.effect === "allow")
        .map((e) => `${e.subjectKind}:${e.subjectRef ?? "*"}=>${e.offeringId ?? e.canonicalModelId ?? "*"}`),
    );
    const targetAllows = new Set(
      (targetPol?.entitlements ?? [])
        .filter((e) => e.effect === "allow")
        .map((e) => `${e.subjectKind}:${e.subjectRef ?? "*"}=>${e.offeringId ?? e.canonicalModelId ?? "*"}`),
    );
    for (const a of baseAllows) {
      if (!targetAllows.has(a)) {
        tripwireItems.push({ kind: "entitlement_removal", ref: a, detail: { policyRevision: prid } });
      }
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
