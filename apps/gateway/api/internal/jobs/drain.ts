import { timingSafeEqual } from "node:crypto";
import type { JobLedgerDrainSummary } from "../../../src/jobLedger.js";
import { getVercelRuntime } from "../../../src/vercelRuntime.js";

const CACHE_CONTROL = "no-store";
const MAX_DRAIN_BATCH_SIZE = 100;

export interface CronDrainRuntime {
  workspaceId: string;
  ledger: {
    drain(
      workspaceId: string,
      workerId: string,
      batchSize: number,
    ): Promise<JobLedgerDrainSummary>;
  };
}

export interface CronDrainDependencies {
  getRuntime?: () => Promise<CronDrainRuntime>;
  getSecret?: () => string | undefined;
  workerId?: () => string;
  reportDiagnostic?: (signal: CronDrainOperationalSignal) => void;
}

/** Secret-safe lifecycle signals for the durable Cron worker. */
export type CronDrainOperationalSignal =
  | {
      type: "manifold.gateway.job_drain.completed.v1";
      workspaceId: string;
      workerId: string;
      claimed: number;
      completed: number;
      retried: number;
      dead: number;
    }
  | {
      type: "manifold.gateway.job_drain.failed.v1";
      stage: "runtime" | "drain";
      workspaceId?: string;
      workerId?: string;
    };

function reportCronDrainDiagnostic(signal: CronDrainOperationalSignal): void {
  console.error(JSON.stringify(signal));
}

function json(body: unknown, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", CACHE_CONTROL);
  return Response.json(body, { ...init, headers });
}

/** Require a configured, exact Bearer credential. Vercel Cron supplies this Authorization shape. */
export function isAuthorizedCronRequest(request: Request, configuredSecret: string | undefined): boolean {
  // Whitespace around a configured secret is an operator error; do not silently alter credentials.
  if (!configuredSecret || configuredSecret.trim() !== configuredSecret) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(configuredSecret, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function createCronDrainHandler(dependencies: CronDrainDependencies = {}) {
  const getRuntime = dependencies.getRuntime ?? getVercelRuntime;
  const getSecret = dependencies.getSecret ?? (() => process.env.CRON_SECRET);
  const workerId =
    dependencies.workerId ??
    (() => `cron:${process.env.VERCEL_DEPLOYMENT_ID ?? "local"}:${Date.now()}`);
  const reportDiagnostic = dependencies.reportDiagnostic ?? reportCronDrainDiagnostic;

  return async function drainJobs(request: Request): Promise<Response> {
    if (!isAuthorizedCronRequest(request, getSecret())) {
      return json({ error: "unauthorized" }, { status: 401 });
    }
    let runtime: CronDrainRuntime;
    try {
      runtime = await getRuntime();
    } catch {
      reportDiagnostic({ type: "manifold.gateway.job_drain.failed.v1", stage: "runtime" });
      return json({ ok: false, error: "job drain failed" }, { status: 500 });
    }
    const currentWorkerId = workerId();
    try {
      const summary = await runtime.ledger.drain(runtime.workspaceId, currentWorkerId, MAX_DRAIN_BATCH_SIZE);
      reportDiagnostic({
        type: "manifold.gateway.job_drain.completed.v1",
        workspaceId: runtime.workspaceId,
        workerId: currentWorkerId,
        ...summary,
      });
      return json({ ok: true, ...summary }, { status: 200 });
    } catch {
      // Deliberately do not expose configuration, database, or job payload details.
      reportDiagnostic({
        type: "manifold.gateway.job_drain.failed.v1",
        stage: "drain",
        workspaceId: runtime.workspaceId,
        workerId: currentWorkerId,
      });
      return json({ ok: false, error: "job drain failed" }, { status: 500 });
    }
  };
}

export const GET = createCronDrainHandler();
