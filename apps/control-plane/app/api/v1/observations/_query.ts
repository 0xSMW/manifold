import { ManifoldError } from "@/lib/http";

const STATUS_VALUES = new Set(["ok", "error", "denied", "clamped", "timeout"]);
const RANGE_RE = /^(\d+)(m|h|d)$/;
const DEFAULT_RANGE = "24h";
const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1_000;

export interface ObservationFilters {
  from: string;
  to: string;
  range: string | null;
  profile: string | null;
  route: string | null;
  model: string | null;
  provider: string | null;
  status: string | null;
  app: string | null;
  action: string | null;
  key: string | null;
  costCenter: string | null;
  minLatencyMs: number | null;
  errorsOnly: boolean;
  trace: string | null;
}

export interface ObservationCursor {
  createdAt: string;
  id: string;
}

export interface ObservationListRow {
  id: string;
  trace_id: string;
  installation_id: string;
  profile_mode: string;
  route_id: string | null;
  public_name: string | null;
  endpoint_kind: string | null;
  final_provider: string | null;
  final_offering_id: string | null;
  canonical_model_id: string | null;
  canonical_model_slug: string | null;
  provider_model_id: string | null;
  app_id: string | null;
  app_slug: string | null;
  action_id: string | null;
  action_slug: string | null;
  team_id: string | null;
  cost_center_id: string | null;
  cost_center_slug: string | null;
  virtual_key_id: string | null;
  key_prefix: string | null;
  status: string;
  http_status: number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  audio_input_tokens: string | number | null;
  audio_output_tokens: string | number | null;
  cost_microusd: string | number | null;
  cost_fidelity: string | null;
  latency_ms: number | null;
  ttfb_ms: number | null;
  attempts: number;
  failovers: number;
  reason_codes: unknown;
  compacted: boolean;
  occurred_at: string;
  created_at: string;
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

function first(
  source: URLSearchParams | Record<string, unknown>,
  ...keys: string[]
): unknown {
  if (source instanceof URLSearchParams) {
    for (const key of keys) {
      const value = source.get(key);
      if (value !== null) return value;
    }
    return undefined;
  }
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function optionalString(
  source: URLSearchParams | Record<string, unknown>,
  path: string,
  ...aliases: string[]
): string | null {
  const value = first(source, path, ...aliases);
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") validation(path, `${path} must be a string`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 256) validation(path, `${path} must be at most 256 characters`);
  return normalized;
}

function parseTimestamp(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    validation(path, `${path} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function durationMs(value: string, path = "range"): number {
  const match = RANGE_RE.exec(value);
  if (!match) validation(path, `${path} must look like 30m, 24h, or 7d`);
  const amount = Number(match[1]);
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const result = amount * unitMs;
  if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_RANGE_MS) {
    validation(path, `${path} must be greater than zero and no more than 400d`);
  }
  return result;
}

function booleanValue(value: unknown, path: string): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === "false") {
    return false;
  }
  if (value === true || value === "true" || value === "1") return true;
  validation(path, `${path} must be true or false`);
}

function nonNegativeInteger(value: unknown, path: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    validation(path, `${path} must be a non-negative integer`);
  }
  return parsed;
}

export function parseObservationFilters(
  source: URLSearchParams | Record<string, unknown>,
  now = new Date(),
): ObservationFilters {
  const explicitFrom = parseTimestamp(first(source, "from", "start"), "from");
  const explicitTo = parseTimestamp(first(source, "to", "end"), "to");
  const rangeValue = optionalString(source, "range") ?? DEFAULT_RANGE;
  const to = explicitTo ?? now.toISOString();
  const from =
    explicitFrom ?? new Date(new Date(to).getTime() - durationMs(rangeValue)).toISOString();
  if (Date.parse(from) >= Date.parse(to)) validation("from", "from must be earlier than to");
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_MS) {
    validation("range", "the requested time range must be no more than 400 days");
  }

  const status = optionalString(source, "status");
  if (status && !STATUS_VALUES.has(status)) {
    validation("status", "status must be one of ok, error, denied, clamped, or timeout");
  }

  return {
    from,
    to,
    range: explicitFrom ? null : rangeValue,
    profile: optionalString(source, "profile", "profile_mode", "profileMode"),
    route: optionalString(source, "route", "route_id", "routeId"),
    model: optionalString(source, "model", "model_id", "modelId"),
    provider: optionalString(source, "provider"),
    status,
    app: optionalString(source, "app", "app_id", "appId"),
    action: optionalString(source, "action", "action_id", "actionId"),
    key: optionalString(source, "key", "key_id", "keyId"),
    costCenter: optionalString(
      source,
      "cost_center",
      "costCenter",
      "cost_center_id",
      "costCenterId",
    ),
    minLatencyMs: nonNegativeInteger(
      first(source, "min_latency_ms", "minLatencyMs", "min_latency"),
      "min_latency_ms",
    ),
    errorsOnly: booleanValue(first(source, "errors_only", "errorsOnly", "errors"), "errors_only"),
    trace: optionalString(source, "trace", "q", "trace_id", "traceId"),
  };
}

export function parseLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null || raw === "") return 50;
  if (!/^\d+$/.test(raw)) validation("limit", "limit must be an integer between 1 and 200");
  const limit = Number(raw);
  if (limit < 1 || limit > 200) validation("limit", "limit must be an integer between 1 and 200");
  return limit;
}

export function encodeCursor(cursor: ObservationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | null): ObservationCursor | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof (decoded as ObservationCursor).id !== "string" ||
      !(decoded as ObservationCursor).id ||
      typeof (decoded as ObservationCursor).createdAt !== "string" ||
      !Number.isFinite(Date.parse((decoded as ObservationCursor).createdAt))
    ) {
      validation("cursor", "cursor is invalid");
    }
    return {
      id: (decoded as ObservationCursor).id,
      createdAt: new Date((decoded as ObservationCursor).createdAt).toISOString(),
    };
  } catch (error) {
    if (error instanceof ManifoldError) throw error;
    validation("cursor", "cursor is invalid");
  }
}

function integerString(value: string | number | null): string | null {
  return value === null ? null : String(value);
}

/** PostgreSQL timestamp text is not necessarily accepted by the public ISO contract. */
function isoTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

export function serializeObservation(row: ObservationListRow): Record<string, unknown> {
  return {
    id: row.id,
    trace_id: row.trace_id,
    installation_id: row.installation_id,
    profile_mode: row.profile_mode,
    route: {
      id: row.route_id,
      public_name: row.public_name,
      endpoint_kind: row.endpoint_kind,
    },
    model: {
      offering_id: row.final_offering_id,
      canonical_model_id: row.canonical_model_id,
      canonical_slug: row.canonical_model_slug,
      provider_model_id: row.provider_model_id,
    },
    provider: row.final_provider,
    app: { id: row.app_id, slug: row.app_slug },
    action: { id: row.action_id, slug: row.action_slug },
    team_id: row.team_id,
    cost_center: { id: row.cost_center_id, slug: row.cost_center_slug },
    key: { id: row.virtual_key_id, display_prefix: row.key_prefix },
    status: row.status,
    http_status: row.http_status,
    usage: {
      input_tokens: integerString(row.input_tokens),
      output_tokens: integerString(row.output_tokens),
      cache_read_tokens: integerString(row.cache_read_tokens),
      reasoning_tokens: integerString(row.reasoning_tokens),
      cache_write_tokens: integerString(row.cache_write_tokens),
      audio_input_tokens: integerString(row.audio_input_tokens),
      audio_output_tokens: integerString(row.audio_output_tokens),
    },
    cost: {
      amount_microusd: integerString(row.cost_microusd),
      fidelity: row.cost_fidelity ?? "unknown",
    },
    latency_ms: row.latency_ms,
    ttfb_ms: row.ttfb_ms,
    attempts: row.attempts,
    failovers: row.failovers,
    reason_codes: Array.isArray(row.reason_codes) ? row.reason_codes : [],
    compacted: row.compacted,
    occurred_at: isoTimestamp(row.occurred_at),
    created_at: isoTimestamp(row.created_at),
  };
}

export function normalizedFilterAuditDetail(filters: ObservationFilters): Record<string, unknown> {
  return {
    from: filters.from,
    to: filters.to,
    profile: filters.profile,
    route: filters.route,
    model: filters.model,
    provider: filters.provider,
    status: filters.status,
    app: filters.app,
    action: filters.action,
    key: filters.key,
    cost_center: filters.costCenter,
    min_latency_ms: filters.minLatencyMs,
    errors_only: filters.errorsOnly,
    trace: filters.trace,
  };
}
