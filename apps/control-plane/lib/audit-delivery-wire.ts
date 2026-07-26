import { createHmac } from "node:crypto";

export interface AuditDeliveryWireEvent {
  eventId: string; createdAt: string; actorKind: string; actorId: string | null; action: string;
  targetKind: string | null; targetId: string | null; requestRef: string | null;
  beforeHash: string | null; afterHash: string | null; detail: unknown; chainHash: Uint8Array | null; destinationKind: "webhook" | "siem";
}

export function auditDeliveryPayload(event: AuditDeliveryWireEvent, maxBytes = 48 * 1024): Buffer {
  const body = Buffer.from(JSON.stringify({ version: 1, type: "manifold.audit_event", event: {
    id: event.eventId, occurredAt: event.createdAt, actor: { kind: event.actorKind, id: event.actorId }, action: event.action,
    target: event.targetKind || event.targetId ? { kind: event.targetKind, id: event.targetId } : null, requestRef: event.requestRef,
    beforeHash: event.beforeHash, afterHash: event.afterHash, detail: event.detail, chainHash: event.chainHash ? Buffer.from(event.chainHash).toString("hex") : null,
  }, destination: { kind: event.destinationKind } }));
  if (body.byteLength > maxBytes) throw new Error("DELIVERY_PAYLOAD_TOO_LARGE");
  return body;
}

export function signedAuditDeliveryHeaders(eventId: string, body: Buffer, secret: string | null): Record<string, string> {
  const signature = secret ? createHmac("sha256", secret).update(body).digest("hex") : null;
  return { "content-type": "application/json", "user-agent": "Manifold-Audit-Delivery/1", "x-manifold-event-id": eventId, ...(signature ? { "x-manifold-signature-256": `sha256=${signature}` } : {}) };
}
