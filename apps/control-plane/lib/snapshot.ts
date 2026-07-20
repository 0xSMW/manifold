// Snapshot signing config + the publish store singleton (SPEC §7.3, §8.2).
//
// The control plane holds the ed25519 snapshot-signing private key
// (MANIFOLD_SNAPSHOT_SIGNING_KEY, base64 32-byte seed); the gateway pins only the public half
// (MANIFOLD_SNAPSHOT_PUBLIC_KEY). buildSnapshot → signSnapshot stamps meta.signature over the
// content hash; verifySnapshot (used by a real loader / our verify harness) accepts it.
//
// The DB (gateway_config_revision) is the source of truth for the active snapshot; the store is
// its cache (§8.2). We keep an in-process InMemorySnapshotStore so `apply` gets an edge version
// handle; /config/active reads the signed bytes from the DB, not the store.
import {
  InMemorySnapshotStore,
  apply,
  buildKeysSection,
  buildSnapshot,
  computeContentHash,
  genId,
  planApply,
  signSnapshot as signSnapshotImpl,
  stableStringify,
  type ConfigOperation,
  type ConfigSnapshot,
} from "@manifold/config";
import type { Database } from "@manifold/database";
import { db, withWorkspace } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

let store: InMemorySnapshotStore | null = null;

export function snapshotStore(): InMemorySnapshotStore {
  if (!store) store = new InMemorySnapshotStore();
  return store;
}

function signingKey(): string {
  const key = process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY;
  if (!key) {
    throw new ManifoldError({
      status: 500,
      code: "INTERNAL",
      message: "MANIFOLD_SNAPSHOT_SIGNING_KEY is not configured",
      reasonCodes: [],
    });
  }
  return key;
}

/** Sign a freshly-built snapshot with the configured ed25519 key (§7.3). */
export function signSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return signSnapshotImpl(
    snapshot,
    signingKey(),
    process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY_ID,
  );
}

/**
 * The deterministic plan pipeline shared by /config/plan and /config/apply:
 * buildSnapshot → signSnapshot → planApply. Extracting it guarantees both routes hash the
 * SAME bytes, so planHash cannot diverge between plan-time and apply-time (§8.2, §16.2). The
 * target content hash excludes build time, so a re-plan at apply reproduces the caller's plan.
 *
 * CRITICAL (§6.16/§15.2): the app connects as the non-superuser `manifold_app` role, so RLS is
 * live. buildSnapshot/planApply read installation/profiles/routes/keys/credentials, which are all
 * workspace-scoped — with no `manifold.workspace_id` GUC set they return ZERO rows (empty snapshot
 * / "installation not found"). We therefore run the whole pipeline inside `withWorkspace`, which
 * opens a txn and sets the GUC, and hand buildSnapshot/planApply that GUC-scoped connection.
 */
export function buildSignedPlan(workspaceId: string, installationId: string) {
  return withWorkspace(workspaceId, async (sql) => {
    // buildSnapshot/planApply only touch `db.$client`; give them the GUC-scoped tx as that client.
    const scoped = { $client: sql } as unknown as Database;
    const built = await buildSnapshot(scoped, installationId);
    return planApply(scoped, installationId, signSnapshot(built));
  });
}

/**
 * SPEC §8.2 H7 (scoped key publish): rebuild ONLY the snapshot `keys` section against the
 * installation's active revision and publish it, so a freshly minted / revoked virtual key
 * enters the active snapshot immediately — the gateway is snapshot-only auth (§7.4), so without
 * this it returns AUTH_KEY_UNKNOWN (mint) / keeps accepting a revoked key (revoke) until the next
 * full config apply. Route/offering/policy sections are carried over verbatim, so unrelated
 * route/policy DRAFTS are NOT published (that is the whole point of the H7 scoped path).
 *
 * Structured like /config/apply: the keys-only target plan is built INSIDE `withWorkspace` (the
 * workspace GUC) because RLS hides every workspace-scoped row (revision, profiles, keys) with no
 * `manifold.workspace_id` set as non-superuser `manifold_app` (§6.16); the plan is then applied
 * with the real top-level client (`apply` opens its OWN txn and sets the GUC itself — the scoped
 * transaction handed to the builder has no `.begin`).
 *
 * Returns `null` (a no-op, NOT an error) when the installation has no active revision yet (nothing
 * to rebuild keys against → the key enters on the first full apply) or when the keys section is
 * unchanged (§8.2 idempotency).
 */
export async function publishKeysOnly(
  workspaceId: string,
  installationId: string,
): Promise<ConfigOperation | null> {
  const plan = await withWorkspace(workspaceId, async (sql) => {
    const scoped = { $client: sql } as unknown as Database;
    const rows = await sql<{ content_hash: string; snapshot: unknown }[]>`
      SELECT content_hash, snapshot FROM gateway_config_revision
      WHERE installation_id = ${installationId} AND workspace_id = ${workspaceId}
        AND status = 'active' LIMIT 1`;
    const active = rows[0];
    if (!active) return null; // no active revision yet → nothing to rebuild keys against

    const base = active.snapshot as ConfigSnapshot;
    const profileIds = Object.values(base.profiles).map((p) => p.id);
    const keys = await buildKeysSection(sql, profileIds);
    // No key change → identical content → no-op (§8.2 idempotency); avoid an empty revision churn.
    if (stableStringify(base.keys) === stableStringify(keys)) return null;

    // Rebuild ONLY keys; carry route/offering/policy over unchanged. Fresh revision id + build
    // time; contentHash/signature recomputed (meta is excluded from the content hash).
    const next: ConfigSnapshot = {
      ...base,
      keys,
      meta: {
        ...base.meta,
        revision: genId("cfgrev"),
        contentHash: "",
        builtAt: new Date().toISOString(),
        signature: "",
      },
    };
    next.meta.contentHash = computeContentHash(next);
    return planApply(scoped, installationId, signSnapshot(next));
  });

  if (!plan) return null;
  // Apply with the real client (its own txn sets the workspace GUC; §8.2 apply()).
  return apply(db(), plan, snapshotStore());
}
