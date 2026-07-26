import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { auditDeliveryPayload, signedAuditDeliveryHeaders } from "../lib/audit-delivery.ts";
import { ControlEgressError, executeControlEgress } from "../lib/control-egress.ts";

test("audit delivery signs the exact canonical payload without credential disclosure", () => {
  const body = auditDeliveryPayload({
    event_id: "aud_1", created_at: "2026-07-25T10:00:00.000Z", actor_kind: "member", actor_id: "mem_1",
    action: "route.publish", target_kind: "route", target_id: "route_1", request_ref: "req_1",
    before_hash: "before", after_hash: "after", detail: { revision: "rev_1" }, chain_hash: Buffer.from("chain"), kind: "siem",
  });
  const headers = signedAuditDeliveryHeaders("aud_1", body, "shared-secret");
  assert.equal(headers["x-manifold-signature-256"], `sha256=${createHmac("sha256", "shared-secret").update(body).digest("hex")}`);
  assert.equal(headers["x-manifold-event-id"], "aud_1");
  assert.equal(new TextDecoder().decode(body).includes("shared-secret"), false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(body)).event, {
    id: "aud_1", occurredAt: "2026-07-25T10:00:00.000Z", actor: { kind: "member", id: "mem_1" }, action: "route.publish",
    target: { kind: "route", id: "route_1" }, requestRef: "req_1", beforeHash: "before", afterHash: "after", detail: { revision: "rev_1" }, chainHash: Buffer.from("chain").toString("hex"),
  });
});

test("audit webhook egress rejects an SSRF destination before transport", async () => {
  let called = false;
  await assert.rejects(
    executeControlEgress({ url: "https://127.0.0.1/audit", allowedHosts: ["127.0.0.1"], method: "POST" }, {
      resolve: async () => ["127.0.0.1"],
      fetch: async () => { called = true; return new Response("unexpected"); },
      maxRedirects: 0,
    }),
    (error: unknown) => error instanceof ControlEgressError && error.code === "EGRESS_POLICY",
  );
  assert.equal(called, false);
});
