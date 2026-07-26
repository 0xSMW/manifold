import type { Sql } from "@/lib/db";
import type {
  ObservationCursor,
  ObservationFilters,
  ObservationListRow,
} from "./_query";

export interface LatencySummary {
  sampleCount: string;
  p50Ms: number | null;
  p95Ms: number | null;
}

interface LatencySummaryRow {
  sample_count: string | number;
  p50_ms: number | null;
  p95_ms: number | null;
}

/** Scalar ordered-set aggregate: observation rows never leave PostgreSQL for this query. */
export async function selectLatencySummary(
  sql: Sql,
  workspaceId: string,
  from: string,
  to: string,
  profile: string | null,
): Promise<LatencySummary> {
  const rows = await sql<LatencySummaryRow[]>`
    SELECT
      count(o.latency_ms)::bigint AS sample_count,
      percentile_disc(0.50) WITHIN GROUP (ORDER BY o.latency_ms)::int AS p50_ms,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY o.latency_ms)::int AS p95_ms
    FROM observation o
    WHERE o.workspace_id = ${workspaceId}
      AND o.created_at >= ${from}::timestamptz
      AND o.created_at < ${to}::timestamptz
      AND (${profile}::text IS NULL OR o.profile_mode = ${profile})
      AND o.latency_ms IS NOT NULL`;
  const row = rows[0] ?? { sample_count: 0, p50_ms: null, p95_ms: null };
  return { sampleCount: String(row.sample_count), p50Ms: row.p50_ms, p95Ms: row.p95_ms };
}

export async function selectObservationRows(
  sql: Sql,
  workspaceId: string,
  filters: ObservationFilters,
  cursor: ObservationCursor | null,
  limit: number,
): Promise<ObservationListRow[]> {
  const cursorAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  return sql<ObservationListRow[]>`
    SELECT
      o.id, o.trace_id, o.installation_id, o.profile_mode,
      o.route_id, o.public_name, o.endpoint_kind,
      o.final_provider, o.final_offering_id,
      off.canonical_model_id, cm.canonical_slug AS canonical_model_slug,
      off.provider_model_id,
      o.app_id, app.slug AS app_slug,
      o.action_id, act.slug AS action_slug,
      o.team_id, o.cost_center_id, cc.slug AS cost_center_slug,
      o.virtual_key_id, vk.display_prefix AS key_prefix,
      o.status, o.http_status,
      o.input_tokens, o.output_tokens, o.cache_read_tokens, o.reasoning_tokens,
      o.cache_write_tokens, o.audio_input_tokens, o.audio_output_tokens,
      o.cost_microusd, o.cost_fidelity, o.latency_ms, o.ttfb_ms,
      o.attempts, o.failovers, o.reason_codes, o.compacted,
      o.occurred_at, o.created_at
    FROM observation o
    LEFT JOIN provider_model_offering off ON off.id = o.final_offering_id
    LEFT JOIN canonical_model cm ON cm.id = off.canonical_model_id
    LEFT JOIN app
      ON app.id = o.app_id AND app.workspace_id = ${workspaceId}
    LEFT JOIN action act
      ON act.id = o.action_id AND act.workspace_id = ${workspaceId}
    LEFT JOIN cost_center cc
      ON cc.id = o.cost_center_id AND cc.workspace_id = ${workspaceId}
    LEFT JOIN virtual_key vk
      ON vk.id = o.virtual_key_id AND vk.workspace_id = ${workspaceId}
    WHERE o.workspace_id = ${workspaceId}
      AND o.created_at >= ${filters.from}::timestamptz
      AND o.created_at < ${filters.to}::timestamptz
      AND (${filters.profile}::text IS NULL OR o.profile_mode = ${filters.profile})
      AND (
        ${filters.route}::text IS NULL
        OR o.route_id = ${filters.route}
        OR o.public_name = ${filters.route}
      )
      AND (
        ${filters.model}::text IS NULL
        OR o.final_offering_id = ${filters.model}
        OR off.canonical_model_id = ${filters.model}
        OR off.provider_model_id = ${filters.model}
        OR cm.canonical_slug = ${filters.model}
      )
      AND (${filters.provider}::text IS NULL OR o.final_provider = ${filters.provider})
      AND (${filters.status}::text IS NULL OR o.status = ${filters.status})
      AND (
        ${filters.app}::text IS NULL
        OR o.app_id = ${filters.app}
        OR app.slug = ${filters.app}
      )
      AND (
        ${filters.action}::text IS NULL
        OR o.action_id = ${filters.action}
        OR act.slug = ${filters.action}
      )
      AND (
        ${filters.key}::text IS NULL
        OR o.virtual_key_id = ${filters.key}
        OR vk.display_prefix = ${filters.key}
      )
      AND (
        ${filters.costCenter}::text IS NULL
        OR o.cost_center_id = ${filters.costCenter}
        OR cc.slug = ${filters.costCenter}
      )
      AND (
        ${filters.minLatencyMs}::integer IS NULL
        OR o.latency_ms >= ${filters.minLatencyMs}
      )
      AND (${filters.errorsOnly}::boolean = false OR o.status <> 'ok')
      AND (
        ${filters.trace}::text IS NULL
        OR position(lower(${filters.trace}) in lower(o.trace_id)) > 0
      )
      AND (
        ${cursorAt}::timestamptz IS NULL
        OR o.created_at < ${cursorAt}::timestamptz
        OR (o.created_at = ${cursorAt}::timestamptz AND o.id < ${cursorId})
      )
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${limit}`;
}

export async function observationIngestLagSeconds(
  sql: Sql,
  workspaceId: string,
): Promise<number> {
  const rows = await sql<{ lag_seconds: number | string | null }[]>`
    SELECT COALESCE(MAX(lag_seconds), 0) AS lag_seconds
    FROM projection_checkpoint
    WHERE workspace_id = ${workspaceId}
      AND projection IN ('observation', 'trace_summary')`;
  return Math.max(0, Number(rows[0]?.lag_seconds ?? 0));
}
