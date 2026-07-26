import { authorize } from "@/lib/auth";
import { contractOk } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { ObservationContracts } from "@manifold/contracts";
import {
  capturePolicyView,
  captureView,
  safeSpanPayload,
} from "../_detail";
import { compactedDetailView, loadCompactedTrace, type CompactedTraceRow } from "../_compacted";
import { serializeObservation, type ObservationListRow } from "../_query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DetailRow extends ObservationListRow {
  route_revision_id: string | null;
  adapter_revision: string | null;
  price_revision_id: string | null;
  policy_decision_id: string | null;
  capture_ref: unknown;
  route_capture_policy: unknown;
  app_capture_policy: unknown;
  data_handling_mode: string | null;
  policy_name: string | null;
}

interface SummaryRow {
  trace_id: string;
  root_observation_id: string;
  span_count: number;
  error: boolean;
  total_cost_microusd: string | number | null;
  total_latency_ms: number | null;
  started_at: string;
  created_at: string;
}

interface EventRow {
  id: string;
  span_id: string;
  parent_span_id: string | null;
  kind: string;
  seq: number;
  payload: unknown;
  occurred_at: string;
  created_at: string;
  offering_id: string | null;
  provider: string | null;
  provider_model_id: string | null;
  adapter_revision: string | null;
}

interface UsageRow {
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  reasoning_tokens: string | null;
  cache_write_tokens: string | null;
  audio_input_tokens: string | null;
  audio_output_tokens: string | null;
  fidelity: string;
}

interface CostRow {
  amount_microusd: string | null;
  fidelity: string;
}

interface DecisionRow {
  id: string;
  request_id: string;
  trace_id: string | null;
  outcome: string;
  reason_codes: unknown;
  policy_revision_id: string | null;
  created_at: string;
}

interface AnnotationRow {
  id: string;
  author_id: string | null;
  body: string | null;
  tags: unknown;
  updated_at: string;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  score: string | number | null;
  label: string | null;
  source: string | null;
  created_at: string;
}

interface AuditRow {
  id: string;
  action: string;
  request_ref: string | null;
  created_at: string;
}

function traceIdFrom(params: { traceId: string }): string {
  let traceId: string;
  try {
    traceId = decodeURIComponent(params.traceId).trim();
  } catch {
    traceId = "";
  }
  if (!traceId || traceId.length > 256) {
    throw new ManifoldError({
      status: 422,
      code: "VALIDATION",
      message: "traceId must be a non-empty string of at most 256 characters",
      reasonCodes: [],
      details: { issues: [{ path: "traceId", message: "invalid trace id" }] },
    });
  }
  return traceId;
}

function tokenString(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function scopesAllowCapture(scopes: string[]): boolean {
  return (
    scopes.includes("*") ||
    scopes.includes("observations:read") ||
    scopes.includes("observations:captures:read") ||
    scopes.includes("observations:capture:read")
  );
}

export async function GET(
  req: Request,
  context: { params: Promise<{ traceId: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const traceId = traceIdFrom(await context.params);

    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const compacted = await loadCompactedTrace(sql, principal.workspaceId, traceId);
      const summaries = await sql<SummaryRow[]>`
        SELECT trace_id, root_observation_id, span_count, error,
               total_cost_microusd, total_latency_ms, started_at, created_at
        FROM trace_summary
        WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
        ORDER BY created_at DESC
        LIMIT 1`;
      const observations = await sql<DetailRow[]>`
        SELECT
          o.id, o.trace_id, o.installation_id, o.profile_mode,
          o.route_id, o.route_revision_id, o.public_name, o.endpoint_kind,
          o.final_provider, o.final_offering_id, o.adapter_revision, o.price_revision_id,
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
          o.attempts, o.failovers, o.policy_decision_id, o.reason_codes,
          o.capture_ref, o.compacted, o.occurred_at, o.created_at,
          rr.capture_policy AS route_capture_policy,
          app.default_capture_policy AS app_capture_policy,
          dh.capture_mode AS data_handling_mode,
          gp.name AS policy_name
        FROM observation o
        LEFT JOIN provider_model_offering off ON off.id = o.final_offering_id
        LEFT JOIN canonical_model cm ON cm.id = off.canonical_model_id
        LEFT JOIN gateway_route_revision rr
          ON rr.id = o.route_revision_id AND rr.workspace_id = ${principal.workspaceId}
        LEFT JOIN app
          ON app.id = o.app_id AND app.workspace_id = ${principal.workspaceId}
        LEFT JOIN action act
          ON act.id = o.action_id AND act.workspace_id = ${principal.workspaceId}
        LEFT JOIN cost_center cc
          ON cc.id = o.cost_center_id AND cc.workspace_id = ${principal.workspaceId}
        LEFT JOIN virtual_key vk
          ON vk.id = o.virtual_key_id AND vk.workspace_id = ${principal.workspaceId}
        LEFT JOIN LATERAL (
          SELECT policy_revision_id
          FROM policy_decision candidate
          WHERE candidate.id = o.policy_decision_id
            AND candidate.workspace_id = ${principal.workspaceId}
            AND candidate.trace_id = o.trace_id
          ORDER BY candidate.created_at DESC
          LIMIT 1
        ) pd ON true
        LEFT JOIN gateway_policy_revision gpr
          ON gpr.id = pd.policy_revision_id AND gpr.workspace_id = ${principal.workspaceId}
        LEFT JOIN gateway_policy gp
          ON gp.id = gpr.policy_id AND gp.workspace_id = ${principal.workspaceId}
        LEFT JOIN LATERAL (
          SELECT capture_mode
          FROM data_handling_constraint candidate
          WHERE candidate.policy_revision_id = gpr.id
            AND candidate.workspace_id = ${principal.workspaceId}
          ORDER BY CASE candidate.capture_mode
            WHEN 'none' THEN 0
            WHEN 'metadata' THEN 1
            WHEN 'redacted' THEN 2
            WHEN 'full' THEN 3
            ELSE 0
          END ASC
          LIMIT 1
        ) dh ON true
        WHERE o.workspace_id = ${principal.workspaceId} AND o.trace_id = ${traceId}
        ORDER BY o.created_at DESC
        LIMIT 1`;
      if (!observations[0] && !summaries[0] && !compacted) return null;

      const [events, usage, costs, decisions, annotations, feedback, audits] = await Promise.all([
        sql<EventRow[]>`
          SELECT e.id, e.span_id, e.parent_span_id, e.kind, e.seq, e.payload,
                 e.occurred_at, e.created_at,
                 off.id AS offering_id, off.provider, off.provider_model_id,
                 off.adapter_revision
          FROM observation_event e
          LEFT JOIN provider_model_offering off
            ON off.id = e.payload ->> 'offeringId'
          WHERE e.workspace_id = ${principal.workspaceId} AND e.trace_id = ${traceId}
          ORDER BY e.seq ASC, e.occurred_at ASC, e.id ASC`,
        sql<UsageRow[]>`
          SELECT
            SUM(COALESCE(input_tokens, 0))::text AS input_tokens,
            SUM(COALESCE(output_tokens, 0))::text AS output_tokens,
            SUM(COALESCE(cache_read_tokens, 0))::text AS cache_read_tokens,
            SUM(COALESCE(reasoning_tokens, 0))::text AS reasoning_tokens,
            SUM(COALESCE(cache_write_tokens, 0))::text AS cache_write_tokens,
            SUM(COALESCE(audio_input_tokens, 0))::text AS audio_input_tokens,
            SUM(COALESCE(audio_output_tokens, 0))::text AS audio_output_tokens,
            CASE
              WHEN COUNT(*) = 0 THEN 'unknown'
              WHEN BOOL_AND(fidelity = 'exact') THEN 'exact'
              WHEN BOOL_OR(fidelity IN ('exact', 'estimated')) THEN 'estimated'
              ELSE 'unknown'
            END AS fidelity
          FROM usage_record
          WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}`,
        sql<CostRow[]>`
          SELECT SUM(amount_microusd)::text AS amount_microusd,
            CASE
              WHEN COUNT(*) = 0 THEN 'unknown'
              WHEN BOOL_AND(fidelity = 'exact') THEN 'exact'
              WHEN BOOL_OR(fidelity IN ('exact', 'estimated')) THEN 'estimated'
              ELSE 'unknown'
            END AS fidelity
          FROM cost_ledger
          WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}`,
        sql<DecisionRow[]>`
          SELECT id, request_id, trace_id, outcome, reason_codes,
                 policy_revision_id, created_at
          FROM policy_decision
          WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
          ORDER BY created_at DESC, id DESC`,
        sql<AnnotationRow[]>`
          SELECT id, author_id, body, tags, updated_at, created_at
          FROM annotation
          WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
          ORDER BY created_at ASC, id ASC`,
        sql<FeedbackRow[]>`
          SELECT id, score, label, source, created_at
          FROM feedback_event
          WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
          ORDER BY created_at ASC, id ASC`,
        sql<AuditRow[]>`
          SELECT id, action, request_ref, created_at
          FROM audit_event
          WHERE workspace_id = ${principal.workspaceId}
            AND (
              request_ref = ${traceId}
              OR target_id = ${traceId}
              OR request_ref IN (
                SELECT request_id FROM policy_decision
                WHERE workspace_id = ${principal.workspaceId} AND trace_id = ${traceId}
              )
            )
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      ]);
      return {
        observation: observations[0] ?? null,
        summary: summaries[0] ?? null,
        compacted,
        events,
        usage: usage[0] ?? null,
        cost: costs[0] ?? null,
        decisions,
        annotations,
        feedback,
        audit: audits[0] ?? null,
      };
    });

    if (!result) {
      throw new ManifoldError({
        status: 404,
        code: "NOT_FOUND",
        message: "observation trace not found",
        reasonCodes: [],
      });
    }

    const observation = result.observation;
    const summary = result.summary;
    const compacted: CompactedTraceRow | null = result.compacted;
    const compactedView = compacted ? compactedDetailView(compacted) : null;
    const policy = capturePolicyView({
      routePolicy: observation?.route_capture_policy ?? null,
      appPolicy: observation?.app_capture_policy ?? null,
      routeRevisionId: observation?.route_revision_id ?? null,
      appSlug: observation?.app_slug ?? null,
      dataHandlingMode: observation?.data_handling_mode ?? null,
      policyName: observation?.policy_name ?? null,
    });
    const usage = result.usage;
    const cost = result.cost;
    const hasUsageProjection =
      usage !== null &&
      [
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.reasoning_tokens,
        usage.cache_write_tokens,
        usage.audio_input_tokens,
        usage.audio_output_tokens,
      ].some((value) => value !== null);
    const hasCostLedger = cost?.amount_microusd !== null && cost?.amount_microusd !== undefined;
    const detailState =
      compacted || observation?.compacted
        ? "compacted"
        : result.events.length
          ? "full"
          : "unavailable";
    const spans = (detailState === "compacted" ? [] : result.events).map((event, index) => {
      const next = result.events[index + 1];
      const elapsed =
        next && Date.parse(next.occurred_at) >= Date.parse(event.occurred_at)
          ? Date.parse(next.occurred_at) - Date.parse(event.occurred_at)
          : null;
      return {
        id: event.span_id,
        parent_span_id: event.parent_span_id,
        kind: event.kind,
        seq: event.seq,
        occurred_at: event.occurred_at,
        duration_ms: elapsed,
        provider:
          event.kind === "provider_attempt"
            ? {
                name: event.provider,
                offering_id: event.offering_id,
                provider_model_id: event.provider_model_id,
                adapter_revision: event.adapter_revision,
              }
            : null,
        detail: safeSpanPayload(event.kind, event.payload),
      };
    });

    return contractOk(ObservationContracts.detail,
      {
        trace_id: traceId,
        detail_state: {
          state: detailState,
          detail_compacted: detailState === "compacted",
          compacted_at: compactedView?.detail_state.compacted_at ?? null,
          note:
            detailState === "compacted"
              ? compactedView?.detail_state.note ?? "Per-attempt detail was compacted; durable per-trace usage and cost truth is retained."
              : detailState === "unavailable"
                ? "No span journal detail is currently available for this trace."
                : null,
        },
        observation: observation ? serializeObservation(observation) : null,
        summary: summary
          ? {
              root_observation_id: summary.root_observation_id,
              span_count: summary.span_count,
              error: summary.error,
              total_cost_microusd: tokenString(summary.total_cost_microusd),
              total_latency_ms: summary.total_latency_ms,
              started_at: summary.started_at,
            }
          : null,
        spans,
        attempts: spans.filter((span) => span.kind === "provider_attempt"),
        usage: {
          input_tokens: compacted?.input_tokens ?? usage?.input_tokens ?? tokenString(observation?.input_tokens),
          output_tokens: compacted?.output_tokens ?? usage?.output_tokens ?? tokenString(observation?.output_tokens),
          cache_read_tokens:
            compacted?.cache_read_tokens ?? usage?.cache_read_tokens ?? tokenString(observation?.cache_read_tokens),
          reasoning_tokens:
            compacted?.reasoning_tokens ?? usage?.reasoning_tokens ?? tokenString(observation?.reasoning_tokens),
          cache_write_tokens:
            compacted?.cache_write_tokens ?? usage?.cache_write_tokens ?? tokenString(observation?.cache_write_tokens),
          audio_input_tokens:
            compacted?.audio_input_tokens ?? usage?.audio_input_tokens ?? tokenString(observation?.audio_input_tokens),
          audio_output_tokens:
            compacted?.audio_output_tokens ?? usage?.audio_output_tokens ?? tokenString(observation?.audio_output_tokens),
          fidelity:
            compacted?.usage_fidelity ?? (hasUsageProjection ? usage?.fidelity : observation?.cost_fidelity) ?? "unknown",
        },
        cost: {
          amount_microusd:
            compacted?.cost_microusd ?? (hasCostLedger ? cost?.amount_microusd : null) ??
            tokenString(observation?.cost_microusd) ??
            tokenString(summary?.total_cost_microusd),
          fidelity:
            compacted?.cost_fidelity ?? (hasCostLedger ? cost?.fidelity : observation?.cost_fidelity) ?? "unknown",
          price_revision_id: observation?.price_revision_id ?? null,
        },
        capture: captureView(
          observation?.capture_ref ?? null,
          policy,
          scopesAllowCapture(principal.scopes),
        ),
        policy_decisions: result.decisions.map((decision) => ({
          id: decision.id,
          request_id: decision.request_id,
          outcome: decision.outcome,
          reason_codes: Array.isArray(decision.reason_codes) ? decision.reason_codes : [],
          policy_revision_id: decision.policy_revision_id,
          created_at: decision.created_at,
        })),
        annotations: result.annotations.map((annotation) => ({
          id: annotation.id,
          author_id: annotation.author_id,
          body: annotation.body,
          tags: Array.isArray(annotation.tags) ? annotation.tags : [],
          updated_at: annotation.updated_at,
          created_at: annotation.created_at,
        })),
        feedback: result.feedback.map((item) => ({
          id: item.id,
          score: item.score === null ? null : String(item.score),
          label: item.label,
          source: item.source,
          created_at: item.created_at,
        })),
        audit: result.audit
          ? {
              id: result.audit.id,
              action: result.audit.action,
              request_ref: result.audit.request_ref,
              created_at: result.audit.created_at,
              href: `/audit?event=${encodeURIComponent(result.audit.id)}`,
            }
          : null,
      },
      requestId,
    );
  });
}
