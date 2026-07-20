// apps/gateway — DB-free snapshot signature verification (SPEC §7.3, ADR-0024).
//
// The control plane signs a snapshot's `contentHash` with its ed25519 snapshot-signing key; the
// gateway pins only the public half (`MANIFOLD_SNAPSHOT_PUBLIC_KEY`, base64) and MUST verify on
// load before trusting routes/keys/baseUrl/ciphertext. A forged MANIFOLD_SNAPSHOT (rewritten body)
// must be rejected — the loader fails closed.
//
// This is a byte-for-byte reimplementation of @manifold/config's canonicalization + hashing +
// ed25519 signature (see packages/config/src/canonical.ts and signing.ts). It is deliberately
// DB-free: it uses ONLY node:crypto and does NOT import the @manifold/config barrel (which pulls
// @manifold/database into the gateway runtime). A config-signed snapshot verifies here unchanged.
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";
import type { Snapshot } from "@manifold/ports";

// DER prefix for a raw 32-byte Ed25519 SPKI public key (RFC 8410) — matches
// @manifold/config's signing.ts so a bare base64 32-byte pinned key works without PEM.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Deterministic serialization: recursively sort object keys; preserve array order. */
function sortValue(value: Json): Json {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: { [k: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortValue(value[key] as Json);
  }
  return out;
}

/** Matches @manifold/config canonical.ts `stableStringify`. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value as Json));
}

/**
 * The canonical body over which `contentHash` is computed (§7.3): the whole snapshot minus the
 * derived/signature meta fields. Selects the exact same field set — IN THE SAME ORDER — as
 * @manifold/config `canonicalBody` (packages/config/src/canonical.ts); the two MUST stay
 * byte-for-byte identical or a config-signed snapshot would fail to verify here. `budgets` is
 * SECURITY-critical: it carries each account's `enforcement` (hard vs soft) that the reserve gate
 * trusts, so it must be inside the signed hash (else a tamperer flips hard→soft under a valid
 * signature). Undefined sections (a plain ports.Snapshot may have no offerings/policies/budgets)
 * are dropped by JSON.stringify, exactly as they are in config.
 */
function canonicalBody(snapshot: Snapshot): string {
  const snap = snapshot as unknown as Record<string, unknown>;
  const { profiles, keys, routes, offerings, policies, budgets } = snap;
  return stableStringify({ profiles, keys, routes, offerings, policies, budgets });
}

/** Compute `sha256:<hex>` over the canonical body (matches @manifold/config `computeContentHash`). */
export function computeSnapshotContentHash(snapshot: Snapshot): string {
  const hex = createHash("sha256").update(canonicalBody(snapshot), "utf8").digest("hex");
  return `sha256:${hex}`;
}

/**
 * The exact bytes the ed25519 signature is computed over — a byte-for-byte reimplementation of
 * @manifold/config `snapshotSigningMessage` (signing.ts). Binds the content hash to the snapshot's
 * identity (installationId + revision) so a signature is not portable across installations/revisions
 * that share an identical body. A plain JSON array (no key ordering) keeps the two impls identical.
 */
function snapshotSigningMessage(contentHash: string, installationId: string, revision: string): Buffer {
  return Buffer.from(JSON.stringify([contentHash, installationId, revision]), "utf8");
}

/** Normalize a base64-encoded ed25519 public key (raw 32-byte or full SPKI DER) into a KeyObject. */
function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length === 32) {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  return createPublicKey({ key: raw, format: "der", type: "spki" });
}

export interface SnapshotVerifyResult {
  ok: boolean;
  reason?: "content_hash_mismatch" | "bad_signature" | "no_signature";
}

/**
 * Verify a snapshot the way §7.3 requires a loader to (byte-for-byte with @manifold/config
 * `verifySnapshot`): recompute `contentHash` over the canonical body and compare to
 * `meta.contentHash` (catches any body tamper), then ed25519-verify `meta.signature` over the
 * identity-bound message (contentHash + installationId + revision) against the pinned public key.
 */
export function verifySnapshot(snapshot: Snapshot, publicKeyBase64: string): SnapshotVerifyResult {
  const recomputed = computeSnapshotContentHash(snapshot);
  if (recomputed !== snapshot.meta.contentHash) return { ok: false, reason: "content_hash_mismatch" };
  if (!snapshot.meta.signature) return { ok: false, reason: "no_signature" };
  const message = snapshotSigningMessage(
    snapshot.meta.contentHash,
    snapshot.meta.installationId,
    snapshot.meta.revision,
  );
  const ok = edVerify(
    null,
    message,
    publicKeyFromBase64(publicKeyBase64),
    Buffer.from(snapshot.meta.signature, "base64"),
  );
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Truthy MANIFOLD_REQUIRE_SIGNED flag — forces signature verification even outside production. */
function requireSignedFlag(): boolean {
  const v = (process.env.MANIFOLD_REQUIRE_SIGNED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Enforce §7.3 on load. When a public key is pinned (env `MANIFOLD_SNAPSHOT_PUBLIC_KEY`, base64),
 * verify and THROW (fail closed) on any mismatch.
 *
 * When NO key is pinned the policy depends on the environment: in production (NODE_ENV==='production')
 * or when MANIFOLD_REQUIRE_SIGNED is set, loading an UNVERIFIED snapshot is fail-OPEN, so we THROW
 * (fail closed). ONLY outside production (dev) do we fall back to the warn-and-load escape hatch that
 * keeps snapshot.example.json booting locally.
 */
export function assertSnapshotTrusted(snapshot: Snapshot, publicKeyBase64?: string): void {
  const pinned = publicKeyBase64 ?? process.env.MANIFOLD_SNAPSHOT_PUBLIC_KEY;
  if (!pinned) {
    if (process.env.NODE_ENV === "production" || requireSignedFlag()) {
      throw new Error(
        "MANIFOLD_SNAPSHOT_PUBLIC_KEY is not set but snapshot verification is REQUIRED " +
          "(NODE_ENV=production or MANIFOLD_REQUIRE_SIGNED) — refusing to load an unverified snapshot " +
          "(§7.3, fail closed). Pin the base64 ed25519 public key.",
      );
    }
    console.warn(
      "[manifold] WARNING: MANIFOLD_SNAPSHOT_PUBLIC_KEY is not set — loading an UNVERIFIED snapshot. " +
        "The snapshot signature is NOT checked; a forged snapshot would be trusted. " +
        "Set MANIFOLD_SNAPSHOT_PUBLIC_KEY (base64 ed25519 public key) in any non-dev environment (§7.3).",
    );
    return;
  }
  const result = verifySnapshot(snapshot, pinned);
  if (!result.ok) {
    throw new Error(`snapshot signature verification failed: ${result.reason} (§7.3, fail closed)`);
  }
}
