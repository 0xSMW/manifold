import { authorize } from "@/lib/auth";
import { contractOk, contractQuery } from "@/lib/contracts";
import { withWorkspace } from "@/lib/db";
import { ManifoldError, wrapInEnvelope } from "@/lib/http";
import { UsageContracts } from "@manifold/contracts";
import {
  parseLimit,
  parseObservationFilters,
} from "../observations/_query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAINS = new Set(["hourly", "daily", "monthly"]);
const DIMENSIONS = new Set([
  "route",
  "provider",
  "app",
  "team",
  "cost_center",
  "model",
  "status",
  "profile",
]);

interface UsageCursor {
  bucketStart: string;
  grain: string;
  dimsHash: string;
}

interface AggregateRow {
  grain: string;
  bucket_start: string;
  dims: unknown;
  dims_hash: string;
  dimension_value: string | null;
  requests: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  reasoning_tokens: string | number;
  cost_microusd: string | number;
  errors: string | number;
  failovers: string | number;
  latency_ms_sum: string | number;
  latency_ms_p95: number | null;
  updated_at: string;
}

function validation(path: string, message: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function encodeCursor(cursor: UsageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): UsageCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as UsageCursor).bucketStart !== "string" ||
      !Number.isFinite(Date.parse((parsed as UsageCursor).bucketStart)) ||
      typeof (parsed as UsageCursor).grain !== "string" ||
      !GRAINS.has((parsed as UsageCursor).grain) ||
      typeof (parsed as UsageCursor).dimsHash !== "string" ||
      !(parsed as UsageCursor).dimsHash
    ) {
      validation("cursor", "cursor is invalid");
    }
    return {
      bucketStart: new Date((parsed as UsageCursor).bucketStart).toISOString(),
      grain: (parsed as UsageCursor).grain,
      dimsHash: (parsed as UsageCursor).dimsHash,
    };
  } catch (error) {
    if (error instanceof ManifoldError) throw error;
    validation("cursor", "cursor is invalid");
  }
}

function optionalQuery(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null || !value.trim()) return null;
  if (value.trim().length > 256) validation(key, `${key} must be at most 256 characters`);
  return value.trim();
}

function utcDayBoundary(beforeMs: number): string {
  const value = new Date(Date.now() - beforeMs);
  const wasBoundary =
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;
  value.setUTCHours(0, 0, 0, 0);
  if (!wasBoundary) value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

function utcMonthBoundary(beforeMs: number): string {
  const value = new Date(Date.now() - beforeMs);
  const wasBoundary =
    value.getUTCDate() === 1 &&
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0;
  value.setUTCDate(1);
  value.setUTCHours(0, 0, 0, 0);
  if (!wasBoundary) value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString();
}

function safeDims(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const dims = value as Record<string, unknown>;
  const allowed = [
    "route_id",
    "provider",
    "offering_id",
    "canonical_model_id",
    "model_id",
    "app_id",
    "team_id",
    "cost_center_id",
    "status",
    "profile_mode",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => typeof dims[key] === "string" || dims[key] === null)
      .map((key) => [key, dims[key] as string | null]),
  );
}

export async function GET(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "observations:read");
    const params = new URL(req.url).searchParams;
    contractQuery(params, UsageContracts.query);
    const time = parseObservationFilters(params);
    const grain = params.get("grain") ?? "hourly";
    if (!GRAINS.has(grain)) {
      validation("grain", "grain must be hourly, daily, or monthly");
    }
    const dimension = params.get("dimension") ?? "provider";
    if (!DIMENSIONS.has(dimension)) {
      validation(
        "dimension",
        "dimension must be route, provider, app, team, cost_center, model, status, or profile",
      );
    }
    const dimensionValue =
      optionalQuery(params, "dimension_value") ?? optionalQuery(params, "dimensionValue");
    const cursor = decodeCursor(params.get("cursor"));
    const limit = parseLimit(params);
    const hourlyBoundary = utcDayBoundary(14 * 24 * 60 * 60 * 1_000);
    const dailyBoundary = utcMonthBoundary(400 * 24 * 60 * 60 * 1_000);
    const crossesBoundary =
      (grain === "hourly" && Date.parse(time.from) < Date.parse(hourlyBoundary)) ||
      (grain === "daily" && Date.parse(time.from) < Date.parse(dailyBoundary));
    const fallbackGrain =
      grain === "hourly" ? "daily" : grain === "daily" ? "monthly" : null;
    const boundary =
      grain === "hourly" ? hourlyBoundary : grain === "daily" ? dailyBoundary : null;

    const rows = await withWorkspace(principal.workspaceId, (sql) =>
      sql<AggregateRow[]>`
        SELECT
          grain, bucket_start, dims, dims_hash,
          CASE ${dimension}
            WHEN 'route' THEN dims ->> 'route_id'
            WHEN 'provider' THEN dims ->> 'provider'
            WHEN 'app' THEN dims ->> 'app_id'
            WHEN 'team' THEN dims ->> 'team_id'
            WHEN 'cost_center' THEN dims ->> 'cost_center_id'
            WHEN 'model' THEN COALESCE(
              dims ->> 'canonical_model_id',
              dims ->> 'model_id',
              dims ->> 'offering_id'
            )
            WHEN 'status' THEN dims ->> 'status'
            WHEN 'profile' THEN dims ->> 'profile_mode'
            ELSE NULL
          END AS dimension_value,
          requests, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
          cost_microusd, errors, failovers, latency_ms_sum, latency_ms_p95, updated_at
        FROM usage_aggregate
        WHERE workspace_id = ${principal.workspaceId}
          AND bucket_start >= ${time.from}::timestamptz
          AND bucket_start < ${time.to}::timestamptz
          AND (
            (
              grain = ${grain}
              AND (${boundary}::timestamptz IS NULL OR bucket_start >= ${boundary}::timestamptz)
            )
            OR (
              ${fallbackGrain}::text IS NOT NULL
              AND grain = ${fallbackGrain}
              AND bucket_start < ${boundary}::timestamptz
            )
          )
          AND (
            ${time.profile}::text IS NULL
            OR dims ->> 'profile_mode' = ${time.profile}
          )
          AND (
            ${dimensionValue}::text IS NULL
            OR CASE ${dimension}
              WHEN 'route' THEN dims ->> 'route_id'
              WHEN 'provider' THEN dims ->> 'provider'
              WHEN 'app' THEN dims ->> 'app_id'
              WHEN 'team' THEN dims ->> 'team_id'
              WHEN 'cost_center' THEN dims ->> 'cost_center_id'
              WHEN 'model' THEN COALESCE(
                dims ->> 'canonical_model_id',
                dims ->> 'model_id',
                dims ->> 'offering_id'
              )
              WHEN 'status' THEN dims ->> 'status'
              WHEN 'profile' THEN dims ->> 'profile_mode'
              ELSE NULL
            END = ${dimensionValue}
          )
          AND (
            ${cursor?.bucketStart ?? null}::timestamptz IS NULL
            OR (bucket_start, grain, dims_hash) < (
              ${cursor?.bucketStart ?? null}::timestamptz,
              ${cursor?.grain ?? null},
              ${cursor?.dimsHash ?? null}
            )
          )
        ORDER BY bucket_start DESC, grain DESC, dims_hash DESC
        LIMIT ${limit + 1}`,
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return contractOk(UsageContracts.response,
      {
        data: page.map((row) => ({
          grain: row.grain,
          bucket_start: row.bucket_start,
          dimension,
          dimension_value: row.dimension_value,
          dims: safeDims(row.dims),
          requests: String(row.requests),
          input_tokens: String(row.input_tokens),
          output_tokens: String(row.output_tokens),
          cache_read_tokens: String(row.cache_read_tokens),
          reasoning_tokens: String(row.reasoning_tokens),
          cost_microusd: String(row.cost_microusd),
          errors: String(row.errors),
          failovers: String(row.failovers),
          latency_ms_sum: String(row.latency_ms_sum),
          latency_ms_p95: row.latency_ms_p95,
          updated_at: row.updated_at,
        })),
        next_cursor:
          rows.length > limit && last
            ? encodeCursor({
                bucketStart: last.bucket_start,
                grain: last.grain,
                dimsHash: last.dims_hash,
              })
            : null,
        compaction_boundary_note: crossesBoundary
          ? {
              requested_grain: grain,
              fallback_grain: fallbackGrain,
              boundary,
              message: `${grain} detail before ${boundary} is shown at ${fallbackGrain} grain after compaction.`,
            }
          : null,
      },
      requestId,
    );
  });
}
