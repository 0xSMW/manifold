// packages/budget/src/ulid.ts — minimal ULID encode/decode.
//
// A ULID is 26 Crockford-base32 chars: the first 10 encode a 48-bit millisecond
// timestamp, the last 16 encode 80 bits of randomness. Manifold gateway trace-ids
// are ULIDs; the reservation transaction derives `budget_reservation.created_at`
// deterministically from the request ULID's timestamp (SPEC §6.7 B1, §16.3) — NOT
// from now() — so a retried invocation of the same request maps to the same monthly
// partition and the `(budget_account_id, request_id, created_at)` unique preserves
// exact single-reserve idempotency across a partition boundary.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < CROCKFORD.length; i++) m[CROCKFORD[i]!] = i;
  return m;
})();

const TIME_LEN = 10;
const RAND_LEN = 16;

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

function encodeTime(ms: number): string {
  let out = "";
  let n = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[n % 32]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(): string {
  let out = "";
  for (let i = 0; i < RAND_LEN; i++) {
    out += CROCKFORD[Math.floor(Math.random() * 32)]!;
  }
  return out;
}

/** Generate a ULID for `ms` (default: now). Monotonic ordering not required here. */
export function ulid(ms: number = Date.now()): string {
  return encodeTime(ms) + encodeRandom();
}
