import type { Principal } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { rawSql, withWorkspace, type Sql } from "@/lib/db";
import { publishKeysOnly, reconcileConfigOperation } from "@/lib/snapshot";

const WORKSPACE_LIMIT = 25;
const KEY_LIMIT_PER_WORKSPACE = 50;
const PUBLICATION_LIMIT_PER_WORKSPACE = 10;
const LEASE_SECONDS = 60;

type ClaimedPublication = { installationId: string; operationId: string | null };
type ExpiredKey = { id: string; installation_id: string; expires_at: string };

function systemPrincipal(workspaceId: string): Principal {
  // Internal cron is authenticated separately; this principal is solely the immutable audit actor.
  return { workspaceId, scopes: [], actorKind: "system", actorId: "key-grace-expiry" } as unknown as Principal;
}

async function claimWorkspace(workspaceId: string, requestId: string): Promise<{
  expired: number;
  publications: ClaimedPublication[];
}> {
  return withWorkspace(workspaceId, async (sql) => {
    const expired = await sql<ExpiredKey[]>`
      WITH candidates AS (
        SELECT k.id
        FROM virtual_key k
        JOIN gateway_ingress_profile p ON p.id = k.profile_id
          AND p.workspace_id = ${workspaceId}
        WHERE k.workspace_id = ${workspaceId}
          AND k.successor_key_id IS NOT NULL
          AND k.revoked_at IS NULL
          AND k.expires_at <= now()
        ORDER BY k.expires_at, k.id
        LIMIT ${KEY_LIMIT_PER_WORKSPACE}
        FOR UPDATE OF k SKIP LOCKED
      )
      UPDATE virtual_key k
      SET revoked_at = now()
      FROM gateway_ingress_profile p, candidates c
      WHERE k.id = c.id
        AND p.id = k.profile_id
        AND p.workspace_id = ${workspaceId}
      RETURNING k.id, p.installation_id, k.expires_at::text`;

    for (const key of expired) {
      await audit(sql, systemPrincipal(workspaceId), {
        action: "key.rotation_grace_expire",
        targetKind: "virtual_key",
        targetId: key.id,
        requestId,
        detail: { installationId: key.installation_id, graceExpiresAt: key.expires_at },
      });
    }

    const installations = [...new Set(expired.map((key) => key.installation_id))];
    for (const installationId of installations) {
      await sql`
        INSERT INTO key_rotation_expiry_publish (workspace_id, installation_id)
        VALUES (${workspaceId}, ${installationId})
        ON CONFLICT (workspace_id, installation_id) DO UPDATE
        SET status = 'pending', operation_id = NULL, lease_until = NULL,
            completed_at = NULL, last_error = NULL, updated_at = now()
        WHERE key_rotation_expiry_publish.status = 'done'`;
    }

    const publications = await sql<{ installation_id: string; operation_id: string | null }[]>`
      WITH candidates AS (
        SELECT installation_id
        FROM key_rotation_expiry_publish
        WHERE workspace_id = ${workspaceId}
          AND (status = 'pending' OR (status = 'processing' AND lease_until <= now()))
        ORDER BY created_at, installation_id
        LIMIT ${PUBLICATION_LIMIT_PER_WORKSPACE}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE key_rotation_expiry_publish p
      SET status = 'processing', lease_until = now() + (${LEASE_SECONDS} * interval '1 second'),
          attempt_count = attempt_count + 1, updated_at = now()
      FROM candidates c
      WHERE p.workspace_id = ${workspaceId} AND p.installation_id = c.installation_id
      RETURNING p.installation_id, p.operation_id`;
    return { expired: expired.length, publications: publications.map((p) => ({ installationId: p.installation_id, operationId: p.operation_id })) };
  });
}

async function completePublication(workspaceId: string, installationId: string): Promise<void> {
  await withWorkspace(workspaceId, (sql) => sql`
    UPDATE key_rotation_expiry_publish
    SET status = 'done', lease_until = NULL, last_error = NULL, completed_at = now(), updated_at = now()
    WHERE workspace_id = ${workspaceId} AND installation_id = ${installationId}`);
}

async function retryPublication(workspaceId: string, installationId: string, operationId: string | null, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withWorkspace(workspaceId, (sql) => sql`
    UPDATE key_rotation_expiry_publish
    SET status = 'pending', operation_id = ${operationId}, lease_until = NULL,
        last_error = ${sql.json({ message } as never)}, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND installation_id = ${installationId}`);
}

async function failedKeyPublishOperation(sql: Sql, workspaceId: string, installationId: string, startedAt: Date): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM config_operation
    WHERE workspace_id = ${workspaceId} AND installation_id = ${installationId}
      AND operation_kind = 'key_publish'
      AND accelerator_status = 'reconciliation_required'
      AND created_at >= ${startedAt.toISOString()}::timestamptz
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}

async function processPublication(workspaceId: string, publication: ClaimedPublication): Promise<"published" | "reconciled" | "retried"> {
  const startedAt = new Date();
  try {
    if (publication.operationId) {
      await reconcileConfigOperation(workspaceId, publication.operationId);
      await completePublication(workspaceId, publication.installationId);
      return "reconciled";
    }
    await publishKeysOnly(workspaceId, publication.installationId);
    await completePublication(workspaceId, publication.installationId);
    return "published";
  } catch (error) {
    const operationId = publication.operationId ?? await withWorkspace(
      workspaceId,
      (sql) => failedKeyPublishOperation(sql, workspaceId, publication.installationId, startedAt),
    );
    await retryPublication(workspaceId, publication.installationId, operationId, error);
    return "retried";
  }
}

/** Run one bounded grace-expiry sweep. It never reads or returns key material. */
export async function sweepExpiredKeyRotationGrace(requestId: string): Promise<{
  workspaces: number; expired: number; published: number; reconciled: number; retried: number;
}> {
  const workspaces = await rawSql()<{ workspace_id: string }[]>`
    SELECT workspace_id FROM key_rotation_expiry_due_workspaces(${WORKSPACE_LIMIT})`;
  let expired = 0; let published = 0; let reconciled = 0; let retried = 0;
  for (const { workspace_id: workspaceId } of workspaces) {
    const claimed = await claimWorkspace(workspaceId, requestId);
    expired += claimed.expired;
    for (const publication of claimed.publications) {
      const result = await processPublication(workspaceId, publication);
      if (result === "published") published += 1;
      if (result === "reconciled") reconciled += 1;
      if (result === "retried") retried += 1;
    }
  }
  return { workspaces: workspaces.length, expired, published, reconciled, retried };
}
