import { randomUUID } from "node:crypto";
import {
  LocalCircuitBreaker,
  LocalConcurrencyLimiter,
  type GatewayContext,
} from "@manifold/gateway-core";
import { getClient } from "@manifold/database";
import type { IngestSink } from "@manifold/ports";
import { PostgresDistributedAdmission } from "./admission.js";
import { DurableIngestSink } from "./durableIngest.js";
import { JobLedgerService } from "./jobLedger.js";
import { ingestTrace } from "./observe.js";
import { RemoteSnapshotStore } from "./remoteSnapshot.js";
import { buildContext, parseDataKeks, parseKeyPeppers } from "./server.js";
import { parseSnapshotPublicKeys } from "./snapshotVerify.js";
import { VercelRateLimitRegistry } from "./vercelRateLimit.js";
import { getVercelTelemetry } from "./vercelTelemetry.js";

type WaitUntilRegistrar = (work: Promise<unknown>) => void;

interface VercelRuntimeState {
  installationId: string;
  workspaceId: string;
  snapshots: RemoteSnapshotStore;
  ledger: JobLedgerService;
  baseContext: GatewayContext;
  concurrency: LocalConcurrencyLimiter;
  circuitBreaker: LocalCircuitBreaker;
  admission: PostgresDistributedAdmission;
  maxRequestBytes: number;
  /** Probes durable request-admission dependencies for every readiness check. */
  checkReady(): Promise<void>;
}

const discardIngest: IngestSink = { async emit() {} };
let runtimeState: Promise<VercelRuntimeState> | undefined;
const rateLimits = new VercelRateLimitRegistry();
let lastHeartbeatAt = 0;
const HEARTBEAT_INTERVAL_MS = 60_000;

export interface RequestDrainFailureOperationalSignal {
  type: "manifold.gateway.request_drain.failed.v1";
  workspaceId: string;
  installationId: string;
  workerId: string;
}

/** Log only correlation identifiers: rejected drains may carry provider or database failure details. */
export function requestDrainFailureOperationalSignal(
  workspaceId: string,
  installationId: string,
  workerId: string,
): RequestDrainFailureOperationalSignal {
  return {
    type: "manifold.gateway.request_drain.failed.v1",
    workspaceId,
    installationId,
    workerId,
  };
}

function reportRequestDrainFailure(
  workspaceId: string,
  installationId: string,
  workerId: string,
): void {
  console.error(JSON.stringify(requestDrainFailureOperationalSignal(workspaceId, installationId, workerId)));
}

/** Ensure serverless background rejections become observable without retaining their unsafe cause. */
export function observeRequestDrain(
  work: Promise<unknown>,
  workspaceId: string,
  installationId: string,
  workerId: string,
  reportDiagnostic = reportRequestDrainFailure,
): Promise<void> {
  return work.then(
    () => undefined,
    () => reportDiagnostic(workspaceId, installationId, workerId),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`required gateway environment variable is missing: ${name}`);
  return value;
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function initializeRuntime(): Promise<VercelRuntimeState> {
  const installationId = requiredEnv("MANIFOLD_INSTALLATION_ID");
  const workspaceId = requiredEnv("MANIFOLD_WORKSPACE_ID");
  const databaseUrl =
    process.env.MANIFOLD_BUDGET_DB_URL?.trim() || requiredEnv("DATABASE_URL");
  const rawPublicKeys = process.env.MANIFOLD_SNAPSHOT_PUBLIC_KEYS;
  // An explicitly supplied blank/whitespace value is malformed; only an unset variable selects
  // the legacy pin. This prevents an accidental rotation config from silently weakening trust.
  const publicKeys = rawPublicKeys === undefined ? undefined : parseSnapshotPublicKeys(rawPublicKeys);
  const publicKeyBase64 = publicKeys ? undefined : requiredEnv("MANIFOLD_SNAPSHOT_PUBLIC_KEY");
  const rawPeppers = process.env.MANIFOLD_KEY_PEPPERS;
  const peppers = rawPeppers === undefined ? undefined : parseKeyPeppers(rawPeppers);
  const rawKeks = process.env.MANIFOLD_DATA_KEKS;
  const keks = rawKeks === undefined ? undefined : parseDataKeks(rawKeks);
  const maxRequestBytes =
    optionalPositiveIntegerEnv("MANIFOLD_MAX_REQUEST_BYTES") ?? 4_000_000;
  if (requiredEnv("MANIFOLD_ADMISSION_MODE") !== "postgres_strict") {
    throw new Error("MANIFOLD_ADMISSION_MODE must be postgres_strict for the Vercel gateway");
  }
  const perKeyConcurrency =
    optionalPositiveIntegerEnv("MANIFOLD_MAX_KEY_CONCURRENCY") ?? 16;
  const installationConcurrency =
    optionalPositiveIntegerEnv("MANIFOLD_MAX_CONCURRENCY") ?? 128;
  const concurrency = new LocalConcurrencyLimiter({
    perKeyCap: perKeyConcurrency,
    globalCap: installationConcurrency,
    maxEntries: optionalPositiveIntegerEnv("MANIFOLD_CONCURRENCY_MAX_KEYS") ?? 10_000,
  });
  const circuitBreaker = new LocalCircuitBreaker({
    failureThreshold: optionalPositiveIntegerEnv("MANIFOLD_CIRCUIT_FAILURE_THRESHOLD") ?? 5,
    rollingWindowMs: optionalPositiveIntegerEnv("MANIFOLD_CIRCUIT_WINDOW_MS") ?? 60_000,
    resetTimeoutMs: optionalPositiveIntegerEnv("MANIFOLD_CIRCUIT_RESET_MS") ?? 30_000,
    maxEntries: optionalPositiveIntegerEnv("MANIFOLD_CIRCUIT_MAX_TARGETS") ?? 10_000,
  });
  const snapshots = new RemoteSnapshotStore({
    controlPlaneBaseUrl: requiredEnv("MANIFOLD_CONTROL_PLANE_URL"),
    installationPrivateKeyBase64: requiredEnv("MANIFOLD_INSTALLATION_PRIVATE_KEY"),
    publicKeyBase64,
    publicKeys,
    acceleratorUrl: process.env.MANIFOLD_SNAPSHOT_ACCELERATOR_URL?.trim() || undefined,
    acceleratorBearerToken:
      process.env.MANIFOLD_SNAPSHOT_ACCELERATOR_TOKEN?.trim() || undefined,
    freshnessTtlMs: optionalPositiveIntegerEnv("MANIFOLD_SNAPSHOT_FRESH_MS"),
    maxStaleMs: optionalPositiveIntegerEnv("MANIFOLD_SNAPSHOT_MAX_STALE_MS"),
    timeoutMs: optionalPositiveIntegerEnv("MANIFOLD_SNAPSHOT_TIMEOUT_MS"),
    maxResponseBytes: optionalPositiveIntegerEnv("MANIFOLD_SNAPSHOT_MAX_BYTES"),
  });
  const sql = getClient(databaseUrl);
  const admission = new PostgresDistributedAdmission({
    sql,
    workspaceId,
    perKeyConcurrency,
    installationConcurrency,
    leaseTtlMs: optionalPositiveIntegerEnv("MANIFOLD_ADMISSION_LEASE_TTL_MS"),
  });
  const ledger = new JobLedgerService({
    sql,
    observationIngestHandler: async (payload) => {
      await ingestTrace({
        sql,
        events: payload.events,
        workspaceId: payload.workspaceId,
        producerId: payload.producerId,
      });
    },
  });
  await Promise.all([
    admission.checkReady(installationId),
    ledger.checkReady(workspaceId),
  ]);
  const snapshot = await snapshots.loadActive(installationId);
  await snapshots.reportHeartbeat(installationId, snapshot.meta.revision);
  lastHeartbeatAt = Date.now();
  const baseContext = await buildContext({
    snapshot,
    snapshotPublicKey: publicKeyBase64,
    peppers,
    keks,
    installationId,
    workspaceId,
    budgetDbUrl: databaseUrl,
    ingest: discardIngest,
  });
  baseContext.telemetry = getVercelTelemetry();
  return {
    installationId,
    workspaceId,
    snapshots,
    ledger,
    baseContext,
    concurrency,
    circuitBreaker,
    admission,
    maxRequestBytes,
    checkReady: async () => {
      // The strict admission probe exercises the live Postgres connection,
      // required RLS context, and admission tables. It is intentionally not
      // memoized: a warm instance must turn unready when Postgres disappears.
      await Promise.all([
        admission.checkReady(installationId),
        ledger.checkReady(workspaceId),
      ]);
    },
  };
}

export async function getVercelRuntime(): Promise<VercelRuntimeState> {
  if (!runtimeState) {
    runtimeState = initializeRuntime().catch((error: unknown) => {
      runtimeState = undefined;
      throw error;
    });
  }
  return runtimeState;
}

/**
 * Produce one request-scoped context. Static crypto/DB adapters are reused by the Fluid instance;
 * the snapshot is freshness-checked and the ingest collector is isolated to this request.
 */
export async function getVercelGatewayContext(
  waitUntil?: WaitUntilRegistrar,
): Promise<GatewayContext> {
  const state = await getVercelRuntime();
  const snapshot = await state.snapshots.loadActive(state.installationId);
  if (Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = Date.now();
    const heartbeat = state.snapshots
      .reportHeartbeat(state.installationId, snapshot.meta.revision)
      .catch(() => {
        // Readiness remains stale and truthful. Request dispatch should continue from a verified
        // snapshot when only the diagnostic heartbeat path is temporarily unavailable.
      });
    if (waitUntil) waitUntil(heartbeat);
    else await heartbeat;
  }
  const workerId = `gateway:${process.env.VERCEL_REGION ?? "local"}:${randomUUID()}`;
  const ingest = new DurableIngestSink({
    workspaceId: state.workspaceId,
    producerId: state.installationId,
    ledger: state.ledger,
    schedule: waitUntil
      ? () => {
          waitUntil(
            observeRequestDrain(
              state.ledger.drain(state.workspaceId, workerId, 10),
              state.workspaceId,
              state.installationId,
              workerId,
            ),
          );
        }
      : undefined,
  });
  return {
    ...state.baseContext,
    snapshot,
    ingest,
    rateLimit: (input) => rateLimits.consume(input),
    maxRequestBytes: state.maxRequestBytes,
    acquireConcurrency: (input) => state.concurrency.acquire(input),
    distributedAdmission: state.admission.admission,
    circuitBreaker: state.circuitBreaker,
  };
}
