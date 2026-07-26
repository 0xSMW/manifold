import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate } from "../src/authenticate.ts";
import type { Snapshot } from "@manifold/ports";
import { FakeCrypto, keyedHashHex } from "@manifold/ports/testing";

const crypto = new FakeCrypto();
const presented = "sk_rotation_test";
const oldPepper = new TextEncoder().encode("old-pepper");
const newPepper = new TextEncoder().encode("new-pepper");

async function snapshotWith(pepper: Uint8Array): Promise<Snapshot> {
  const hash = await keyedHashHex(crypto, pepper, presented);
  return {
    meta: { schema: "manifold.snapshot.v1", installationId: "i", revision: "r", contentHash: "", builtAt: "", signature: "", signingKeyId: "" },
    profiles: {}, routes: {},
    keys: { [hash]: { id: "vk", profileId: "profile", scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null } },
  } as unknown as Snapshot;
}

function request(): Request {
  return new Request("https://gateway.example/v1/chat/completions", { headers: { authorization: `Bearer ${presented}` } });
}

test("pepper overlap authenticates new and old snapshot hashes in configured order", async () => {
  const overlap = [newPepper, oldPepper] as const;
  assert.equal((await authenticate(request(), "profile", await snapshotWith(newPepper), crypto, overlap, new Date())).ok, true);
  assert.equal((await authenticate(request(), "profile", await snapshotWith(oldPepper), crypto, overlap, new Date())).ok, true);
});

test("pepper retirement removes old hash acceptance and malformed direct overlap fails closed", async () => {
  const oldSnapshot = await snapshotWith(oldPepper);
  const retired = await authenticate(request(), "profile", oldSnapshot, crypto, [newPepper], new Date());
  assert.deepEqual(retired, { ok: false, reason: "AUTH_KEY_UNKNOWN", message: "api key not recognized" });
  const malformed = await authenticate(request(), "profile", oldSnapshot, crypto, [newPepper, oldPepper, oldPepper], new Date());
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.reason, "AUTH_KEY_UNKNOWN");
});
