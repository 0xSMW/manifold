import { getVercelRuntime } from "../src/vercelRuntime.js";

interface ActiveSnapshot {
  meta: {
    revision: string;
    builtAt: string;
    installationId: string;
  };
}

interface VercelRuntimeForReadiness {
  installationId: string;
  snapshots: {
    loadActive(installationId: string): Promise<ActiveSnapshot>;
  };
}

export interface ReadinessDependencies {
  getRuntime?: () => Promise<VercelRuntimeForReadiness>;
  now?: () => number;
  /** Maximum age accepted for the signed snapshot's published metadata. */
  maxSnapshotAgeMs?: number;
}

const DEFAULT_MAX_SNAPSHOT_AGE_MS = 60_000;

function configuredMaxSnapshotAgeMs(): number {
  const raw = process.env.MANIFOLD_SNAPSHOT_MAX_STALE_MS?.trim();
  if (!raw) return DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_SNAPSHOT_AGE_MS;
}

function readyResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function checkedSnapshotMetadata(
  snapshot: ActiveSnapshot,
  installationId: string,
  nowMs: number,
  maxSnapshotAgeMs: number,
): { revision: string; builtAt: string; ageMs: number } {
  const { revision, builtAt } = snapshot.meta;
  if (
    snapshot.meta.installationId !== installationId ||
    typeof revision !== "string" ||
    revision.trim().length === 0 ||
    revision.length > 256 ||
    typeof builtAt !== "string"
  ) {
    throw new Error("snapshot metadata is invalid");
  }

  const builtAtMs = Date.parse(builtAt);
  if (!Number.isFinite(builtAtMs) || builtAtMs > nowMs || nowMs - builtAtMs > maxSnapshotAgeMs) {
    throw new Error("snapshot metadata is stale");
  }
  return { revision, builtAt: new Date(builtAtMs).toISOString(), ageMs: nowMs - builtAtMs };
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
  const maxSnapshotAgeMs = dependencies.maxSnapshotAgeMs ?? configuredMaxSnapshotAgeMs();

  return async (_request: Request): Promise<Response> => {
    try {
      if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0) {
        throw new Error("readiness snapshot age configuration is invalid");
      }
      const runtime = await runtimeProvider();
      const snapshot = await runtime.snapshots.loadActive(runtime.installationId);
      const snapshotMetadata = checkedSnapshotMetadata(
        snapshot,
        runtime.installationId,
        now(),
        maxSnapshotAgeMs,
      );
      return readyResponse({ ok: true, snapshot: snapshotMetadata }, 200);
    } catch {
      // Do not expose config, database, or control-plane failure details from a public route.
      return readyResponse({ ok: false, error: "unavailable" }, 503);
    }
  };
}

export const GET = createReadinessHandler();
