// resolveRoute(profile, path, snapshot) — SPEC §7.2: routes are keyed by a composite string
// `${profileId}:${path}`, so lookup is O(1) with no scan. Returns null → ROUTE_UNKNOWN (§8.1).
import type { Snapshot, SnapshotRoute } from "@manifold/ports";

/** Route-map key. Path is the request pathname (e.g. "/v1/messages"), query stripped. */
export function routeKey(profileId: string, path: string): string {
  return `${profileId}:${path}`;
}

export function resolveRoute(
  profileId: string,
  path: string,
  snapshot: Snapshot,
): SnapshotRoute | null {
  return snapshot.routes[routeKey(profileId, path)] ?? null;
}
