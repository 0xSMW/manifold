// Durable mutation guard (SPEC §10.1). Routes opt in explicitly; this module does not make
// legacy/unguarded routes safe by import alone.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { TransactionSql } from "@manifold/database";
import { withWorkspace, type Sql } from "@/lib/db";
import type { Principal } from "@/lib/auth";
import { genId } from "@/lib/ids";
import { errorEnvelope, ManifoldError } from "@/lib/http";

const DEFAULT_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export interface MutationRateLimit {
  /** Maximum requests from one principal in the fixed window. */
  limit: number;
  /** Fixed-window duration, in milliseconds. */
  windowMs: number;
}

export interface MutationGuardOptions {
  request: Request;
  principal: Principal;
  requestId: string;
  /** The handler MUST issue all state-changing SQL via this scoped transaction. */
  handler: (sql: Sql) => Promise<Response>;
  rateLimit?: MutationRateLimit;
  /** The response contains a copy-once credential.  Its replay journal is envelope encrypted. */
  sensitiveReplay?: boolean;
  /** Runs only after the guarded transaction (including its durable response) commits. */
  afterCommit?: () => Promise<void>;
}

/**
 * Guard a mutation whose authoritative database transaction is owned by another package and
 * whose accelerator write must happen after that package commits.  The claim is committed before
 * the callback starts, so its transaction boundary is never nested inside this guard.  A second
 * request waits for the durable response instead of re-running either the DB or accelerator work.
 */
export interface PostCommitMutationGuardOptions extends Omit<MutationGuardOptions, "handler"> {
  handler: () => Promise<Response>;
}

interface IdempotencyRow {
  request_hash: string;
  state: "in_progress" | "completed";
  lease_expires_at: string;
  response_status: number | null;
  response_headers: unknown;
  response_body: Buffer | Uint8Array | null;
  response_body_encrypted: Buffer | Uint8Array | null;
  response_body_iv: Buffer | Uint8Array | null;
  response_body_tag: Buffer | Uint8Array | null;
}

function canonicalPath(request: Request): string {
  const url = new URL(request.url);
  // Query parameters intentionally do not form part of endpoint identity. Mutation routes should
  // put state in the request body; including query ordering would create accidental key aliases.
  return url.pathname.replace(/\/{2,}/g, "/") || "/";
}

/** Copy-once credential mint routes are sensitive even if a future caller forgets the option. */
function shouldEncryptReplay(options: MutationGuardOptions): boolean {
  const path = canonicalPath(options.request);
  return options.sensitiveReplay === true || path === "/api/v1/keys" || path === "/api/v1/settings/tokens" || path === "/api/v1/installations";
}

export function requireMutationIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ManifoldError({
      status: 400,
      code: "VALIDATION",
      message: "Idempotency-Key is required and must be a printable string up to 512 characters",
      reasonCodes: [],
    });
  }
  return key;
}

/** Stable principal/route/key identity for authoritative operations outside the guard journal. */
export function mutationOperationKey(request: Request, principal: Principal): string {
  return createHash("sha256")
    .update(principal.workspaceId).update("\0").update(principal.actorKind).update("\0")
    .update(principal.actorId).update("\0").update(request.method.toUpperCase()).update("\0")
    .update(canonicalPath(request)).update("\0").update(requireMutationIdempotencyKey(request))
    .digest("hex");
}

/** SHA-256 of the exact request bytes bound to the relevant representation header. */
export async function mutationRequestHash(request: Request): Promise<string> {
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get("content-type")?.trim().toLowerCase() ?? "";
  return createHash("sha256").update(contentType).update("\n").update(bytes).digest("hex");
}

function checkedRateLimit(value: MutationRateLimit | undefined): MutationRateLimit {
  const limit = value?.limit ?? DEFAULT_RATE_LIMIT.limit;
  const windowMs = value?.windowMs ?? DEFAULT_RATE_LIMIT.windowMs;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("mutation rate limit must use positive safe integer limit and windowMs");
  }
  return { limit, windowMs };
}

function responseHeaders(response: Response): Record<string, string> {
  // Persist only deterministic end-to-end headers. Hop-by-hop headers must never be replayed;
  // these are the contract headers required by §10.1 plus the response representation.
  const persisted = ["content-type", "cache-control", "x-request-id", "x-manifold-schema"];
  return Object.fromEntries(
    persisted.flatMap((name) => {
      const value = response.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
}

function storedHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;
  for (const [key, header] of Object.entries(value as Record<string, unknown>)) {
    if (typeof header === "string") headers.set(key, header);
  }
  return headers;
}

function replayKey(): Buffer {
  const encoded = process.env.MANIFOLD_MUTATION_REPLAY_KEY;
  if (!encoded) throw new Error("MANIFOLD_MUTATION_REPLAY_KEY is required for sensitive response replay");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("MANIFOLD_MUTATION_REPLAY_KEY must be a base64 32-byte key");
  return key;
}

function decryptReplayBody(row: IdempotencyRow): Uint8Array | null {
  if (!row.response_body_encrypted || !row.response_body_iv || !row.response_body_tag) return null;
  const decipher = createDecipheriv("aes-256-gcm", replayKey(), Buffer.from(row.response_body_iv));
  decipher.setAuthTag(Buffer.from(row.response_body_tag));
  return Buffer.concat([decipher.update(Buffer.from(row.response_body_encrypted)), decipher.final()]);
}

function replay(row: IdempotencyRow): Response {
  const body = row.response_body ?? decryptReplayBody(row);
  if (row.response_status === null || !body) {
    throw new Error("completed idempotency record has no durable response");
  }
  return new Response(new Uint8Array(body), {
    status: row.response_status,
    headers: storedHeaders(row.response_headers),
  });
}

function conflict(message: string, retryable = false): ManifoldError {
  return new ManifoldError({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    message,
    reasonCodes: [],
    retryable,
  });
}

async function chargeRateLimit(
  sql: Sql,
  principal: Principal,
  limit: MutationRateLimit,
  routeIdentity: string,
): Promise<number | null> {
  // Cleanup makes the number of retained rows bounded by active principals/windows. It is RLS
  // scoped and therefore cannot delete another workspace's buckets.
  await sql`DELETE FROM mutation_rate_limit_bucket
    WHERE workspace_id = ${principal.workspaceId} AND expires_at <= now()`;
  const bucketMs = Math.floor(Date.now() / limit.windowMs) * limit.windowMs;
  const bucketStart = new Date(bucketMs).toISOString();
  const expiresAt = new Date(bucketMs + limit.windowMs).toISOString();
  const rows = await sql<{ request_count: number }[]>`
    INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
    VALUES (${principal.workspaceId}, ${principal.actorKind}, ${principal.actorId}, ${routeIdentity}, ${bucketStart}, 1, ${expiresAt})
    ON CONFLICT (workspace_id, actor_kind, actor_id, route_identity, bucket_start) DO UPDATE
      SET request_count = mutation_rate_limit_bucket.request_count + 1
      WHERE mutation_rate_limit_bucket.request_count < ${limit.limit}
    RETURNING request_count`;
  if (rows[0]) return null;
  return Math.max(1, Math.ceil((bucketMs + limit.windowMs - Date.now()) / 1000));
}

function chargeRateLimitForPath(
  sql: Sql,
  principal: Principal,
  limit: MutationRateLimit,
  routeIdentity: string,
): Promise<number | null> {
  return chargeRateLimit(sql, principal, limit, routeIdentity);
}

async function durableResponse(sql: Sql, workspaceId: string, id: string, response: Response, sensitive = false): Promise<Response> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers = responseHeaders(response);
  const iv = sensitive ? randomBytes(12) : null;
  const cipher = sensitive ? createCipheriv("aes-256-gcm", replayKey(), iv!) : null;
  const encrypted = cipher ? Buffer.concat([cipher.update(bytes), cipher.final()]) : null;
  const tag = cipher?.getAuthTag() ?? null;
  await sql`UPDATE mutation_idempotency
    SET state = 'completed', response_status = ${response.status},
        response_headers = ${sql.json(headers)}, response_body = ${sensitive ? null : bytes},
        response_body_encrypted = ${encrypted}, response_body_iv = ${iv}, response_body_tag = ${tag}, completed_at = now(),
        -- Sensitive responses stay envelope encrypted, but their claim must exclude a second
        -- execution for the full idempotency window. Preserve a longer existing lease if one
        -- was established before this response completed.
        expires_at = CASE WHEN ${sensitive} THEN GREATEST(expires_at, now() + interval '24 hours') ELSE expires_at END,
        updated_at = now(), lease_expires_at = now()
    WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  return new Response(bytes, { status: response.status, headers });
}

/**
 * Execute one explicitly guarded mutation. Its handler runs inside the same workspace-scoped
 * transaction as the idempotency row lock, so two identical concurrent requests execute effects
 * once. A route must not call `withWorkspace` inside `handler`; use the supplied `sql` instead.
 */
export async function runMutationGuard(options: MutationGuardOptions): Promise<Response> {
  let key: string;
  let requestHash: string;
  let rateLimit: MutationRateLimit;
  try {
    key = requireMutationIdempotencyKey(options.request);
    requestHash = await mutationRequestHash(options.request);
    rateLimit = checkedRateLimit(options.rateLimit);
  } catch (err) {
    return guardedError(err, options.requestId);
  }

  try {
    const response = await withWorkspace(options.principal.workspaceId, async (sql) => {
      // Remove expired response records before claiming. This occurs under the workspace GUC and
      // preserves actor isolation even if an application predicate is accidentally weakened.
      await sql`DELETE FROM mutation_idempotency
        WHERE workspace_id = ${options.principal.workspaceId} AND expires_at <= now()`;
      const inserted = await sql<{ id: string }[]>`INSERT INTO mutation_idempotency
        (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key,
         request_hash, state, lease_expires_at, expires_at)
        VALUES (${genId("idem")}, ${options.principal.workspaceId}, ${options.principal.actorKind},
          ${options.principal.actorId}, ${options.request.method.toUpperCase()}, ${canonicalPath(options.request)},
          ${key}, ${requestHash}, 'in_progress', now() + interval '60 seconds', now() + interval '24 hours')
        ON CONFLICT (workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key) DO NOTHING
        RETURNING id`;
      const rows = await sql<IdempotencyRow[]>
        `SELECT request_hash, state, lease_expires_at, response_status, response_headers, response_body,
                response_body_encrypted, response_body_iv, response_body_tag
         FROM mutation_idempotency
         WHERE workspace_id = ${options.principal.workspaceId} AND actor_kind = ${options.principal.actorKind}
           AND actor_id = ${options.principal.actorId} AND method = ${options.request.method.toUpperCase()}
           AND canonical_path = ${canonicalPath(options.request)} AND idempotency_key = ${key}
         FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new Error("idempotency claim was not visible after insert");
      if (row.request_hash !== requestHash) {
        return errorEnvelope(conflict("Idempotency-Key was already used for a different request"), options.requestId);
      }
      if (row.state === "completed") return replay(row);
      if (!inserted[0]) {
        // This can only be an abandoned record written by an older process/version: concurrent
        // normal requests wait on FOR UPDATE until the first transaction completes.
        if (new Date(row.lease_expires_at).getTime() > Date.now()) {
          return errorEnvelope(conflict("Idempotency-Key request is still in progress", true), options.requestId);
        }
        const claimed = await sql<{ id: string }[]>`UPDATE mutation_idempotency
          SET lease_expires_at = now() + interval '60 seconds', updated_at = now()
          WHERE workspace_id = ${options.principal.workspaceId} AND actor_kind = ${options.principal.actorKind}
            AND actor_id = ${options.principal.actorId} AND method = ${options.request.method.toUpperCase()}
            AND canonical_path = ${canonicalPath(options.request)} AND idempotency_key = ${key}
            AND lease_expires_at <= now()
          RETURNING id`;
        if (!claimed[0]) {
          return errorEnvelope(conflict("Idempotency-Key request could not be reclaimed", true), options.requestId);
        }
      }
      // An expired lease is safely reclaimed while the row remains locked. Get its stable id for
      // the completion update without exposing an unscoped lookup.
      const idRows = await sql<{ id: string }[]>`SELECT id FROM mutation_idempotency
        WHERE workspace_id = ${options.principal.workspaceId} AND actor_kind = ${options.principal.actorKind}
          AND actor_id = ${options.principal.actorId} AND method = ${options.request.method.toUpperCase()}
          AND canonical_path = ${canonicalPath(options.request)} AND idempotency_key = ${key} FOR UPDATE`;
      // A completed replay above must not be rate-limited. Only an execution claim consumes the
      // per-principal quota, so retrying a successful keyed mutation always returns its stored
      // response even after the caller has exhausted the current window.
      const retryAfter = await chargeRateLimitForPath(sql, options.principal, rateLimit, `${options.request.method.toUpperCase()} ${canonicalPath(options.request)}`);
      if (retryAfter !== null) {
        if (inserted[0]) {
          await sql`DELETE FROM mutation_idempotency
            WHERE workspace_id = ${options.principal.workspaceId} AND id = ${idRows[0]!.id}`;
        }
        const response = errorEnvelope(new ManifoldError({
          status: 429, code: "RATE_LIMITED", message: "mutation rate limit exceeded",
          reasonCodes: ["RATE_LIMIT_KEY"], retryable: true,
        }), options.requestId);
        response.headers.set("retry-after", String(retryAfter));
        return response;
      }
      const response = await invokeHandler(options.handler, sql as Sql & TransactionSql, options.requestId);
      return durableResponse(sql, options.principal.workspaceId, idRows[0]!.id, response, shouldEncryptReplay(options));
    });
    if (options.afterCommit) {
      try { await options.afterCommit(); } catch (error) {
        // The job is already durable; preserve exact replay bytes and let a later drain reclaim it.
        console.error(`[${options.requestId}] post-commit mutation dispatch failed:`, error);
      }
    }
    return response;
  } catch (err) {
    return guardedError(err, options.requestId);
  }
}

type PostCommitClaim =
  | { kind: "execute"; id: string }
  | { kind: "response"; response: Response }
  | { kind: "wait" };

async function claimPostCommitMutation(
  options: PostCommitMutationGuardOptions,
  key: string,
  requestHash: string,
  rateLimit: MutationRateLimit,
): Promise<PostCommitClaim> {
  return withWorkspace(options.principal.workspaceId, async (sql) => {
    await sql`DELETE FROM mutation_idempotency
      WHERE workspace_id = ${options.principal.workspaceId} AND expires_at <= now()`;
    const inserted = await sql<{ id: string }[]>`INSERT INTO mutation_idempotency
      (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key,
       request_hash, state, lease_expires_at, expires_at)
      VALUES (${genId("idem")}, ${options.principal.workspaceId}, ${options.principal.actorKind},
        ${options.principal.actorId}, ${options.request.method.toUpperCase()}, ${canonicalPath(options.request)},
        ${key}, ${requestHash}, 'in_progress', now() + interval '60 seconds', now() + interval '24 hours')
      ON CONFLICT (workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key) DO NOTHING
      RETURNING id`;
    const rows = await sql<(IdempotencyRow & { id: string })[]>`
      SELECT id, request_hash, state, lease_expires_at, response_status, response_headers, response_body,
             response_body_encrypted, response_body_iv, response_body_tag
      FROM mutation_idempotency
      WHERE workspace_id = ${options.principal.workspaceId} AND actor_kind = ${options.principal.actorKind}
        AND actor_id = ${options.principal.actorId} AND method = ${options.request.method.toUpperCase()}
        AND canonical_path = ${canonicalPath(options.request)} AND idempotency_key = ${key}
      FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error("idempotency claim was not visible after insert");
    if (row.request_hash !== requestHash) {
      return { kind: "response", response: errorEnvelope(conflict("Idempotency-Key was already used for a different request"), options.requestId) };
    }
    if (row.state === "completed") return { kind: "response", response: replay(row) };
    if (!inserted[0]) {
      if (new Date(row.lease_expires_at).getTime() > Date.now()) return { kind: "wait" };
      const reclaimed = await sql<{ id: string }[]>`UPDATE mutation_idempotency
        SET lease_expires_at = now() + interval '60 seconds', updated_at = now()
        WHERE workspace_id = ${options.principal.workspaceId} AND id = ${row.id}
          AND state = 'in_progress' AND lease_expires_at <= now()
        RETURNING id`;
      return reclaimed[0] ? { kind: "execute", id: row.id } : { kind: "wait" };
    }
    // Replays never consume another quota unit. A rejected first attempt leaves no claim because
    // it performed no mutation, so a later retry can legitimately attempt the operation again.
    const retryAfter = await chargeRateLimitForPath(sql, options.principal, rateLimit, `${options.request.method.toUpperCase()} ${canonicalPath(options.request)}`);
    if (retryAfter !== null) {
      await sql`DELETE FROM mutation_idempotency WHERE workspace_id = ${options.principal.workspaceId} AND id = ${row.id}`;
      const response = errorEnvelope(new ManifoldError({
        status: 429, code: "RATE_LIMITED", message: "mutation rate limit exceeded",
        reasonCodes: ["RATE_LIMIT_KEY"], retryable: true,
      }), options.requestId);
      response.headers.set("retry-after", String(retryAfter));
      return { kind: "response", response };
    }
    return { kind: "execute", id: row.id };
  });
}

/** See {@link PostCommitMutationGuardOptions}. */
export async function runPostCommitMutationGuard(options: PostCommitMutationGuardOptions): Promise<Response> {
  let key: string;
  let requestHash: string;
  let rateLimit: MutationRateLimit;
  try {
    key = requireMutationIdempotencyKey(options.request);
    requestHash = await mutationRequestHash(options.request);
    rateLimit = checkedRateLimit(options.rateLimit);
  } catch (err) {
    return guardedError(err, options.requestId);
  }
  try {
    // The normal execution lease is 60 seconds. Polling avoids returning a transient conflict for
    // an in-flight duplicate and guarantees the duplicate receives the exact durable response.
    const deadline = Date.now() + 5_000;
    for (let attempts = 0; Date.now() < deadline; attempts += 1) {
      const claim = await claimPostCommitMutation(options, key, requestHash, rateLimit);
      if (claim.kind === "response") return claim.response;
      if (claim.kind === "wait") {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, 25 * 2 ** Math.min(attempts, 4))));
        continue;
      }
      const response = await invokePostCommitHandler(options.handler, options.requestId);
      return withWorkspace(options.principal.workspaceId, (sql) =>
        durableResponse(sql, options.principal.workspaceId, claim.id, response, shouldEncryptReplay(options)));
    }
    return errorEnvelope(conflict("Idempotency-Key request is still in progress", true), options.requestId);
  } catch (err) {
    return guardedError(err, options.requestId);
  }
}

async function invokePostCommitHandler(handler: PostCommitMutationGuardOptions["handler"], requestId: string): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof ManifoldError) return errorEnvelope(err, requestId);
    console.error(`[${requestId}] unhandled post-commit guarded mutation error:`, err);
    return errorEnvelope(new ManifoldError({
      status: 500, code: "INTERNAL", message: "internal error", reasonCodes: [], retryable: true,
    }), requestId);
  }
}

async function invokeHandler(handler: MutationGuardOptions["handler"], sql: Sql & TransactionSql, requestId: string): Promise<Response> {
  try {
    // withWorkspace supplies postgres.js's TransactionSql, whose nested transaction API is
    // savepoint(). A handler failure therefore rolls back every handler write while preserving
    // the idempotency claim, which can then durably store its error response in the outer txn.
    return await sql.savepoint(async (savepoint) => handler(savepoint as unknown as Sql));
  } catch (err) {
    if (err instanceof ManifoldError) return errorEnvelope(err, requestId);
    console.error(`[${requestId}] unhandled guarded mutation error:`, err);
    return errorEnvelope(new ManifoldError({
      status: 500, code: "INTERNAL", message: "internal error", reasonCodes: [], retryable: true,
    }), requestId);
  }
}

function guardedError(err: unknown, requestId: string): Response {
  if (err instanceof ManifoldError) return errorEnvelope(err, requestId);
  console.error(`[${requestId}] mutation guard error:`, err);
  return errorEnvelope(new ManifoldError({
    status: 500, code: "INTERNAL", message: "internal error", reasonCodes: [], retryable: true,
  }), requestId);
}
