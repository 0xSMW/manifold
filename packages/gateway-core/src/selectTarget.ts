// selectTarget(route) — SPEC §8.1 reserved→dispatching guard. Picks a target by the route's
// mode (ordered by priority, or weighted). Returns null when no target exists →
// ROUTE_NO_HEALTHY_TARGET (§0.2). Health tracking (circuit breaking, §8.7) is a later WP; this
// skeleton treats every target as healthy.
import type { SnapshotRoute, SnapshotTarget } from "@manifold/ports";

/** Deterministic in tests: pass a seeded rand. Defaults to Math.random. */
export function selectTarget(
  route: SnapshotRoute,
  rand: () => number = Math.random,
): SnapshotTarget | null {
  const targets = route.targets;
  if (targets.length === 0) return null;

  if (route.mode === "ordered") {
    // Lowest priority number wins; stable for equal priorities.
    let best = targets[0]!;
    for (const t of targets) {
      if (t.priority < best.priority) best = t;
    }
    return best;
  }

  // weighted: pick proportional to weight; non-positive weights fall back to uniform.
  const total = targets.reduce((sum, t) => sum + Math.max(0, t.weight), 0);
  if (total <= 0) return targets[Math.floor(rand() * targets.length)] ?? targets[0]!;
  let threshold = rand() * total;
  for (const t of targets) {
    threshold -= Math.max(0, t.weight);
    if (threshold < 0) return t;
  }
  return targets[targets.length - 1]!;
}
