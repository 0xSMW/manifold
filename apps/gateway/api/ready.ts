import { getVercelRuntime } from "../src/vercelRuntime.js";

interface ActiveSnapshot {
  meta: {
    revision: string;
    installationId: string;
  };
}

interface VercelRuntimeForReadiness {
  installationId: string;
  checkReady(): Promise<void>;
  snapshots: {
    checkReady(installationId: string): Promise<{
      snapshot: ActiveSnapshot;
      verifiedAtMs: number;
    }>;
  };
}

export interface ReadinessDependencies {
  getRuntime?: () => Promise<VercelRuntimeForReadiness>;
  now?: () => number;
  provenance?: () => DeploymentProvenance | null;
}

interface DeploymentProvenance {
  deploymentId: string;
  sourceRevision: string;
}

const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOURCE_REVISION = /^[0-9a-f]{7,64}$/i;

/**
 * Vercel injects these values for the running immutable deployment. They are
 * deliberately read only at the serving boundary: request headers and caller
 * input cannot influence release provenance.
 */
export function vercelDeploymentProvenance(env: NodeJS.ProcessEnv = process.env): DeploymentProvenance | null {
  const deploymentId = env.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
  const sourceRevision = env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (!DEPLOYMENT_ID.test(deploymentId) || !SOURCE_REVISION.test(sourceRevision)) return null;
  return { deploymentId, sourceRevision: sourceRevision.toLowerCase() };
}

function readyResponse(body: Record<string, unknown>, status: number, provenance: DeploymentProvenance | null = null): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(provenance ? {
        "x-manifold-deployment-id": provenance.deploymentId,
        "x-manifold-source-revision": provenance.sourceRevision,
      } : {}),
    },
  });
}

function checkedSnapshotMetadata(
  snapshot: ActiveSnapshot,
  installationId: string,
  verifiedAtMs: number,
  nowMs: number,
): { revision: string; verifiedAt: string; ageMs: number } {
  const { revision } = snapshot.meta;
  if (
    snapshot.meta.installationId !== installationId ||
    typeof revision !== "string" ||
    revision.trim().length === 0 ||
    revision.length > 256 ||
    !Number.isSafeInteger(verifiedAtMs) ||
    verifiedAtMs < 0 ||
    verifiedAtMs > nowMs
  ) {
    throw new Error("snapshot metadata is invalid");
  }
  return {
    revision,
    verifiedAt: new Date(verifiedAtMs).toISOString(),
    ageMs: nowMs - verifiedAtMs,
  };
}

/**
 * Dependency-aware readiness. The default factory is intentionally thin so
 * tests can exercise every failure mode without importing or mutating runtime
 * module state.
 */
export function createReadinessHandler(
  dependencies: ReadinessDependencies = {},
): (request: Request) => Promise<Response> {
  const runtimeProvider = dependencies.getRuntime ?? getVercelRuntime;
  const now = dependencies.now ?? Date.now;
  const provenance = dependencies.provenance ?? vercelDeploymentProvenance;

  return async (_request: Request): Promise<Response> => {
    try {
      const runtime = await runtimeProvider();
      const [checkedSnapshot] = await Promise.all([
        runtime.snapshots.checkReady(runtime.installationId),
        runtime.checkReady(),
      ]);
      const snapshotMetadata = checkedSnapshotMetadata(
        checkedSnapshot.snapshot,
        runtime.installationId,
        checkedSnapshot.verifiedAtMs,
        now(),
      );
      return readyResponse({ ok: true, snapshot: snapshotMetadata }, 200, provenance());
    } catch {
      // Do not expose config, database, or control-plane failure details from a public route.
      return readyResponse({ ok: false, error: "unavailable" }, 503);
    }
  };
}

export const GET = createReadinessHandler();
