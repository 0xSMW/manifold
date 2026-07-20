// resolveProfile(host) — SPEC ADR-0001: a request's profile is bound to the trusted host
// and resolved BEFORE authentication. No header, query param, token claim, or body field can
// select or upgrade the profile.
import type { Snapshot, SnapshotProfile } from "@manifold/ports";

export interface ResolvedProfile {
  profileId: string;
  profile: SnapshotProfile;
}

/** Normalize an inbound Host header: lower-case, strip port. */
export function normalizeHost(host: string | null): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  // Strip a trailing :port, but keep IPv6 brackets intact for exact-match lookup.
  if (h.startsWith("[")) return h; // [::1]:port left as-is; snapshot keys it explicitly
  const colon = h.indexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

/** Look up the profile bound to a trusted host. Returns null if the host is unknown. */
export function resolveProfile(host: string | null, snapshot: Snapshot): ResolvedProfile | null {
  const key = normalizeHost(host);
  if (!key) return null;
  const profile = snapshot.profiles[key];
  if (!profile) return null;
  return { profileId: profile.id, profile };
}
