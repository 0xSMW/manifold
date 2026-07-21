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
  // Bracketed IPv6 literal (e.g. `[::1]` or `[::1]:8080`): the snapshot keys profiles by the
  // bracketed literal WITHOUT a port, so a trailing `:port` after the closing bracket must be
  // stripped too, or a correctly-keyed IPv6 profile 404s as PROFILE_UNKNOWN.
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
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
