// packages/domain/src/values/contentHash.ts — content-addressing wrapper (SPEC §5.5, §6.5, §6.11).
//
// Route/policy/price/config revisions are immutable and content-addressed: their
// identity is `sha256:<hex>` of the canonical serialized content. This wraps that
// string shape so callers can't accidentally hand a bare hex digest (or the wrong
// hash algorithm) where a `content_hash` is expected.
const HEX64 = /^[0-9a-f]{64}$/;

/** A validated `sha256:<64 lowercase hex chars>` content hash. */
export type ContentHash = string & { readonly __brand: "ContentHash" };

/** True iff `value` is a well-formed `sha256:<hex>` content hash. */
export function isContentHash(value: string): value is ContentHash {
  const prefix = "sha256:";
  if (!value.startsWith(prefix)) return false;
  const hex = value.slice(prefix.length);
  return HEX64.test(hex);
}

/**
 * Parse and validate a `sha256:<hex>` string, throwing if it is malformed.
 * Use at trust boundaries (reading a DB row / wire payload into a domain value).
 */
export function parseContentHash(value: string): ContentHash {
  if (!isContentHash(value)) {
    throw new RangeError(`invalid content hash: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Format a raw 64-char lowercase hex sha256 digest as a `ContentHash`. */
export function formatContentHash(hex: string): ContentHash {
  const normalized = hex.toLowerCase();
  if (!HEX64.test(normalized)) {
    throw new RangeError(`invalid sha256 hex digest: ${JSON.stringify(hex)}`);
  }
  return `sha256:${normalized}` as ContentHash;
}
