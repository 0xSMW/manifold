// Snapshot signing + verification (SPEC §7.3, ADR-0024).
//
// The control plane signs a snapshot's `contentHash` with its ed25519 snapshot-signing key
// (`MANIFOLD_SNAPSHOT_SIGNING_KEY`); the gateway pins only the public half
// (`MANIFOLD_SNAPSHOT_PUBLIC_KEY`) and verifies on load (ADR-0024). This keypair is DISTINCT
// from `gateway_installation.public_key` (the ingest identity), which never verifies a
// snapshot.
//
// NOTE on gateway-core interop: the current `@manifold/gateway-core` does NOT verify snapshot
// signatures — `handleRequest` consumes an already-loaded `ports.Snapshot` and trusts it
// (verification is the adapter/loader's job, not the pipeline's). So `verifySnapshot` here is
// the canonical implementation of §7.3's contract that a real loader (adapters-vercel /
// -cloudflare) MUST run before handing the snapshot to gateway-core. Our built snapshots carry
// a real ed25519 signature over `contentHash` and round-trip through verify below.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createHash,
  type KeyObject,
} from "node:crypto";
import { computeContentHash } from "./canonical.js";
import type { ConfigSnapshot } from "./types.js";

// DER prefixes for raw 32-byte Ed25519 keys (RFC 8410). Lets callers pass a bare 32-byte
// seed / public key (e.g. from an env var) without hand-rolling PEM.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type PrivateKeyInput = KeyObject | Uint8Array | string;
export type PublicKeyInput = KeyObject | Uint8Array | string;

function toBuf(u: Uint8Array): Buffer {
  return Buffer.isBuffer(u) ? u : Buffer.from(u);
}

/** Normalize any accepted private-key form into a node KeyObject. */
export function normalizePrivateKey(input: PrivateKeyInput): KeyObject {
  if (input instanceof Uint8Array) return privateKeyFromRaw(toBuf(input));
  if (typeof input === "string") {
    if (input.includes("-----BEGIN")) return createPrivateKey(input);
    return privateKeyFromRaw(Buffer.from(input, "base64"));
  }
  return input;
}

/** Normalize any accepted public-key form into a node KeyObject. */
export function normalizePublicKey(input: PublicKeyInput): KeyObject {
  if (input instanceof Uint8Array) return publicKeyFromRaw(toBuf(input));
  if (typeof input === "string") {
    if (input.includes("-----BEGIN")) return createPublicKey(input);
    return publicKeyFromRaw(Buffer.from(input, "base64"));
  }
  return input;
}

function privateKeyFromRaw(raw: Buffer): KeyObject {
  // 32-byte seed -> wrap in PKCS8. A full DER already carries its own header.
  if (raw.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
  }
  return createPrivateKey({ key: raw, format: "der", type: "pkcs8" });
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length === 32) {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  return createPublicKey({ key: raw, format: "der", type: "spki" });
}

/** Export the raw 32-byte public key from a KeyObject (for storing/pinning). */
export function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** Export the raw 32-byte private seed from a KeyObject. */
export function rawPrivateKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32));
}

/** Deterministic key id derived from the public key (`key_<sha256(pub)[..16]>`). */
export function deriveSigningKeyId(publicKey: PublicKeyInput): string {
  const raw = rawPublicKey(normalizePublicKey(publicKey));
  return `key_${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
}

/** Generate a fresh snapshot-signing keypair (ADR-0024). */
export function generateSigningKeyPair(): {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateKeyBase64: string;
  publicKeyBase64: string;
  signingKeyId: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey,
    privateKeyBase64: rawPrivateKey(privateKey).toString("base64"),
    publicKeyBase64: rawPublicKey(publicKey).toString("base64"),
    signingKeyId: deriveSigningKeyId(publicKey),
  };
}

/**
 * The exact bytes the ed25519 signature is computed over (§7.3, ADR-0024). Beyond the content
 * hash it BINDS the snapshot's identity (installationId + revision) — `contentHash` deliberately
 * excludes meta, so without this a signature would be portable across installations/revisions that
 * happen to share an identical body (a cross-installation replay vector). Defense-in-depth: the
 * loader recomputes this and any identity mismatch fails the signature.
 *
 * apps/gateway/src/snapshotVerify.ts reimplements this byte-for-byte (a plain JSON array so the two
 * impls cannot drift on key ordering) — keep them identical.
 */
export function snapshotSigningMessage(
  contentHash: string,
  installationId: string,
  revision: string,
): Buffer {
  return Buffer.from(JSON.stringify([contentHash, installationId, revision]), "utf8");
}

/**
 * Sign a snapshot in place-returning a new object: (re)computes `contentHash`, then signs the
 * identity-bound message (contentHash + installationId + revision) with ed25519 and sets
 * `meta.signature` (base64) + `meta.signingKeyId` (§7.2/§7.3).
 */
export function signSnapshot(
  snapshot: ConfigSnapshot,
  privateKey: PrivateKeyInput,
  signingKeyId?: string,
): ConfigSnapshot {
  const key = normalizePrivateKey(privateKey);
  const contentHash = computeContentHash(snapshot);
  const message = snapshotSigningMessage(
    contentHash,
    snapshot.meta.installationId,
    snapshot.meta.revision,
  );
  const signature = edSign(null, message, key).toString("base64");
  const keyId =
    signingKeyId ??
    (() => {
      const pub = createPublicKey(key);
      return deriveSigningKeyId(pub);
    })();
  return {
    ...snapshot,
    meta: { ...snapshot.meta, contentHash, signature, signingKeyId: keyId },
  };
}

export interface VerifyResult {
  ok: boolean;
  reason?: "content_hash_mismatch" | "bad_signature" | "no_signature";
}

/**
 * Verify a snapshot the way §7.3 requires a loader to: recompute `contentHash` over the
 * canonical body and compare to `meta.contentHash` (catches truncation/corruption), then
 * verify the ed25519 signature over the identity-bound message (contentHash + installationId +
 * revision) against the pinned public key — so a signature lifted onto a snapshot with a different
 * installationId/revision fails even when the body (hence contentHash) is identical.
 */
export function verifySnapshot(
  snapshot: ConfigSnapshot,
  publicKey: PublicKeyInput,
): VerifyResult {
  const recomputed = computeContentHash(snapshot);
  if (recomputed !== snapshot.meta.contentHash) return { ok: false, reason: "content_hash_mismatch" };
  if (!snapshot.meta.signature) return { ok: false, reason: "no_signature" };
  const key = normalizePublicKey(publicKey);
  const message = snapshotSigningMessage(
    snapshot.meta.contentHash,
    snapshot.meta.installationId,
    snapshot.meta.revision,
  );
  const ok = edVerify(null, message, key, Buffer.from(snapshot.meta.signature, "base64"));
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
}
