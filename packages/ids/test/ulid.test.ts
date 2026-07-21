// packages/ids/test — the id vocabulary round-trips: a minted ULID decodes to its mint time,
// prefixedUlid keeps the `<prefix>_<opaque>` contract, and the entropy/byte variants stay valid.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUlid,
  prefixedUlid,
  ulid,
  ulidCreatedAt,
  ulidFromBytes,
  ulidFromEntropy,
  ulidTimeMs,
} from "../src/index.ts";

test("ulid: 26-char Crockford ULID whose time prefix decodes back to the mint ms", () => {
  const ms = Date.UTC(2026, 6, 20, 0, 0, 0); // 2026-07-20T00:00:00Z
  const id = ulid(ms);
  assert.equal(id.length, 26);
  assert.ok(isUlid(id));
  assert.equal(ulidTimeMs(id), ms);
  assert.equal(ulidCreatedAt(id).getTime(), ms);
});

test("prefixedUlid: <prefix>_<26-char ULID> and the body is itself a valid ULID", () => {
  const id = prefixedUlid("rt");
  assert.match(id, /^rt_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(isUlid(id.slice("rt_".length)));
});

test("isUlid: rejects wrong length, invalid chars, and 48-bit overflow lookalikes", () => {
  assert.equal(isUlid("trace_deadbeef"), false);
  assert.equal(isUlid("I".repeat(26)), false); // 'I' is not in the Crockford alphabet
  assert.equal(isUlid("Z".repeat(26)), false); // first char > '7' overflows the timestamp
  assert.equal(isUlid(ulid()), true);
});

test("ulidFromEntropy / ulidFromBytes: deterministic, valid ULIDs whose time prefix is `ms`", () => {
  const ms = Date.UTC(2026, 6, 20, 12, 34, 56);
  const fromEnt = ulidFromEntropy(ms, "t_0123456789abcdef0123456789abcdef");
  assert.equal(fromEnt.length, 26);
  assert.equal(ulidTimeMs(fromEnt), ms);
  assert.equal(ulidFromEntropy(ms, "t_0123456789abcdef0123456789abcdef"), fromEnt); // deterministic

  const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 5) & 0xff);
  const fromBytes = ulidFromBytes(ms, bytes);
  assert.equal(fromBytes.length, 26);
  assert.equal(ulidTimeMs(fromBytes), ms);
  assert.equal(ulidFromBytes(ms, bytes), fromBytes); // deterministic
});
