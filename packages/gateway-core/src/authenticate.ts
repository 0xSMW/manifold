// authenticate(request, profileId, snapshot) — SPEC §8.1 profiled→authenticated guard.
// Computes HMAC(pepper, presentedKey), indexes snapshot.keys (O(1), zero DB, ADR-0005),
// then checks expiry / profile match, returning AUTH_* reason codes (§0.2). Revoked keys are not
// checked here: config filters them out of the snapshot at build (F10), so a revoked key is absent
// from snapshot.keys and falls through to AUTH_KEY_UNKNOWN below.
import type { ReasonCode } from "@manifold/contracts";
import type { Crypto, Snapshot, SnapshotKey } from "@manifold/ports";

export type AuthResult =
  | { ok: true; key: SnapshotKey; keyHash: string }
  | { ok: false; reason: ReasonCode; message: string };

/** Lower-case hex encode. */
function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Extract the presented virtual key from the Authorization header ("Bearer <key>" or raw). */
export function presentedKey(request: Request): string | null {
  const raw = request.headers.get("authorization");
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^Bearer\s+(.+)$/i.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

export async function authenticate(
  request: Request,
  profileId: string,
  snapshot: Snapshot,
  crypto: Crypto,
  pepper: Uint8Array,
  now: Date,
): Promise<AuthResult> {
  const key = presentedKey(request);
  if (!key) {
    return { ok: false, reason: "AUTH_KEY_UNKNOWN", message: "no api key presented" };
  }
  const digest = await crypto.hmacSha256(pepper, new TextEncoder().encode(key));
  const keyHash = toHex(digest);
  const record = snapshot.keys[keyHash];
  if (!record) {
    return { ok: false, reason: "AUTH_KEY_UNKNOWN", message: "api key not recognized" };
  }
  if (record.expiresAt !== null) {
    // Fail CLOSED on an unparseable expiry: Date.parse of a corrupt/typo string is NaN, and
    // `NaN <= now` is false — which would let a malformed key live forever. Treat any expiry we
    // cannot parse as already expired (§14.3, defense-in-depth).
    const expiresMs = new Date(record.expiresAt).getTime();
    if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
      return { ok: false, reason: "AUTH_KEY_EXPIRED", message: "api key has expired" };
    }
  }
  if (record.profileId !== profileId) {
    return {
      ok: false,
      reason: "AUTH_PROFILE_MISMATCH",
      message: "api key is not valid for this host",
    };
  }
  return { ok: true, key: record, keyHash };
}
