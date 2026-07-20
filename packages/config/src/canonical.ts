// Canonical JSON + content addressing (SPEC §7.3, ADR-0007).
//
// A snapshot's identity is `sha256:<hex>` over the canonical JSON of its body, EXCLUDING
// `meta.signature` (§7.3). We also exclude `meta.contentHash` itself (it is derived and
// cannot hash over its own value). Canonical = object keys sorted recursively, arrays kept in
// order — so the same content always hashes to the same digest regardless of build order or
// build time, which is what makes re-apply of identical content a no-op (§8.2 idempotency).
import { createHash } from "node:crypto";
import { formatContentHash, type ContentHash } from "@manifold/domain";
import type { ConfigSnapshot } from "./types.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Deterministic serialization: recursively sort object keys; preserve array order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value as Json));
}

function sortValue(value: Json): Json {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: { [k: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortValue(value[key] as Json);
  }
  return out;
}

/**
 * The canonical body over which `contentHash` is computed: the whole snapshot minus the
 * derived/signature meta fields (§7.3). Meta identity fields (schema, installationId,
 * revision, builtAt, signingKeyId) are deliberately EXCLUDED too so the hash is a pure
 * function of routing/key/policy content — see the module doc.
 */
export function canonicalBody(snapshot: ConfigSnapshot): string {
  // SECURITY (§16.3): `budgets` MUST be inside the signed content hash. It carries each account's
  // `enforcement` (hard vs soft) — the gateway's pre-dispatch reserve gate (enforce.ts) trusts it.
  // If budgets were excluded (as it was), a tamperer could flip `enforcement` hard→soft (or delete
  // an account) under a still-valid signature to bypass a hard cap, AND a pure budget edit would
  // hash identically to the prior snapshot → plan() sees a no-op and never publishes the change.
  // The gateway's DB-free reimplementation (apps/gateway/src/snapshotVerify.ts `canonicalBody`)
  // MUST select the identical field set in the identical order — keep the two byte-for-byte equal.
  const { profiles, keys, routes, offerings, policies, budgets } = snapshot;
  return stableStringify({ profiles, keys, routes, offerings, policies, budgets });
}

/** Compute `sha256:<hex>` over the canonical body (§7.3). */
export function computeContentHash(snapshot: ConfigSnapshot): ContentHash {
  const hex = createHash("sha256").update(canonicalBody(snapshot), "utf8").digest("hex");
  return formatContentHash(hex);
}

/** Generic `sha256:<hex>` over any canonicalized value (used for plan hashes, §8.2). */
export function sha256Canonical(value: unknown): ContentHash {
  const hex = createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
  return formatContentHash(hex);
}
