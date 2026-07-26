import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { auditDeliveryPayload, signedAuditDeliveryHeaders } from "../lib/audit-delivery-wire.ts";

test("delivery payload and HMAC header cover the exact body without credentials", () => {
  const body = auditDeliveryPayload({ eventId: "aud_1", createdAt: "2026-01-01T00:00:00.000Z", actorKind: "system", actorId: null, action: "route.update", targetKind: null, targetId: null, requestRef: null, beforeHash: null, afterHash: null, detail: { outcome: "ok" }, chainHash: null, destinationKind: "webhook" });
  const headers = signedAuditDeliveryHeaders("aud_1", body, "delivery-secret");
  assert.equal(headers["x-manifold-signature-256"], `sha256=${createHmac("sha256", "delivery-secret").update(body).digest("hex")}`);
  assert.equal(body.toString("utf8").includes("delivery-secret"), false);
  assert.equal(body.toString("utf8").includes("https://"), false);
  assert.equal(signedAuditDeliveryHeaders("aud_1", body, null)["x-manifold-signature-256"], undefined);
});

test("bounded exports reject oversized payloads", () => {
  assert.throws(() => auditDeliveryPayload({ eventId: "aud_2", createdAt: "now", actorKind: "system", actorId: null, action: "x", targetKind: null, targetId: null, requestRef: null, beforeHash: null, afterHash: null, detail: "x".repeat(100), chainHash: null, destinationKind: "siem" }, 30), /DELIVERY_PAYLOAD_TOO_LARGE/);
});
