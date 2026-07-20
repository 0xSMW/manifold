// packages/domain/src/values/contentHash.test.ts — sha256:<hex> content-hash wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatContentHash, isContentHash, parseContentHash } from "./contentHash.js";

const VALID_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const VALID = `sha256:${VALID_HEX}`;

test("isContentHash: accepts well-formed sha256:<64 hex> strings", () => {
  assert.equal(isContentHash(VALID), true);
});

test("isContentHash: rejects malformed strings", () => {
  assert.equal(isContentHash(VALID_HEX), false); // missing prefix
  assert.equal(isContentHash("md5:" + VALID_HEX), false); // wrong algorithm
  assert.equal(isContentHash("sha256:" + VALID_HEX.slice(0, 10)), false); // too short
  assert.equal(isContentHash("sha256:" + VALID_HEX.toUpperCase()), false); // uppercase not allowed
  assert.equal(isContentHash("sha256:" + "g".repeat(64)), false); // non-hex char
  assert.equal(isContentHash(""), false);
});

test("parseContentHash: returns the value when valid, throws when not", () => {
  assert.equal(parseContentHash(VALID), VALID);
  assert.throws(() => parseContentHash("not-a-hash"), RangeError);
});

test("formatContentHash: formats and lowercases a raw hex digest", () => {
  assert.equal(formatContentHash(VALID_HEX), VALID);
  assert.equal(formatContentHash(VALID_HEX.toUpperCase()), VALID);
});

test("formatContentHash: throws on a digest of the wrong shape", () => {
  assert.throws(() => formatContentHash("abc"), RangeError);
});
