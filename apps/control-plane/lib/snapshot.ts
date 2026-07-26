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
import { randomUUID } from "node:crypto";
import {
  buildSnapshot,
  healthOnlyPublish,
  keyOnlyPublish,
  plan,
  signSnapshot as signSnapshotImpl,
  type ConfigOperation,
  type ConfigSnapshot,
  type SnapshotPublishStore,
} from "@manifold/config";
import { db, withWorkspace, type Sql } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

const EDGE_CONFIG_MAX_BYTES = 512 * 1024;
const EDGE_CONFIG_CUTOFF_BYTES = Math.floor(EDGE_CONFIG_MAX_BYTES * 0.95);
// The request deadline must be strictly shorter than a reclaimable publication lease.  The
// Edge Config adapter also passes this deadline to fetch so a timed-out request cannot keep
// running after another worker is allowed to reclaim the fence.
const PUBLICATION_REQUEST_TIMEOUT_MS = 15_000;
const PUBLICATION_LEASE_SECONDS = 60;
let store: SnapshotPublishStore | null | undefined;

function edgeConfigCredentials(): {
  id: string;
  token: string;
  teamId?: string;
} | null {
  const id = process.env.MANIFOLD_EDGE_CONFIG_ID?.trim();
  const token = process.env.MANIFOLD_EDGE_CONFIG_WRITE_TOKEN?.trim();
  if (!id || !token) return null;
  return {
    id,
    token,
    teamId: process.env.MANIFOLD_EDGE_CONFIG_TEAM_ID?.trim() || undefined,
  };
}

function edgeConfigStore(): SnapshotPublishStore | null {
  if (store !== undefined) return store;
  const credentials = edgeConfigCredentials();
  if (!credentials) {
    store = null;
    return store;
  }
  const managementUrl = (path: string) => {
    const url = new URL(`https://api.vercel.com/v1/edge-config/${credentials.id}${path}`);
    if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
    return url;
  };
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(managementUrl(path), {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(PUBLICATION_REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Edge Config publication failed with HTTP ${response.status}`);
    }
    return body;
  };
  store = {
    async publish(installationId, revision, snapshot, options) {
      const suffix = installationId.replace(/[^A-Za-z0-9_-]/g, "_");
      await request("/items", {
        method: "PATCH",
        signal: options?.signal,
        body: JSON.stringify({
          items: [
            { operation: "upsert", key: `snapshot_${suffix}`, value: snapshot },
            { operation: "upsert", key: `active_${suffix}`, value: { revision } },
          ],
        }),
      });
      const metadata = (await request("")) as { digest?: unknown };
      if (typeof metadata.digest !== "string" || !metadata.digest) {
        throw new Error("Edge Config publication returned no digest");
      }
      return { version: metadata.digest };
    },
    async pointer(installationId, options) {
      const suffix = installationId.replace(/[^A-Za-z0-9_-]/g, "_");
      const [pointer, metadata] = await Promise.all([
        request(`/item/active_${suffix}`, { signal: options?.signal }),
        request("", { signal: options?.signal }),
      ]);
      const revision = (pointer as { revision?: unknown } | null)?.revision;
      const version = (metadata as { digest?: unknown } | null)?.digest;
      return typeof revision === "string" && typeof version === "string"
        ? { revision, version }
        : null;
    },
    async loadActive(installationId) {
      const suffix = installationId.replace(/[^A-Za-z0-9_-]/g, "_");
      return (await request(`/item/snapshot_${suffix}`)) as ConfigSnapshot;
    },
  };
  return store;
}

/** Select Edge Config only when configured and the signed snapshot fits its hard budget. */
export function snapshotStore(snapshot?: ConfigSnapshot): SnapshotPublishStore | null {
  if (
    snapshot &&
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") >= EDGE_CONFIG_CUTOFF_BYTES
  ) {
    return null;
  }
  return edgeConfigStore();
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
 * buildSnapshot → signSnapshot → plan. Extracting it guarantees both routes hash the
 * SAME bytes, so planHash cannot diverge between plan-time and apply-time (§8.2, §16.2). The
 * target content hash excludes build time, so a re-plan at apply reproduces the caller's plan.
 *
 * CRITICAL (§6.16/§15.2): the app connects as the non-superuser `manifold_app` role, so RLS is
 * live. buildSnapshot/plan read installation/profiles/routes/keys/credentials, which are all
 * workspace-scoped — with no `manifold.workspace_id` GUC set they return ZERO rows (empty snapshot
 * / "installation not found"). We therefore run the whole pipeline inside `withWorkspace`, which
 * opens a txn and sets the GUC, and hand buildSnapshot/plan that GUC-scoped connection.
 */
export function buildSignedPlan(workspaceId: string, installationId: string, scopedSql?: Sql) {
  const build = async (sql: Sql) => {
    // buildSnapshot/plan take the tagged SQL client directly; hand them the GUC-scoped tx.
    const built = await buildSnapshot(sql, installationId);
    return plan(sql, installationId, signSnapshot(built));
  };
  return scopedSql ? build(scopedSql) : withWorkspace(workspaceId, build);
}

/**
 * SPEC §8.2 H7 (scoped key publish): rebuild ONLY the snapshot `keys` section against the
 * installation's active revision and publish it, so a freshly minted / revoked virtual key
 * enters the active snapshot immediately — the gateway is snapshot-only auth (§7.4), so without
 * this it returns AUTH_KEY_UNKNOWN (mint) / keeps accepting a revoked key (revoke) until the next
 * full config apply. Route/offering/policy sections are carried over verbatim, so unrelated
 * route/policy DRAFTS are NOT published (that is the whole point of the H7 scoped path).
 *
 * Thin wrapper over `@manifold/config`.keyOnlyPublish — the single rebuild → sign → plan → apply
 * core (config owns it; RLS/GUC handling, the empty-active no-op, and idempotency all live there).
 * The control plane only supplies the top-level client, the store, and the ed25519 signing key.
 *
 * Returns `null` (a no-op, NOT an error) when the installation has no active revision yet (nothing
 * to rebuild keys against → the key enters on the first full apply) or when the keys section is
 * unchanged (§8.2 idempotency).
 */
export async function publishKeysOnly(
  workspaceId: string,
  installationId: string,
): Promise<ConfigOperation | null> {
  return keyOnlyPublish(db().$client, workspaceId, installationId, snapshotStore(), {
    signingKey: signingKey(),
    signingKeyId: process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY_ID,
  });
}

/**
 * Publish the health rollup's overlay onto the current signed snapshot.  Config owns the scoped
 * read, fresh signature, optimistic base check, durable operation, and reconciliation job; this
 * control-plane seam supplies only the deployment credentials and database client.
 */
export async function publishHealthOnly(
  workspaceId: string,
  installationId: string,
): Promise<ConfigOperation | null> {
  return healthOnlyPublish(db().$client, workspaceId, installationId, snapshotStore(), {
    signingKey: signingKey(),
    signingKeyId: process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY_ID,
  });
}

/** Queue (but never execute) a key-only publication from an enclosing mutation transaction. */
export async function enqueueKeyPublication(sql: Sql, workspaceId: string, installationId: string): Promise<void> {
  const key = `config_key_publish:${installationId}`;
  await sql`
    INSERT INTO job_ledger
      (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
    VALUES (${`job_key_publish_${installationId}`}, ${workspaceId}, 'config_key_publish',
      ${sql.json({ installationId } as never)}, ${key}, 'pending', 0, now(), now())
    ON CONFLICT (kind, idempotency_key) DO UPDATE
      SET payload = jsonb_build_object(
            'installationId', ${installationId}::text,
            'generation', COALESCE((job_ledger.payload->>'generation')::integer, 0) + 1),
          status = CASE WHEN job_ledger.status = 'done' THEN 'pending' ELSE job_ledger.status END,
          updated_at = now()`;
}

/** Shared post-commit worker seam for key mutations. Never call this from a request transaction. */
export async function drainKeyPublication(workspaceId: string, installationId: string): Promise<void> {
  const key = `config_key_publish:${installationId}`;
  // A mutation may arrive while this worker is building/publishing its snapshot.  The payload
  // generation makes that visible: completion is legal only when the claimed generation is still
  // current; otherwise leave the durable job pending and immediately coalesce one newer pass.
  for (let pass = 0; pass < 4; pass += 1) {
    const fence = randomUUID();
    const claimed = await withWorkspace(workspaceId, async (sql) => {
      const rows = await sql<{ generation: number }[]>`
        UPDATE job_ledger SET status='claimed', claimed_at=now(), claimed_by=${fence},
          attempts=attempts+1, updated_at=now()
        WHERE workspace_id=${workspaceId} AND kind='config_key_publish' AND idempotency_key=${key}
          AND (status='pending' OR (status='claimed' AND claimed_at <= now() - ${PUBLICATION_LEASE_SECONDS} * interval '1 second'))
        RETURNING COALESCE((payload->>'generation')::integer, 0) AS generation`;
      return rows[0]?.generation ?? null;
    });
    if (claimed === null) return;
    try {
      const op = await publishKeysOnly(workspaceId, installationId);
      if (op) await reconcileConfigOperation(workspaceId, op.id);
      const completed = await withWorkspace(workspaceId, async (sql) => {
        const rows = await sql<{ id: string }[]>`
          UPDATE job_ledger SET status='done', claimed_at=NULL, claimed_by=NULL, updated_at=now()
          WHERE workspace_id=${workspaceId} AND kind='config_key_publish' AND idempotency_key=${key}
            AND status='claimed' AND claimed_by=${fence}
            AND COALESCE((payload->>'generation')::integer, 0) = ${claimed}
          RETURNING id`;
        if (rows[0]) return true;
        await sql`
          UPDATE job_ledger SET status='pending', claimed_at=NULL, claimed_by=NULL, updated_at=now()
          WHERE workspace_id=${workspaceId} AND kind='config_key_publish' AND idempotency_key=${key}
            AND status='claimed' AND claimed_by=${fence}`;
        return false;
      });
      if (completed) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withWorkspace(workspaceId, (sql) => sql`
        UPDATE job_ledger SET status='pending', claimed_at=NULL, claimed_by=NULL,
          last_error=${sql.json({ message } as never)}, updated_at=now()
        WHERE workspace_id=${workspaceId} AND kind='config_key_publish' AND idempotency_key=${key}
          AND status='claimed' AND claimed_by=${fence}`);
      throw error;
    }
  }
}

/** Bounded cron seam: the privileged selector returns ids only; each worker is RLS-scoped. */
export async function reconcilePendingConfigOperations(limit = 20): Promise<{ attempted: number; completed: number }> {
  const candidates = await db().$client<{ workspace_id: string; operation_id: string }[]>`
    SELECT workspace_id, operation_id FROM claim_config_publication_recovery(${limit})`;
  let completed = 0;
  for (const candidate of candidates) {
    try { await reconcileConfigOperation(candidate.workspace_id, candidate.operation_id); completed += 1; } catch { /* durable job remains retryable */ }
  }
  return { attempted: candidates.length, completed };
}

/** Same bounded cron pass for coalesced key work, which has no config_operation until it runs. */
export async function drainPendingKeyPublications(limit = 20): Promise<{ attempted: number; completed: number }> {
  const candidates = await db().$client<{ workspace_id: string; installation_id: string }[]>`
    SELECT workspace_id, installation_id FROM claim_config_key_publication_recovery(${limit})`;
  let completed = 0;
  for (const candidate of candidates) {
    try { await drainKeyPublication(candidate.workspace_id, candidate.installation_id); completed += 1; } catch { /* remains pending for the next cron */ }
  }
  return { attempted: candidates.length, completed };
}

/** Retire an operation whose revision lost active status before its cache publication completed. */
async function terminalizeSupersededConfigPublication(workspaceId: string, operationId: string): Promise<void> {
  const operationKey = `config_publish:${operationId}`;
  await withWorkspace(workspaceId, async (sql) => {
    await sql`
      UPDATE config_operation
      SET accelerator_status = 'superseded',
          error = ${sql.json({ reason: "superseded" } as never)},
          completed_at = COALESCE(completed_at, now()), last_reconcile_at = now()
      WHERE id = ${operationId} AND workspace_id = ${workspaceId}
        AND accelerator_status IN ('pending', 'reconciliation_required')`;
    await sql`
      UPDATE job_ledger
      SET status = 'superseded', claimed_at = NULL, claimed_by = NULL,
          last_error = ${sql.json({ reason: "superseded" } as never)}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'config_publish_reconcile'
        AND idempotency_key = ${operationKey} AND status IN ('pending', 'claimed')`;
  });
}

/** Retry the exact committed snapshot for an operation whose accelerator mirror is incomplete. */
export async function reconcileConfigOperation(
  workspaceId: string,
  operationId: string,
): Promise<{
  operationId: string;
  revisionId: string;
  servingMode: "boot_fallback" | "edge_config";
  acceleratorStatus: "not_configured" | "published";
  edgeConfigVersion: string | null;
}> {
  const rows = await withWorkspace(workspaceId, (sql) =>
    sql<{
      revision_id: string;
      installation_id: string;
      accelerator_status: string;
      snapshot: ConfigSnapshot;
      revision_status: string;
    }[]>`
      SELECT o.revision_id, o.installation_id, o.accelerator_status,
             r.snapshot, r.status AS revision_status
      FROM config_operation o
      JOIN gateway_config_revision r ON r.id = o.revision_id
      WHERE o.id = ${operationId}
        AND o.workspace_id = ${workspaceId}
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) {
    throw new ManifoldError({
      status: 404,
      code: "NOT_FOUND",
      message: "config operation not found",
      reasonCodes: [],
    });
  }
  if (row.revision_status !== "active") {
    await terminalizeSupersededConfigPublication(workspaceId, operationId);
    throw new ManifoldError({
      status: 409,
      code: "CONFIG_PRECONDITION_FAILED",
      message: "config operation revision is no longer active",
      reasonCodes: ["CONFIG_PRECONDITION_FAILED"],
      remediation: "reconcile the current active revision instead",
    });
  }

  // The operation job prevents duplicate retries for one operation.  The installation job is the
  // durable cross-operation lease: config_operation ids are distinct for every apply/rollback/key
  // publish, so an operation-only fence could still let an older request overwrite a newer active
  // revision.  The installation row lock below remains held through the bounded external request,
  // which also prevents a new active revision from committing between the active-revision check and
  // the remote pointer/PATCH.
  const fence = randomUUID();
  const operationKey = `config_publish:${operationId}`;
  const installationKey = `config_publish_installation:${row.installation_id}`;
  const claimed = await withWorkspace(workspaceId, async (sql) => {
    await sql`
      INSERT INTO job_ledger
        (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
      VALUES (${`job_reconcile_${operationId}`}, ${workspaceId}, 'config_publish_reconcile',
        ${sql.json({ operationId, installationId: row.installation_id, revisionId: row.revision_id } as never)},
        ${operationKey}, 'pending', 0, now(), now())
      ON CONFLICT (kind, idempotency_key) DO NOTHING`;
    await sql`
      INSERT INTO job_ledger
        (id, workspace_id, kind, payload, idempotency_key, status, attempts, created_at, updated_at)
      VALUES (${`job_publish_installation_${row.installation_id}`}, ${workspaceId}, 'config_publish_installation',
        ${sql.json({ installationId: row.installation_id } as never)},
        ${installationKey}, 'pending', 0, now(), now())
      ON CONFLICT (kind, idempotency_key) DO UPDATE
        SET status = CASE WHEN job_ledger.status = 'done' THEN 'pending' ELSE job_ledger.status END,
            updated_at = now()`;
    const operation = await sql<{ id: string }[]>`
      UPDATE job_ledger SET status = 'claimed', claimed_at = now(),
        claimed_by = ${fence}, attempts = attempts + 1, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'config_publish_reconcile'
        AND idempotency_key = ${operationKey}
        AND (status = 'pending' OR (status = 'claimed' AND claimed_at <= now() - ${PUBLICATION_LEASE_SECONDS} * interval '1 second'))
      RETURNING id`;
    if (!operation[0]) return false;
    const installation = await sql<{ id: string }[]>`
      UPDATE job_ledger SET status = 'claimed', claimed_at = now(),
        claimed_by = ${fence}, attempts = attempts + 1, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'config_publish_installation'
        AND idempotency_key = ${installationKey}
        AND (status = 'pending' OR (status = 'claimed' AND claimed_at <= now() - ${PUBLICATION_LEASE_SECONDS} * interval '1 second'))
      RETURNING id`;
    if (installation[0]) return true;
    await sql`
      UPDATE job_ledger SET status = 'pending', claimed_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND kind = 'config_publish_reconcile'
        AND idempotency_key = ${operationKey} AND status = 'claimed' AND claimed_by = ${fence}`;
    return false;
  });
  if (!claimed) {
    const latest = await withWorkspace(workspaceId, (sql) =>
      sql<{ accelerator_status: "not_configured" | "published"; edge_config_version: string | null }[]>`
        SELECT accelerator_status, edge_config_version FROM config_operation
        WHERE id = ${operationId} AND workspace_id = ${workspaceId}`);
    if (latest[0]?.accelerator_status === "published" || latest[0]?.accelerator_status === "not_configured") {
      return {
        operationId, revisionId: row.revision_id,
        servingMode: latest[0].accelerator_status === "published" ? "edge_config" : "boot_fallback",
        acceleratorStatus: latest[0].accelerator_status,
        edgeConfigVersion: latest[0].edge_config_version,
      };
    }
    throw new ManifoldError({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "config publication is in progress", reasonCodes: [], retryable: true });
  }

  const publishStore = snapshotStore(row.snapshot);
  if (!publishStore) {
    await withWorkspace(workspaceId, async (sql) => {
      await sql`
        UPDATE config_operation
        SET serving_mode = 'boot_fallback', accelerator_status = 'not_configured',
            error = NULL, completed_at = now(), last_reconcile_at = now(),
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = ${operationId} AND workspace_id = ${workspaceId}`;
      await sql`
        UPDATE job_ledger SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND idempotency_key = ${operationKey}
          AND status = 'claimed' AND claimed_by = ${fence}`;
      await sql`
        UPDATE job_ledger SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND idempotency_key = ${installationKey}
          AND status = 'claimed' AND claimed_by = ${fence}`;
    });
    return {
      operationId,
      revisionId: row.revision_id,
      servingMode: "boot_fallback",
      acceleratorStatus: "not_configured",
      edgeConfigVersion: null,
    };
  }

  try {
    const result = await withWorkspace(workspaceId, async (sql) => {
      // This lock is intentionally held until the remote publication + durable completion.  Every
      // activation already locks this same installation row, so an old publication can never pass
      // its active check and later land after a newer revision became active.
      const active = await sql<{ id: string }[]>`
        SELECT i.id
        FROM gateway_installation i
        JOIN gateway_config_revision r ON r.installation_id = i.id AND r.status = 'active'
        WHERE i.id = ${row.installation_id} AND i.workspace_id = ${workspaceId}
          AND r.id = ${row.revision_id}
        FOR UPDATE OF i`;
      if (!active[0]) return null;
      const owned = await sql<{ id: string }[]>`
        SELECT id FROM job_ledger
        WHERE workspace_id = ${workspaceId} AND kind = 'config_publish_installation'
          AND idempotency_key = ${installationKey} AND status = 'claimed' AND claimed_by = ${fence}
        FOR UPDATE`;
      if (!owned[0]) throw new Error("config publication lease lost before external write");

      // A reclaimed job may have crashed after the remote PATCH.  Pointer-before-republish keeps
      // that retry idempotent while the installation lock preserves active-revision ordering.
      const signal = AbortSignal.timeout(PUBLICATION_REQUEST_TIMEOUT_MS);
      const pointer = await publishStore.pointer(row.installation_id, { signal });
      const published = pointer?.revision === row.revision_id
        ? { version: pointer.version }
        : await publishStore.publish(row.installation_id, row.revision_id, row.snapshot, { signal });

      const completed = await sql<{ id: string }[]>`
        UPDATE job_ledger SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND idempotency_key = ${operationKey}
          AND status = 'claimed' AND claimed_by = ${fence} RETURNING id`;
      if (!completed[0]) throw new Error("config publication operation lease lost during completion");
      const installationCompleted = await sql<{ id: string }[]>`
        UPDATE job_ledger SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE workspace_id = ${workspaceId} AND idempotency_key = ${installationKey}
          AND status = 'claimed' AND claimed_by = ${fence} RETURNING id`;
      if (!installationCompleted[0]) throw new Error("config publication installation lease lost during completion");
      await sql`
        UPDATE config_operation
        SET serving_mode = 'edge_config', accelerator_status = 'published',
            edge_config_version = ${published.version}, error = NULL,
            completed_at = now(), last_reconcile_at = now(),
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = ${operationId} AND workspace_id = ${workspaceId}`;
      return published;
    });
    if (result) {
      return {
        operationId,
        revisionId: row.revision_id,
        servingMode: "edge_config",
        acceleratorStatus: "published",
        edgeConfigVersion: result.version,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withWorkspace(workspaceId, async (sql) => {
      await sql`
        UPDATE config_operation
        SET accelerator_status = 'reconciliation_required',
            error = ${sql.json({ message, reconciliation_required: true } as never)},
            last_reconcile_at = now(),
            reconciliation_attempts = reconciliation_attempts + 1
        WHERE id = ${operationId} AND workspace_id = ${workspaceId}`;
      await sql`
        UPDATE job_ledger
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL, attempts = attempts + 1, last_error =
              ${sql.json({ message } as never)}, updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND idempotency_key = ${operationKey}
          AND status = 'claimed' AND claimed_by = ${fence}`;
      await sql`
        UPDATE job_ledger
        SET status = 'pending', claimed_at = NULL, claimed_by = NULL, attempts = attempts + 1, last_error =
              ${sql.json({ message } as never)}, updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND idempotency_key = ${installationKey}
          AND status = 'claimed' AND claimed_by = ${fence}`;
    });
    throw error;
  }
  await withWorkspace(workspaceId, async (sql) => {
    await sql`
      UPDATE job_ledger SET status = 'done', claimed_at = NULL, claimed_by = NULL, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${installationKey}
        AND status = 'claimed' AND claimed_by = ${fence}`;
  });
  await terminalizeSupersededConfigPublication(workspaceId, operationId);
  throw new ManifoldError({ status: 409, code: "CONFIG_PRECONDITION_FAILED", message: "config operation revision is no longer active", reasonCodes: ["CONFIG_PRECONDITION_FAILED"], remediation: "reconcile the current active revision instead" });
}
