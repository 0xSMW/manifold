// resolveRoute(profile, endpointKind, publicName, snapshot) — SPEC §7.2: routes are keyed by
// `${profileId}:${endpointKind}:${publicName}`, so lookup is O(1) with no scan. Legacy
// `${profileId}:${path}` snapshots remain readable while the fleet migrates.
import { pathForEndpointKind, type EndpointKind, type Snapshot, type SnapshotRoute } from "@manifold/ports";

/** SPEC §7.2 route-map key. `publicName` is the client-supplied model name. */
export function routeKey(profileId: string, endpointKind: EndpointKind, publicName: string): string {
  return `${profileId}:${endpointKind}:${publicName}`;
}

/** Temporary migration key for snapshots emitted before model-aware routing. */
export function legacyPathRouteKey(profileId: string, path: string): string {
  return `${profileId}:${path}`;
}

/** @deprecated Legacy path-only lookup retained for callers not yet parsing request models. */
export function resolveRoute(profileId: string, path: string, snapshot: Snapshot): SnapshotRoute | null;
/** Resolve a model-aware route, falling back to a legacy path-keyed snapshot during migration. */
export function resolveRoute(
  profileId: string,
  endpointKind: EndpointKind,
  publicName: string,
  snapshot: Snapshot,
): SnapshotRoute | null;
export function resolveRoute(
  profileId: string,
  endpointKindOrPath: EndpointKind,
  publicNameOrSnapshot: string | Snapshot,
  maybeSnapshot?: Snapshot,
): SnapshotRoute | null {
  // Existing handleRequest callers pass (profileId, path, snapshot). Keep that
  // exact behavior until they parse endpointKind + model from the body.
  if (!maybeSnapshot) {
    const snapshot = publicNameOrSnapshot as Snapshot;
    return snapshot.routes[legacyPathRouteKey(profileId, endpointKindOrPath)] ?? null;
  }

  const publicName = publicNameOrSnapshot as string;
  return (
    maybeSnapshot.routes[routeKey(profileId, endpointKindOrPath, publicName)] ??
    maybeSnapshot.routes[legacyPathRouteKey(profileId, pathForEndpointKind(endpointKindOrPath))] ??
    null
  );
}
