// Installation-authenticated observation journal ingestion (SPEC §10.3 / §8.3).
import { createHash } from "node:crypto";
import { journalFromPortsEvent, project, reduce, type JournalObservationEvent } from "@manifold/observability";
import type { HotPathObservationEvent } from "@manifold/ports";
import { recordProviderAttemptHealthFacts } from "@manifold/database";
import { OBSERVATION_REDUCER_PROJECTION } from "@manifold/storage";
import { withWorkspace, type Sql } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

const MAX_BATCH_EVENTS = 100;
const HIGH_PRESSURE_REDACTED_CAPTURE_MAX_BYTES = 1_024;
const IDENTITY_FIELDS = new Set(["workspaceId", "workspace_id", "producerId", "producer_id", "installationId", "installation_id"]);
type InputEvent = HotPathObservationEvent & Record<string, unknown>;
type CaptureEnvelope = { mode: "redacted" | "full"; request?: Record<string, unknown>; response?: Record<string, unknown>; truncated?: boolean; bytes: number };
type IngestHotPathEvent = HotPathObservationEvent & { capture?: CaptureEnvelope };
type JournalRow = { id: string; trace_id: string; kind: string; seq: number; producer_id: string; idempotency_key: string; payload: unknown; occurred_at: string; profile_mode: string };
type PressureRow = {
  tier: "normal" | "warning" | "high" | "critical" | "emergency";
  capture_mode: "none" | "metadata" | "redacted" | "full";
  payload_sample_rate: string | number;
  journal_mode: "full" | "aggregate_only";
};
type PressurePolicy = PressureRow;

function fail(message: string, reason = "OBSERVATION_INGEST_INVALID", details?: Record<string, unknown>): never {
  throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [reason], details });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectCallerIdentity(value: Record<string, unknown>): void {
  for (const key of IDENTITY_FIELDS) if (key in value) fail("caller-supplied tenant or producer identity is forbidden", "OBSERVATION_INGEST_CALLER_IDENTITY_FORBIDDEN");
}

function requireString(value: Record<string, unknown>, field: string, index: number): string {
  const result = value[field];
  if (typeof result !== "string" || !result) fail(`events[${index}].${field} must be a non-empty string`);
  return result;
}

function optionalStringOrNull(value: Record<string, unknown>, field: string, index: number): string | null | undefined {
  const result = value[field];
  if (result === undefined || result === null || typeof result === "string") return result;
  fail(`events[${index}].${field} must be a string or null`);
}

function optionalCapture(value: Record<string, unknown>, index: number): CaptureEnvelope | undefined {
  if (value.capture === undefined) return undefined;
  if (!isObject(value.capture)) fail(`events[${index}].capture must be an object`);
  if (value.capture.mode !== "redacted" && value.capture.mode !== "full") fail(`events[${index}].capture.mode is invalid`);
  if (!Number.isSafeInteger(value.capture.bytes) || (value.capture.bytes as number) < 0 || (value.capture.bytes as number) > 4_096) {
    fail(`events[${index}].capture.bytes must be a bounded non-negative integer`);
  }
  for (const field of ["request", "response"] as const) {
    if (value.capture[field] !== undefined && !isObject(value.capture[field])) fail(`events[${index}].capture.${field} must be an object`);
  }
  if (value.capture.truncated !== undefined && typeof value.capture.truncated !== "boolean") fail(`events[${index}].capture.truncated must be boolean`);
  return value.capture as CaptureEnvelope;
}

function parseEvent(value: unknown, index: number): IngestHotPathEvent {
  if (!isObject(value)) fail(`events[${index}] must be an object`);
  rejectCallerIdentity(value);
  const kind = requireString(value, "kind", index);
  if (kind !== "accepted" && kind !== "provider_attempt" && kind !== "terminal") fail(`events[${index}].kind is invalid`);
  const seq = value.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) fail(`events[${index}].seq must be a non-negative integer`);
  const occurredAt = requireString(value, "occurredAt", index);
  if (!Number.isFinite(Date.parse(occurredAt))) fail(`events[${index}].occurredAt must be an ISO timestamp`);
  const reasonCodes = value.reasonCodes;
  if (!Array.isArray(reasonCodes) || reasonCodes.some((code) => typeof code !== "string")) fail(`events[${index}].reasonCodes must be a string array`);
  const status = value.status;
  if (status !== null && (!Number.isSafeInteger(status) || (status as number) < 0 || (status as number) > 999)) fail(`events[${index}].status must be an HTTP status or null`);
  for (const field of ["keyId", "routeId", "offeringId", "priceRevisionId", "budgetAccountId", "reservationId"] as const) optionalStringOrNull(value, field, index);
  const usage = value.usage;
  if (usage !== undefined && (!isObject(usage) || Object.values(usage).some((count) => typeof count !== "number" || !Number.isFinite(count) || count < 0))) fail(`events[${index}].usage must contain non-negative numbers`);
  const price = value.price;
  if (price !== undefined && !isObject(price)) fail(`events[${index}].price must be an object`);
  const capture = optionalCapture(value, index);
  if (kind === "provider_attempt") {
    for (const field of ["targetId", "routeRevisionId", "snapshotRevision"] as const) requireString(value, field, index);
    if (
      value.attemptOutcome !== "success"
      && value.attemptOutcome !== "transient_failure"
      && value.attemptOutcome !== "permanent_failure"
    ) fail(`events[${index}].attemptOutcome is invalid`);
  }
  return {
    traceId: requireString(value, "traceId", index), kind, seq: seq as number, occurredAt,
    profileId: requireString(value, "profileId", index), keyId: optionalStringOrNull(value, "keyId", index) ?? null,
    routeId: optionalStringOrNull(value, "routeId", index) ?? null, offeringId: optionalStringOrNull(value, "offeringId", index) ?? null,
    status: status as number | null, reasonCodes: reasonCodes as HotPathObservationEvent["reasonCodes"],
    ...(usage ? { usage: usage as HotPathObservationEvent["usage"] } : {}),
    ...(price ? { price: price as HotPathObservationEvent["price"] } : {}),
    ...(value.priceRevisionId !== undefined ? { priceRevisionId: optionalStringOrNull(value, "priceRevisionId", index) } : {}),
    ...(value.budgetAccountId !== undefined ? { budgetAccountId: optionalStringOrNull(value, "budgetAccountId", index) } : {}),
    ...(value.reservationId !== undefined ? { reservationId: optionalStringOrNull(value, "reservationId", index) } : {}),
    ...(capture ? { capture } : {}),
    ...(kind === "provider_attempt" ? {
      targetId: value.targetId as string,
      routeRevisionId: value.routeRevisionId as string,
      snapshotRevision: value.snapshotRevision as string,
      attemptOutcome: value.attemptOutcome as "success" | "transient_failure" | "permanent_failure",
    } : {}),
  };
}

export function parseBatch(body: Record<string, unknown>): IngestHotPathEvent[] {
  rejectCallerIdentity(body);
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) fail("events must be a non-empty array");
  if (events.length > MAX_BATCH_EVENTS) fail(`events must contain at most ${MAX_BATCH_EVENTS} events`, "OBSERVATION_INGEST_BATCH_TOO_LARGE");
  return events.map(parseEvent);
}

function stableId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256").update(values.join("\u0000")).digest("base64url")}`;
}

// Keep this boundary self-contained: control-plane test runners load workspace package artifacts
// directly, while the storage worker owns the equivalent exported helper. SHA-256 makes the
// decision stable across retries, processes, and all events for a trace.
function isTraceSampledIn(traceId: string, sampleRate: number): boolean {
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error("invalid persisted payload sample rate");
  if (sampleRate === 0) return false;
  if (sampleRate === 1) return true;
  const bucket = createHash("sha256").update(traceId).digest().readUIntBE(0, 6) / 2 ** 48;
  return bucket < sampleRate;
}
type JsonSafeValue = null | string | number | boolean | JsonSafeValue[] | { [key: string]: JsonSafeValue };

/** Convert journal payloads to the exact JSON value domain accepted by postgres-js. */
function jsonSafe(value: unknown): JsonSafeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  return null;
}
function bigintFields(value: unknown): Record<string, bigint> | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, typeof child === "string" ? BigInt(child) : child])) as Record<string, bigint>;
}
function journalFromRow(row: JournalRow, workspaceId: string): JournalObservationEvent {
  const base = { workspaceId, traceId: row.trace_id, producerId: row.producer_id, idempotencyKey: row.idempotency_key, seq: Number(row.seq), occurredAt: new Date(row.occurred_at).toISOString() };
  const payload = isObject(row.payload) ? row.payload : {};
  if (row.kind === "accepted") return { ...base, kind: "accepted", payload };
  if (row.kind === "provider_attempt") return {
    ...base,
    kind: "provider_attempt",
    payload: {
      ...payload,
      provider: typeof payload.provider === "string" ? payload.provider : "",
      ...(typeof payload.targetId === "string" ? { targetId: payload.targetId } : {}),
      ...(typeof payload.routeRevisionId === "string" ? { routeRevisionId: payload.routeRevisionId } : {}),
      ...(typeof payload.snapshotRevision === "string" ? { snapshotRevision: payload.snapshotRevision } : {}),
      outcome: payload.outcome === "success" || payload.outcome === "transient_failure" || payload.outcome === "permanent_failure" || payload.outcome === "ok" || payload.outcome === "error" || payload.outcome === "timeout" ? payload.outcome : "error",
    },
  };
  if (row.kind === "terminal") return { ...base, kind: "terminal", payload: { ...payload, status: payload.status === "ok" || payload.status === "denied" || payload.status === "clamped" || payload.status === "timeout" ? payload.status : "error", ...(payload.tokens ? { tokens: bigintFields(payload.tokens) } : {}), ...(payload.price ? { price: bigintFields(payload.price) } : {}) } };
  return { ...base, kind: "annotation", payload };
}

/** The sole persisted capture-ref shape consumed by the Logs detail reader. */
function captureRef(value: unknown): Record<string, unknown> | null {
  if (!isObject(value) || (value.mode !== "redacted" && value.mode !== "full")) return null;
  const truncated = value.truncated === true;
  const request = isObject(value.request) ? value.request : undefined;
  const response = isObject(value.response) ? value.response : undefined;
  const bytes = truncated ? 0 : Buffer.byteLength(JSON.stringify({ ...(request ? { request } : {}), ...(response ? { response } : {}) }), "utf8");
  return {
    redacted: value.mode === "redacted",
    truncated,
    bytes,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
  };
}

async function projectTrace(sql: Sql, workspaceId: string, installationId: string, traceId: string): Promise<boolean> {
  const rows = await sql<JournalRow[]>`SELECT id, trace_id, kind, seq, producer_id, idempotency_key, payload, occurred_at, profile_mode FROM observation_event WHERE workspace_id = ${workspaceId} AND trace_id = ${traceId} ORDER BY seq, occurred_at, id`;
  return projectJournal(sql, workspaceId, installationId, rows.map((row) => journalFromRow(row, workspaceId)), rows[0]?.profile_mode ?? "public_app");
}

/**
 * Project from supplied journal events as well as persisted rows. Emergency mode deliberately
 * takes this path: it records usage/cost truth without appending raw `observation_event` detail.
 */
async function projectJournal(sql: Sql, workspaceId: string, installationId: string, journal: JournalObservationEvent[], profileMode: string): Promise<boolean> {
  const reduced = reduce(journal);
  if (!reduced.complete) return false;
  const projected = project(reduced);
  const terminal = journal.find((event) => event.kind === "terminal");
  if (!terminal) return false;
  const createdAt = new Date(terminal.occurredAt).toISOString();
  const observationId = stableId("obs", [workspaceId, reduced.traceId]);
  const t = projected.usage.tokens;
  const terminalPayload: Record<string, unknown> = terminal.payload;
  const storedCaptureRef = captureRef(terminalPayload.capture);
  await sql`
    INSERT INTO observation (id, workspace_id, trace_id, installation_id, profile_mode, route_id, route_revision_id, final_provider, final_offering_id, price_revision_id, app_id, team_id, cost_center_id, virtual_key_id, status, http_status, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, cost_microusd, cost_fidelity, attempts, failovers, reason_codes, capture_ref, occurred_at, created_at)
    VALUES (${observationId}, ${workspaceId}, ${reduced.traceId}, ${installationId}, ${profileMode}, ${reduced.routeId}, ${reduced.routeRevisionId}, ${reduced.finalProvider}, ${reduced.finalOfferingId}, ${reduced.priceRevisionId}, ${reduced.appId}, ${reduced.teamId}, ${reduced.costCenterId}, ${reduced.virtualKeyId}, ${reduced.status}, ${reduced.httpStatus}, ${t.inputTokens.toString()}, ${t.outputTokens.toString()}, ${t.cacheReadTokens.toString()}, ${t.reasoningTokens.toString()}, ${t.cacheWriteTokens.toString()}, ${t.audioInputTokens.toString()}, ${t.audioOutputTokens.toString()}, ${projected.cost.amountMicroUsd.toString()}, ${reduced.costFidelity}, ${reduced.attempts}, ${reduced.failovers}, ${sql.json(reduced.reasonCodes)}, ${storedCaptureRef === null ? null : sql.json(storedCaptureRef as Parameters<typeof sql.json>[0])}, ${reduced.occurredAt ?? createdAt}, ${createdAt})
    ON CONFLICT (workspace_id, trace_id, created_at) DO NOTHING`;
  await sql`
    INSERT INTO usage_record (id, workspace_id, observation_id, trace_id, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, cache_write_tokens, audio_input_tokens, audio_output_tokens, fidelity, occurred_at, created_at)
    VALUES (${stableId("ur", [workspaceId, reduced.traceId])}, ${workspaceId}, ${observationId}, ${reduced.traceId}, ${t.inputTokens.toString()}, ${t.outputTokens.toString()}, ${t.cacheReadTokens.toString()}, ${t.reasoningTokens.toString()}, ${t.cacheWriteTokens.toString()}, ${t.audioInputTokens.toString()}, ${t.audioOutputTokens.toString()}, ${projected.usage.fidelity}, ${projected.usage.occurredAt ?? createdAt}, ${createdAt})
    ON CONFLICT (workspace_id, observation_id, created_at) DO NOTHING`;
  await sql`
    INSERT INTO cost_ledger (id, workspace_id, observation_id, trace_id, budget_account_id, cost_center_id, team_id, app_id, virtual_key_id, amount_microusd, fidelity, price_revision_id, offering_id, occurred_at, created_at)
    VALUES (${stableId("cl", [workspaceId, reduced.traceId])}, ${workspaceId}, ${observationId}, ${reduced.traceId}, ${projected.cost.budgetAccountId}, ${projected.cost.costCenterId}, ${projected.cost.teamId}, ${projected.cost.appId}, ${projected.cost.virtualKeyId}, ${projected.cost.amountMicroUsd.toString()}, ${projected.cost.fidelity}, ${projected.cost.priceRevisionId}, ${projected.cost.offeringId}, ${projected.cost.occurredAt ?? createdAt}, ${createdAt})
    ON CONFLICT (workspace_id, observation_id, created_at) DO NOTHING`;
  return true;
}

async function storagePressurePolicy(sql: Sql, workspaceId: string): Promise<PressurePolicy> {
  const persisted = (await sql<PressureRow[]>`SELECT tier, capture_mode, payload_sample_rate, journal_mode FROM storage_pressure_state WHERE workspace_id = ${workspaceId} LIMIT 1`)[0];
  // A workspace without a first measurement retains the pre-pressure behavior. This fallback is
  // intentionally local to ingest and never causes a gateway/provider denial.
  return persisted ?? { tier: "normal", capture_mode: "full", payload_sample_rate: 1, journal_mode: "full" };
}

function pressureReason(event: JournalObservationEvent, reason: "STORAGE_SHED_SAMPLED" | "STORAGE_EMERGENCY_SHED"): JournalObservationEvent {
  const payload: Record<string, unknown> = isObject(event.payload) ? { ...event.payload } : {};
  const suppliedReasonCodes = payload["reasonCodes"];
  const reasonCodes = Array.isArray(suppliedReasonCodes)
    ? suppliedReasonCodes.filter((code): code is string => typeof code === "string")
    : [];
  return { ...event, payload: { ...payload, reasonCodes: [...new Set([...reasonCodes, reason])] } } as JournalObservationEvent;
}

const SENSITIVE_CAPTURE_KEY = /(?:authorization|api[_.-]?key|token|secret|password|credential|cookie|session|private[_.-]?key)/i;
const SENSITIVE_CAPTURE_VALUE = /(?:\b(?:bearer|basic)\s+\S+|\bsk-[a-z0-9_-]+|\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+)/i;

function redactedCaptureValue(value: unknown, depth = 0): JsonSafeValue {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const safe = SENSITIVE_CAPTURE_VALUE.test(value) ? "[REDACTED]" : value;
    return safe.slice(0, 256);
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactedCaptureValue(item, depth + 1));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 64)
      .map(([key, child]) => [key, SENSITIVE_CAPTURE_KEY.test(key) ? "[REDACTED]" : redactedCaptureValue(child, depth + 1)]));
  }
  return null;
}

export function redactAndBoundPressureCapture(value: unknown): JsonSafeValue {
  const candidate = redactedCaptureValue(value);
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= HIGH_PRESSURE_REDACTED_CAPTURE_MAX_BYTES) return candidate;
  // Never preserve an oversized partially-serialized document. A compact marker is truthful,
  // bounded, and cannot leak the content that exceeded the pressure cap.
  return { truncated: true, redacted: true };
}

/**
 * Trusted journal seam for an upstream capture producer. Public observation events never carry
 * `capture`; pressure must therefore never manufacture one from their reducer metadata.
 */
export function redactPressureJournalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(payload, "capture")) return payload;
  const redacted = redactAndBoundPressureCapture(payload.capture);
  if (!isObject(redacted) || redacted.truncated === true) {
    return { ...payload, capture: { mode: "redacted", truncated: true, bytes: 0 } };
  }
  const request = isObject(redacted.request) ? redacted.request : undefined;
  const response = isObject(redacted.response) ? redacted.response : undefined;
  const bytes = Buffer.byteLength(JSON.stringify({ ...(request ? { request } : {}), ...(response ? { response } : {}) }), "utf8");
  return { ...payload, capture: { mode: "redacted", ...(request ? { request } : {}), ...(response ? { response } : {}), truncated: false, bytes } };
}

function redactedPayload(event: JournalObservationEvent): JournalObservationEvent {
  const payload: Record<string, unknown> = isObject(event.payload) ? { ...event.payload } : {};
  const redacted = redactPressureJournalPayload(payload);
  return redacted === payload ? event : { ...event, payload: redacted } as JournalObservationEvent;
}

function applyPressureCapture(journal: JournalObservationEvent[], pressure: PressurePolicy): JournalObservationEvent[] {
  if (pressure.journal_mode === "aggregate_only") return [];
  const sampleRate = Number(pressure.payload_sample_rate);
  return journal.map((event) => {
    // Sampling is only a payload-detail decision. Every event remains journaled and projectable.
    const sampledIn = isTraceSampledIn(event.traceId, sampleRate);
    if (pressure.capture_mode === "full" && !sampledIn) return metadataOnly(pressureReason(event, "STORAGE_SHED_SAMPLED"));
    if (pressure.capture_mode === "redacted") {
      if (!sampledIn) return metadataOnly(pressureReason(event, "STORAGE_SHED_SAMPLED"));
      return redactedPayload(event);
    }
    if (pressure.capture_mode === "metadata" || pressure.capture_mode === "none") {
      return metadataOnly(pressureReason(event, "STORAGE_EMERGENCY_SHED"));
    }
    return event;
  });
}

function metadataOnly(event: JournalObservationEvent): JournalObservationEvent {
  // Mapper payloads are already metadata, but this whitelist is the capture seam: a later event
  // extension cannot accidentally persist request/response content while critical pressure is set.
  const keys = event.kind === "accepted"
    ? ["routeId", "virtualKeyId", "budgetAccountId", "reasonCodes"]
    : event.kind === "provider_attempt"
      ? ["provider", "targetId", "routeRevisionId", "snapshotRevision", "offeringId", "outcome", "httpStatus", "reasonCodes"]
      : event.kind === "terminal"
        ? ["status", "httpStatus", "tokens", "price", "costFidelity", "finalOfferingId", "priceRevisionId", "budgetAccountId", "virtualKeyId", "reasonCodes"]
        : [];
  const payload = Object.fromEntries(Object.entries(event.payload).filter(([key]) => keys.includes(key)));
  return { ...event, payload } as JournalObservationEvent;
}

export async function ingestBatch(input: { workspaceId: string; installationId: string; events: HotPathObservationEvent[] }): Promise<{ accepted: number; projected: number }> {
  return withWorkspace(input.workspaceId, async (sql) => {
    const journal = input.events.map((event) => journalFromPortsEvent(event, { workspaceId: input.workspaceId, producerId: input.installationId }));
    const pressure = await storagePressurePolicy(sql, input.workspaceId);
    const persistedJournal = applyPressureCapture(journal, pressure);
    for (const event of persistedJournal) {
      const source = input.events.find((candidate) => candidate.traceId === event.traceId && candidate.seq === event.seq)!;
      const createdAt = new Date(event.occurredAt).toISOString();
      await sql`
        INSERT INTO observation_event (id, workspace_id, trace_id, span_id, installation_id, profile_mode, route_id, virtual_key_id, kind, seq, producer_id, idempotency_key, payload, occurred_at, created_at)
        VALUES (${stableId("oe", [input.workspaceId, input.installationId, event.idempotencyKey])}, ${input.workspaceId}, ${event.traceId}, ${event.traceId}, ${input.installationId}, ${source.profileId}, ${source.routeId}, ${source.keyId}, ${event.kind}, ${event.seq}, ${input.installationId}, ${event.idempotencyKey}, ${sql.json(jsonSafe(event.payload) as Parameters<typeof sql.json>[0])}, ${event.occurredAt}, ${createdAt})
        ON CONFLICT (workspace_id, producer_id, idempotency_key, created_at) DO NOTHING`;
    }
    await recordProviderAttemptHealthFacts(sql, input.workspaceId, input.installationId,
      input.events.flatMap((event) => event.kind === "provider_attempt"
        && event.targetId && event.routeRevisionId && event.snapshotRevision && event.attemptOutcome
        ? [{
            sourceEventId: stableId("oe", [input.workspaceId, input.installationId, `${event.traceId}:${event.seq}`]),
            targetId: event.targetId,
            routeRevisionId: event.routeRevisionId,
            snapshotRevisionId: event.snapshotRevision,
            outcome: event.attemptOutcome,
            httpStatus: event.status,
            reasonCodes: event.reasonCodes,
            occurredAt: event.occurredAt,
          }]
        : []));
    const traceIds = [...new Set(journal.map((event) => event.traceId))].sort();
    let projected = 0;
    for (const traceId of traceIds) {
      const didProject = pressure.journal_mode === "aggregate_only"
        ? await projectJournal(sql, input.workspaceId, input.installationId, journal.filter((event) => event.traceId === traceId), input.events.find((event) => event.traceId === traceId)?.profileId ?? "public_app")
        : await projectTrace(sql, input.workspaceId, input.installationId, traceId);
      if (didProject) projected += 1;
    }
    const last = [...journal].sort((a, b) => a.seq - b.seq || a.occurredAt.localeCompare(b.occurredAt)).at(-1)!;
    await sql`INSERT INTO projection_checkpoint (workspace_id, projection, last_event_id, last_event_seq, last_processed_at, lag_seconds, updated_at) VALUES (${input.workspaceId}, ${OBSERVATION_REDUCER_PROJECTION}, ${stableId("oe", [input.workspaceId, input.installationId, last.idempotencyKey])}, ${last.seq}, now(), 0, now()) ON CONFLICT (workspace_id, projection) DO UPDATE SET last_event_id = EXCLUDED.last_event_id, last_event_seq = EXCLUDED.last_event_seq, last_processed_at = EXCLUDED.last_processed_at, lag_seconds = 0, updated_at = now()`;
    return { accepted: input.events.length, projected };
  });
}
