import assert from "node:assert/strict";
import test from "node:test";
import { decryptInvitationToken, encryptInvitationToken } from "../lib/invitation-delivery.ts";

test("invitation delivery outbox encrypts the recoverable capability", () => {
  const previous = process.env.MANIFOLD_INVITATION_DELIVERY_KEY;
  process.env.MANIFOLD_INVITATION_DELIVERY_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const token = "opaque-invitation-capability";
    const encrypted = encryptInvitationToken(token);
    assert.notEqual(encrypted.tokenCiphertext.toString("utf8"), token);
    assert.equal(encrypted.tokenIv.length, 12);
    assert.equal(encrypted.tokenTag.length, 16);
    assert.equal(decryptInvitationToken(encrypted), token);
  } finally {
    if (previous === undefined) delete process.env.MANIFOLD_INVITATION_DELIVERY_KEY;
    else process.env.MANIFOLD_INVITATION_DELIVERY_KEY = previous;
  }
});
