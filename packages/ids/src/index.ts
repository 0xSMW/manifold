// packages/ids/src/index.ts — the ONE Manifold id vocabulary (SPEC §6.1, §6.7 B1).
//
// A ULID is 26 Crockford-base32 chars: the first 10 encode a 48-bit millisecond timestamp,
// the last 16 encode 80 bits of randomness. Manifold gateway trace-ids ARE ULIDs and the
// reservation transaction derives `budget_reservation.created_at` deterministically from the
// request ULID's timestamp (SPEC §6.7 B1, §16.3) — NOT from now() — so a retried invocation of
// the same request maps to the same monthly partition and the `(budget_account_id, request_id,
// created_at)` unique preserves exact single-reserve idempotency across a partition boundary.
//
// This is a LEAF: pure ES, zero dependencies, no platform/node imports. That is what lets the
// pure `@manifold/gateway-core` (Web-standard only, never imports @manifold/budget or a driver)
// and `@manifold/budget` share the SAME encoder — collapsing the previously divergent mint laws
// (config `genId`, budget `ulid`, gateway-core `mintTraceUlid`) into one compatible id shape.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD.length; i++) m[CROCKFORD[i]!] = i;
  return m;
})();

const TIME_LEN = 10;
const RAND_LEN = 16;
const ULID_LEN = TIME_LEN + RAND_LEN;

/** Encode a 48-bit millisecond timestamp as a ULID's 10-char Crockford-base32 time prefix. */
function encodeUlidTime(ms: number): string {
  let out = "";
  let n = Math.floor(ms);
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/**
 * 16 Crockford chars of CSPRNG randomness — the default for a freshly minted ULID. Uses
 * `globalThis.crypto.getRandomValues` (a CSPRNG present in Node 18+ and edge/browser), NOT
 * Math.random: these ids anchor reservations and are used as PKs, so weak entropy would raise
 * same-ms collision risk and be guessable. Each byte is masked to 5 bits (0–31) via rejection-free
 * modulo-free indexing so the Crockford distribution stays uniform.
 */
function encodeRandom(): string {
  const bytes = new Uint8Array(RAND_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RAND_LEN; i++) {
    out += CROCKFORD[bytes[i]! & 0x1f]!; // low 5 bits → one of 32 Crockford symbols, uniform
  }
  return out;
}

/** Decode the 48-bit millisecond timestamp encoded in a ULID's first 10 chars. */
export function ulidTimeMs(id: string): number {
  const time = id.slice(0, TIME_LEN).toUpperCase();
  if (time.length !== TIME_LEN) {
    throw new RangeError(`not a ULID (need >= ${TIME_LEN} chars): ${id}`);
  }
  let ms = 0;
  for (const ch of time) {
    const v = DECODE[ch];
    if (v === undefined) throw new RangeError(`invalid ULID char: ${ch}`);
    ms = ms * 32 + v;
  }
  return ms;
}

/** The `created_at` a reservation for this request ULID must use (§6.7 B1). */
export function ulidCreatedAt(id: string): Date {
  return new Date(ulidTimeMs(id));
}

/**
 * Is `s` a syntactically valid 26-char Crockford-base32 ULID whose 48-bit timestamp does not
 * overflow? A ULID's 10-char time prefix (50 bits) carries a 48-bit millisecond timestamp, so its
 * FIRST char is always `0`–`7`; a 26-char Crockford lookalike starting `8`–`Z` decodes to an
 * impossible (overflowed) millisecond and is rejected here so a caller can re-synthesize it with a
 * real `now` timestamp instead of trusting a garbage created_at.
 */
export function isUlid(s: string): boolean {
  if (s.length !== ULID_LEN) return false;
  const upper = s.toUpperCase();
  for (const ch of upper) {
    if (DECODE[ch] === undefined) return false;
  }
  return upper[0]! <= "7"; // time prefix must not overflow the 48-bit timestamp
}

/** Generate a ULID for `ms` (default: now). Monotonic ordering not required. */
export function ulid(ms: number = Date.now()): string {
  return encodeUlidTime(ms) + encodeRandom();
}

/**
 * A prefixed id (SPEC §6.1 convention: `<prefix>_<ULID>`) for the text primary keys minted by the
 * control-plane / config builder (workspaces, routes, revisions, config ops, …). The body is a full
 * Crockford ULID, so the id sorts by mint time and its timestamp is decodable — replacing the old
 * `prefix_<base36-time><hex>` shape while keeping the same `<prefix>_<opaque>` contract. Existing
 * text PKs minted under the old shape stay valid (the column is free-text; nothing parses the body).
 */
export function prefixedUlid(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Mint a ULID for `ms` whose 16 random chars are derived deterministically from an arbitrary
 * `entropy` string (e.g. the gateway crypto-port's `randomId`). Lets a PURE caller (gateway-core)
 * mint a real ULID trace-id without Math.random and without importing a driver: the time prefix is
 * `ms` (so `ulidCreatedAt` decodes it back to the request instant) and the trace still ties back to
 * the supplied entropy.
 */
export function ulidFromEntropy(ms: number, entropy: string): string {
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) {
    const code = entropy.charCodeAt(entropy.length - 1 - i) || i * 31 + 7;
    rand += CROCKFORD[code % 32]!;
  }
  return encodeUlidTime(ms) + rand;
}

/**
 * Mint a ULID for `ms` whose 16 random chars are derived deterministically from the first 16 bytes
 * of `bytes` (e.g. a sha256 digest of a non-ULID trace-id). Used to synthesize a valid ULID request
 * id whose TIME is `ms` while staying a stable function of the source, so same-instant retries of one
 * source collapse to a single reservation.
 */
export function ulidFromBytes(ms: number, bytes: Uint8Array): string {
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) {
    rand += CROCKFORD[(bytes[i] ?? 0) % 32]!;
  }
  return encodeUlidTime(ms) + rand;
}
