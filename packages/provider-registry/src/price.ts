// @manifold/provider-registry — price conversion.
// ADR-0008 (money is integer micro-USD; prices are µ$ per 1M tokens) and
// SPEC §11.6 "Price conversion (normative)":
//
//   input_per_mtok_microusd = round_half_even(cost.input × 1_000_000)
//
// models.dev quotes USD per 1M tokens as a JSON number; Manifold stores
// integer µ$ per 1M tokens. The spec is explicit that the ×10⁶ must be an
// exact decimal operation — "parse the JSON number as a decimal string, not
// a binary float, to avoid 0.1+0.2 drift" — with any fractional sub-µ$
// remainder rounded half-to-even (banker's rounding) at the µ$ boundary.
//
// This implementation never multiplies in floating point. It renders the
// input to its canonical decimal string (JS's `Number#toString` produces the
// shortest string that round-trips to that double — for the modest, few-
// significant-digit literals models.dev uses, e.g. 3, 0.3, 15, 3.75, that
// string IS the original JSON literal) and then does the ×10⁶ shift and any
// rounding as pure string/BigInt decimal arithmetic.

const DECIMAL_LITERAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Render a JS number as a plain (non-exponential) decimal string.
 *
 * `String(n)` switches to scientific notation for magnitudes below 1e-6
 * (e.g. `String(5e-7) === "5e-7"`), and that form is rejected by
 * `DECIMAL_LITERAL`, which would abort the whole import for a single tiny
 * price. models.dev does quote sub-µ$ prices this small, so expand any
 * exponential form back to a plain decimal string here. The expansion is
 * pure digit-shuffling on the string `String(n)` already produced — it adds
 * no float error of its own.
 */
function numberToPlainDecimalString(n: number): string {
  const s = String(n);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!match) return s;

  const sign = match[1] ?? "";
  const intDigits = match[2] ?? "0";
  const fracDigits = match[3] ?? "";
  const exp = Number(match[4]);
  const digits = intDigits + fracDigits;
  // Decimal point currently sits after `intDigits.length` digits; the
  // exponent shifts it right (positive) or left (negative).
  const pointPos = intDigits.length + exp;

  let result: string;
  if (pointPos <= 0) {
    result = "0." + "0".repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    result = digits + "0".repeat(pointPos - digits.length);
  } else {
    result = digits.slice(0, pointPos) + "." + digits.slice(pointPos);
  }
  return sign + result;
}

/**
 * Convert a models.dev `cost.*` value (USD per 1,000,000 tokens) to integer
 * micro-USD per 1M tokens (SPEC §11.6, ADR-0008).
 *
 * `priceToMicroUnits(3) === 3_000_000n`
 * `priceToMicroUnits(0.3) === 300_000n`
 * `priceToMicroUnits(15) === 15_000_000n`
 *
 * Accepts a decimal string directly as well, for callers that want to
 * bypass JS number parsing entirely.
 */
export function priceToMicroUnits(dollarsPerMtok: number | string): bigint {
  const raw =
    typeof dollarsPerMtok === "string"
      ? dollarsPerMtok.trim()
      : numberToPlainDecimalString(dollarsPerMtok);

  const match = DECIMAL_LITERAL.exec(raw);
  if (!match) {
    throw new Error(
      `priceToMicroUnits: expected a plain decimal literal, got ${JSON.stringify(dollarsPerMtok)}`,
    );
  }
  const sign = match[1] ?? "";
  const intPart = match[2] ?? "0";
  const fracPart = match[3] ?? "";
  const negative = sign === "-";

  // The first 6 fractional digits become the µ$ digits; anything past that
  // only informs rounding of the 6th digit.
  const keptFracDigits = fracPart.slice(0, 6).padEnd(6, "0");
  const remainder = fracPart.slice(6);

  let magnitude = BigInt(intPart + keptFracDigits);
  magnitude += roundingAdjustment(remainder, magnitude);

  return negative ? -magnitude : magnitude;
}

/** Half-to-even rounding decision for the digits beyond the 6th fractional place. */
function roundingAdjustment(remainder: string, magnitudeSoFar: bigint): 0n | 1n {
  if (remainder.length === 0) return 0n;

  const firstDigit = remainder[0];
  if (firstDigit === undefined || firstDigit < "5") return 0n;
  if (firstDigit > "5") return 1n;

  // firstDigit === "5": exact half only if every digit after it is zero.
  const isExactHalf = !/[1-9]/.test(remainder.slice(1));
  if (!isExactHalf) return 1n;

  // Round half to even: bump only if the truncated magnitude is odd.
  return magnitudeSoFar % 2n === 0n ? 0n : 1n;
}
