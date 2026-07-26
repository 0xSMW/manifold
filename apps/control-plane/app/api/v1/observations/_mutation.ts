import { createHash } from "node:crypto";
import type { Principal } from "@/lib/auth";
import type { Sql } from "@/lib/db";
import { genId } from "@/lib/ids";
import { ManifoldError } from "@/lib/http";

interface StoredMutation {
  request_hash: string;
  state: string;
  response_status: number | null;
  response_body: Uint8Array | null;
}

export interface MutationResult<T> {
  body: T;
  status: number;
  replayed: boolean;
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key");
  if (value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "Idempotency-Key must be a non-empty string of at most 200 characters",
      reasonCodes: [],
      details: { issues: [{ path: "Idempotency-Key", message: "invalid header" }] },
    });
  }
  return normalized;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function decodeStored<T>(value: Uint8Array | null): T {
  if (!value) {
    throw new ManifoldError({
      status: 409,
      code: "INTERNAL",
      message: "idempotent mutation response is not yet available",
      reasonCodes: [],
      retryable: true,
    });
  }
  return JSON.parse(Buffer.from(value).toString("utf8")) as T;
}

/**
 * Execute and durably journal a mutation response in the caller's workspace transaction.
 * The unique identity blocks concurrent duplicates until the first transaction commits.
 */
export async function runIdempotentMutation<T>(
  sql: Sql,
  principal: Principal,
  req: Request,
  canonicalPath: string,
  canonicalRequest: unknown,
  execute: () => Promise<{ body: T; status: number }>,
): Promise<MutationResult<T>> {
  const key = idempotencyKey(req);
  if (!key) {
    const result = await execute();
    return { ...result, replayed: false };
  }

  const hash = requestHash(canonicalRequest);
  await sql`
    DELETE FROM mutation_idempotency
    WHERE workspace_id = ${principal.workspaceId}
      AND actor_kind = ${principal.actorKind}
      AND actor_id = ${principal.actorId}
      AND method = 'POST'
      AND canonical_path = ${canonicalPath}
      AND idempotency_key = ${key}
      AND expires_at <= now()`;
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO mutation_idempotency (
      id, workspace_id, actor_kind, actor_id, method, canonical_path,
      idempotency_key, request_hash, state, lease_expires_at, expires_at
    )
    VALUES (
      ${genId("idem")}, ${principal.workspaceId}, ${principal.actorKind}, ${principal.actorId},
      'POST', ${canonicalPath}, ${key}, ${hash}, 'in_progress',
      now() + interval '60 seconds', now() + interval '24 hours'
    )
    ON CONFLICT (
      workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key
    ) DO NOTHING
    RETURNING id`;

  if (!inserted[0]) {
    const rows = await sql<StoredMutation[]>`
      SELECT request_hash, state, response_status, response_body
      FROM mutation_idempotency
      WHERE workspace_id = ${principal.workspaceId}
        AND actor_kind = ${principal.actorKind}
        AND actor_id = ${principal.actorId}
        AND method = 'POST'
        AND canonical_path = ${canonicalPath}
        AND idempotency_key = ${key}
      FOR UPDATE`;
    const stored = rows[0];
    if (!stored) {
      throw new ManifoldError({
        status: 409,
        code: "INTERNAL",
        message: "idempotency reservation changed; retry the request",
        reasonCodes: [],
        retryable: true,
      });
    }
    if (stored.request_hash !== hash) {
      throw new ManifoldError({
        status: 409,
        code: "VALIDATION",
        message: "Idempotency-Key was already used with a different request",
        reasonCodes: [],
        details: { issues: [{ path: "Idempotency-Key", message: "request hash mismatch" }] },
      });
    }
    if (stored.state !== "completed" || stored.response_status === null) {
      throw new ManifoldError({
        status: 409,
        code: "INTERNAL",
        message: "idempotent mutation is still in progress",
        reasonCodes: [],
        retryable: true,
      });
    }
    return {
      body: decodeStored<T>(stored.response_body),
      status: stored.response_status,
      replayed: true,
    };
  }

  const result = await execute();
  const responseBody = Buffer.from(JSON.stringify(result.body), "utf8");
  await sql`
    UPDATE mutation_idempotency
    SET state = 'completed',
        response_status = ${result.status},
        response_headers = ${sql.json({ "content-type": "application/json" } as never)},
        response_body = ${responseBody},
        completed_at = now(),
        lease_expires_at = now(),
        updated_at = now()
    WHERE workspace_id = ${principal.workspaceId}
      AND actor_kind = ${principal.actorKind}
      AND actor_id = ${principal.actorId}
      AND method = 'POST'
      AND canonical_path = ${canonicalPath}
      AND idempotency_key = ${key}
      AND request_hash = ${hash}
      AND state = 'in_progress'`;
  return { ...result, replayed: false };
}
