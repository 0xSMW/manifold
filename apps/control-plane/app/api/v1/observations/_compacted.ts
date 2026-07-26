import type { Sql } from "@manifold/database";

/**
 * The sole read seam for detail that outlives observation/event partitions.  It only reads the
 * fixed-width per-trace projection; usage_aggregate is intentionally absent because its rows are
 * dimension buckets and cannot truthfully answer a trace-id query.
 */
export interface CompactedTraceRow {
  trace_id: string;
  compacted_at: string;
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  reasoning_tokens: string;
  cache_write_tokens: string;
  audio_input_tokens: string;
  audio_output_tokens: string;
  usage_fidelity: string;
  cost_microusd: string;
  cost_fidelity: string;
}

export async function loadCompactedTrace(
  sql: Sql,
  workspaceId: string,
  traceId: string,
): Promise<CompactedTraceRow | null> {
  const rows = await sql<CompactedTraceRow[]>`
    SELECT trace_id, compacted_at,
      input_tokens::text, output_tokens::text, cache_read_tokens::text, reasoning_tokens::text,
      cache_write_tokens::text, audio_input_tokens::text, audio_output_tokens::text,
      usage_fidelity, cost_microusd::text, cost_fidelity
    FROM compacted_trace_projection
    WHERE workspace_id = ${workspaceId} AND trace_id = ${traceId}
    LIMIT 1`;
  return rows[0] ?? null;
}

/** Shared route-view seam so compacted responses cannot drift back to dimension aggregates. */
export function compactedDetailView(row: CompactedTraceRow): {
  detail_state: { state: "compacted"; detail_compacted: true; compacted_at: string; note: string };
  spans: [];
  usage: Pick<CompactedTraceRow, "input_tokens" | "output_tokens" | "cache_read_tokens" | "reasoning_tokens" | "cache_write_tokens" | "audio_input_tokens" | "audio_output_tokens" | "usage_fidelity">;
  cost: Pick<CompactedTraceRow, "cost_microusd" | "cost_fidelity">;
} {
  return {
    detail_state: {
      state: "compacted",
      detail_compacted: true,
      compacted_at: row.compacted_at,
      note: `Per-attempt detail was compacted on ${row.compacted_at}; durable per-trace usage and cost truth is retained.`,
    },
    spans: [],
    usage: row,
    cost: row,
  };
}
