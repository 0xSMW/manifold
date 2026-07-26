import { ManifoldError } from "@/lib/http";
import type { Sql } from "@/lib/db";

const MAX_LIMIT = 200;
const ALLOWED_QUERY_KEYS = new Set([
  "limit", "cursor", "actor", "actorKind", "action", "targetKind", "targetId",
  "hash", "beforeHash", "afterHash", "outcome", "from", "to", "profileId",
]);
const ACTOR_KINDS = new Set(["member", "api_token", "cli", "system"]);

export interface AuditListQuery {
  limit: number;
  cursor: AuditCursor | null;
  actor: string | null;
  actorKind: string | null;
  action: string | null;
  targetKind: string | null;
  targetId: string | null;
  hash: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  outcome: string | null;
  from: string | null;
  to: string | null;
  profileId: string | null;
}

export interface AuditCursor {
  createdAt: string;
  kind: AuditTimelineKind;
  id: string;
}

interface CursorPayload {
  v: number;
  createdAt: unknown;
  kind: unknown;
  id: unknown;
}

export type AuditTimelineKind = "audit_event" | "policy_decision";

function validation(message: string, path: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function single(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  if (values.length > 1) validation(`query parameter '${key}' may appear only once`, key);
  return values[0] ?? null;
}

function optionalText(params: URLSearchParams, key: string): string | null {
  const value = single(params, key);
  if (value === null) return null;
  if (!value || value.length > 256) validation(`query parameter '${key}' must be 1-256 characters`, key);
  return value;
}

function optionalTimestamp(params: URLSearchParams, key: string): string | null {
  const value = single(params, key);
  if (value === null) return null;
  if (!value || Number.isNaN(Date.parse(value))) {
    validation(`query parameter '${key}' must be an ISO-8601 timestamp`, key);
  }
  return new Date(value).toISOString();
}

function decodeCursor(value: string): AuditCursor {
  let parsed: CursorPayload;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    return validation("query parameter 'cursor' is invalid", "cursor");
  }
  if (parsed.v !== 2 || typeof parsed.createdAt !== "string" ||
      (parsed.kind !== "audit_event" && parsed.kind !== "policy_decision") || typeof parsed.id !== "string" ||
      !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) {
    return validation("query parameter 'cursor' is invalid", "cursor");
  }
  return { createdAt: new Date(parsed.createdAt).toISOString(), kind: parsed.kind, id: parsed.id };
}

/** Stable, opaque cursor for the timeline `(created_at, source, id)` ordering. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify({ v: 2, createdAt: cursor.createdAt, kind: cursor.kind, id: cursor.id })).toString("base64url");
}

/** Parse the public audit-list query surface; workspace identity is deliberately absent. */
export function parseAuditListQuery(req: Request): AuditListQuery {
  const params = new URL(req.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) validation(`unknown query parameter '${key}'`, key);
  }
  const limitValue = single(params, "limit");
  let limit = 50;
  if (limitValue !== null) {
    if (!/^[1-9]\d*$/.test(limitValue)) validation("query parameter 'limit' must be an integer from 1 to 200", "limit");
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) {
      validation("query parameter 'limit' must be an integer from 1 to 200", "limit");
    }
  }
  const actorKind = optionalText(params, "actorKind");
  if (actorKind !== null && !ACTOR_KINDS.has(actorKind)) {
    validation("query parameter 'actorKind' must be member, api_token, cli, or system", "actorKind");
  }
  const from = optionalTimestamp(params, "from");
  const to = optionalTimestamp(params, "to");
  if (from && to && from > to) validation("query parameter 'from' must be before or equal to 'to'", "from");
  const cursorValue = single(params, "cursor");
  return {
    limit,
    cursor: cursorValue === null ? null : decodeCursor(cursorValue),
    actor: optionalText(params, "actor"), actorKind, action: optionalText(params, "action"),
    targetKind: optionalText(params, "targetKind"), targetId: optionalText(params, "targetId"),
    hash: optionalText(params, "hash"), beforeHash: optionalText(params, "beforeHash"),
    afterHash: optionalText(params, "afterHash"), outcome: optionalText(params, "outcome"),
    from, to, profileId: optionalText(params, "profileId"),
  };
}

export interface AuditEventRow {
  id: string;
  actor_kind: string;
  actor_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  before_hash: string | null;
  after_hash: string | null;
  request_ref: string | null;
  outcome: string | null;
  profile_id: string | null;
  chain_version: number | null;
  prev_chain_hash: Buffer | null;
  chain_hash: Buffer | null;
  chain_sealed_at: string | null;
  created_at: string;
}

export interface PolicyDecisionRow {
  id: string;
  request_id: string;
  trace_id: string | null;
  outcome: string;
  reason_codes: unknown;
  policy_revision_id: string | null;
  created_at: string;
}

export type AuditTimelineRow =
  | ({ kind: "audit_event"; source_order: 1 } & AuditEventRow)
  | ({ kind: "policy_decision"; source_order: 0 } & PolicyDecisionRow);

export type AuditTimelineItem = ReturnType<typeof serializeAuditTimelineRow>;

/** Deliberately projects no `detail`: old audit payloads may contain sensitive mutation inputs. */
export function serializeAuditEvent(row: AuditEventRow) {
  const sealed = row.chain_version === 1 && !!row.chain_hash && !!row.chain_sealed_at;
  return {
    id: row.id,
    actor: { kind: row.actor_kind, id: row.actor_id },
    action: row.action,
    target: row.target_kind || row.target_id ? { kind: row.target_kind, id: row.target_id } : null,
    hashes: { before: row.before_hash, after: row.after_hash },
    outcome: row.outcome,
    links: {
      requestRef: row.request_ref,
      profileId: row.profile_id,
      target: row.target_kind || row.target_id ? { kind: row.target_kind, id: row.target_id } : null,
    },
    createdAt: row.created_at,
    chain: sealed ? {
      version: 1,
      previousHash: Buffer.from(row.prev_chain_hash ?? []).toString("hex") || null,
      hash: Buffer.from(row.chain_hash ?? []).toString("hex"),
      sealedAt: row.chain_sealed_at,
    } : null,
    // Records created before migration 0011 did not carry a cryptographic commitment. They stay
    // explicitly legacy instead of being backfilled with a claim we cannot substantiate.
    chainVerification: sealed
      ? { status: "sealed", reason: "included in the workspace audit hash chain" }
      : { status: "legacy_unsealed", reason: "record predates persisted audit chain hashes" },
    // audit_event has no compacted column; detail compaction cannot be inferred from a read.
    compaction: { status: "not_applicable" },
  };
}

/**
 * The list view deliberately distinguishes immutable audit events from gateway policy verdicts.
 * A policy decision has no recorded actor, action, or content hashes, so those fields are omitted
 * rather than inferred from a related request or observation.
 */
export function serializeAuditTimelineRow(row: AuditTimelineRow) {
  if (row.kind === "audit_event") return { kind: "audit_event" as const, ...serializeAuditEvent(row) };
  return {
    kind: "policy_decision" as const,
    id: row.id,
    outcome: row.outcome,
    reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.filter((code): code is string => typeof code === "string") : [],
    target: row.policy_revision_id ? { kind: "policy_revision", id: row.policy_revision_id } : null,
    links: {
      requestId: row.request_id,
      traceId: row.trace_id,
      policyRevisionId: row.policy_revision_id,
      // policy_decision does not persist a subject or requested model. Do not derive either
      // from an observation: it can represent a later routed result rather than this verdict.
      subject: null,
      model: null,
    },
    createdAt: row.created_at,
  };
}

/**
 * Read the two append-only sources as one stable timeline. `source_order` is part of the
 * cursor because ids are only unique within their source, and timestamps can be equal.
 */
export async function selectAuditTimelineRows(
  sql: Sql,
  workspaceId: string,
  query: AuditListQuery,
): Promise<AuditTimelineRow[]> {
  const cursorAt = query.cursor?.createdAt ?? null;
  const cursorKind = query.cursor?.kind ?? null;
  const cursorId = query.cursor?.id ?? null;
  return sql<AuditTimelineRow[]>`
    SELECT * FROM (
      SELECT
        'audit_event'::text AS kind, 1::integer AS source_order,
        id, actor_kind, actor_id, action, target_kind, target_id, before_hash, after_hash,
        request_ref, detail ->> 'outcome' AS outcome, detail ->> 'profileId' AS profile_id,
        chain_version, prev_chain_hash, chain_hash, chain_sealed_at, created_at,
        NULL::text AS request_id, NULL::text AS trace_id, NULL::jsonb AS reason_codes,
        NULL::text AS policy_revision_id
      FROM audit_event
      WHERE workspace_id = ${workspaceId}
        AND (${query.actor}::text IS NULL OR actor_id = ${query.actor})
        AND (${query.actorKind}::text IS NULL OR actor_kind = ${query.actorKind})
        AND (${query.action}::text IS NULL OR action = ${query.action})
        AND (${query.targetKind}::text IS NULL OR target_kind = ${query.targetKind})
        AND (${query.targetId}::text IS NULL OR target_id = ${query.targetId})
        AND (${query.hash}::text IS NULL OR before_hash = ${query.hash} OR after_hash = ${query.hash})
        AND (${query.beforeHash}::text IS NULL OR before_hash = ${query.beforeHash})
        AND (${query.afterHash}::text IS NULL OR after_hash = ${query.afterHash})
        AND (${query.outcome}::text IS NULL OR detail ->> 'outcome' = ${query.outcome})
        AND (${query.profileId}::text IS NULL OR target_id = ${query.profileId} OR detail ->> 'profileId' = ${query.profileId})
        AND (${query.from}::timestamptz IS NULL OR created_at >= ${query.from}::timestamptz)
        AND (${query.to}::timestamptz IS NULL OR created_at <= ${query.to}::timestamptz)

      UNION ALL

      SELECT
        'policy_decision'::text AS kind, 0::integer AS source_order,
        p.id,
        NULL::text AS actor_kind, NULL::text AS actor_id, NULL::text AS action,
        NULL::text AS target_kind, NULL::text AS target_id,
        NULL::text AS before_hash, NULL::text AS after_hash, NULL::text AS request_ref,
        p.outcome, NULL::text AS profile_id,
        NULL::integer AS chain_version, NULL::bytea AS prev_chain_hash, NULL::bytea AS chain_hash,
        NULL::timestamptz AS chain_sealed_at, p.created_at,
        p.request_id, p.trace_id, p.reason_codes, p.policy_revision_id
      FROM policy_decision p
      WHERE p.workspace_id = ${workspaceId}
        -- These audit-only dimensions have no persisted policy-decision equivalent. Excluding
        -- policy rows when one is requested prevents a related record from being misrepresented.
        AND (${query.actor}::text IS NULL)
        AND (${query.actorKind}::text IS NULL)
        AND (${query.action}::text IS NULL)
        AND (${query.hash}::text IS NULL)
        AND (${query.beforeHash}::text IS NULL)
        AND (${query.afterHash}::text IS NULL)
        AND (${query.profileId}::text IS NULL)
        AND (${query.targetKind}::text IS NULL OR (${query.targetKind} = 'policy_revision' AND p.policy_revision_id IS NOT NULL))
        AND (${query.targetId}::text IS NULL OR p.policy_revision_id = ${query.targetId})
        AND (${query.outcome}::text IS NULL OR p.outcome = ${query.outcome})
        AND (${query.from}::timestamptz IS NULL OR p.created_at >= ${query.from}::timestamptz)
        AND (${query.to}::timestamptz IS NULL OR p.created_at <= ${query.to}::timestamptz)
    ) timeline
    WHERE ${cursorAt}::timestamptz IS NULL
      OR timeline.created_at < ${cursorAt}::timestamptz
      OR (timeline.created_at = ${cursorAt}::timestamptz AND (
        timeline.source_order < CASE WHEN ${cursorKind} = 'audit_event' THEN 1 ELSE 0 END
        OR (timeline.source_order = CASE WHEN ${cursorKind} = 'audit_event' THEN 1 ELSE 0 END AND timeline.id < ${cursorId})
      ))
    ORDER BY timeline.created_at DESC, timeline.source_order DESC, timeline.id DESC
    LIMIT ${query.limit + 1}`;
}
