// @manifold/ports/price — the ONE parser for `SnapshotPrice` decimal-string µ$ fields.
//
// `SnapshotPrice` (see ./index.ts) carries each per-mtok price as a DECIMAL STRING of integer µ$
// so the whole snapshot stays plain JSON/signature-verifiable, then is parsed to a bigint at use.
// Both hot-path consumers parse those strings: the gateway reserve estimate (@manifold/gateway-core
// enforce) and the observability terminal-cost mapper (@manifold/observability mapPortsEvent). This
// leaf lives next to `SnapshotPrice`'s owner so BOTH import the SAME parser (no @manifold/database,
// no @manifold/domain edge required — ports is already a dependency of both) and a valid integer
// string can never map to two different bigints across the two sites.
//
// TRUNCATE, NEVER REJECT (documented here, once): a fractional µ$ string (e.g. "1.5") floors to its
// integer part rather than throwing, and any other unparseable junk yields `undefined` (no throw).
// This is the safe rule for the budget/reserve path — a bad price can never crash enforcement or the
// pure event mapper; at worst it under-counts by <1 µ$ for a sub-µ$ fraction. (The prior
// observability code did `BigInt(v)`, which THREW on any non-integer string; unifying on truncate
// removes that divergent failure mode.) A `null`/absent/empty field is `undefined` — the caller
// decides whether that means µ$0 (unpriced token class, §6.10) or a hard failure.

/**
 * Parse a `SnapshotPrice` per-mtok µ$ field (a decimal µ$ string, SPEC §6.10) to a non-negative
 * bigint of WHOLE µ$, truncating any fractional µ$ (floor). Returns `undefined` for `null` /
 * `undefined` / empty / unparseable input — never throws.
 */
export function parseMicroUsdString(v: string | null | undefined): bigint | undefined {
  if (v === null || v === undefined) return undefined;
  // Integer part only (truncate any fractional µ$), stripped to bare digits so surrounding
  // whitespace / stray junk can never make `BigInt` throw.
  const digits = (v.trim().split(".")[0] ?? "").replace(/[^0-9]/g, "");
  if (digits === "") return undefined;
  const n = BigInt(digits);
  // `digits` is [0-9]* so `n` is already >= 0n; the guard just makes the non-negative floor explicit.
  return n > 0n ? n : 0n;
}
