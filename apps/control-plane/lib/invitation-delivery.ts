import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { invitationDeliveryIdempotencyKey, sendAuthEmail } from "@/lib/auth-email";
import { hashAuthToken } from "@/lib/auth-secret";
import { withWorkspace } from "@/lib/db";

export type EncryptedInvitationToken = { tokenCiphertext: Buffer; tokenIv: Buffer; tokenTag: Buffer };
type DeliveryState = "pending" | "sent" | "failed";

/**
 * `generation` and `token_digest` form the immutable identity of one send attempt. A resend
 * atomically replaces both values, so a caller which was already in the provider cannot settle
 * the successor capability after it returns.
 */
type Delivery = EncryptedInvitationToken & {
  state: DeliveryState;
  generation: string;
  tokenDigest: Buffer;
  email: string;
  expiresAt: string;
};

export type InvitationDeliveryOutcome = "sent" | "failed" | "superseded";

function deliveryKey(): Buffer {
  const encoded = process.env.MANIFOLD_INVITATION_DELIVERY_KEY;
  if (!encoded) throw new Error("MANIFOLD_INVITATION_DELIVERY_KEY is required for invitation delivery");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("MANIFOLD_INVITATION_DELIVERY_KEY must be a base64 32-byte key");
  return key;
}

export function encryptInvitationToken(token: string): EncryptedInvitationToken {
  const tokenIv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deliveryKey(), tokenIv);
  const tokenCiphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { tokenCiphertext, tokenIv, tokenTag: cipher.getAuthTag() };
}

export function decryptInvitationToken(input: EncryptedInvitationToken): string {
  const decipher = createDecipheriv("aes-256-gcm", deliveryKey(), input.tokenIv);
  decipher.setAuthTag(input.tokenTag);
  return Buffer.concat([decipher.update(input.tokenCiphertext), decipher.final()]).toString("utf8");
}

/** Dispatch the exact durable generation which was read before the provider call. */
export async function deliverInvitation(workspaceId: string, invitationId: string): Promise<InvitationDeliveryOutcome> {
  const delivery = await withWorkspace(workspaceId, async (sql) => {
    const row = (await sql<{
      state: DeliveryState;
      generation: string;
      token_digest: Buffer;
      token_ciphertext: Buffer;
      token_iv: Buffer;
      token_tag: Buffer;
      email: string;
      expires_at: string;
    }[]>`
      SELECT d.state,d.generation,d.token_digest,d.token_ciphertext,d.token_iv,d.token_tag,i.email,i.expires_at
      FROM workspace_invitation_delivery d
      JOIN workspace_invitation i ON i.id=d.invitation_id
      WHERE d.invitation_id=${invitationId} AND d.workspace_id=${workspaceId}
      FOR UPDATE`)[0];
    if (!row) throw new Error("invitation delivery outbox record is missing");
    return {
      state: row.state,
      generation: row.generation,
      tokenDigest: row.token_digest,
      tokenCiphertext: row.token_ciphertext,
      tokenIv: row.token_iv,
      tokenTag: row.token_tag,
      email: row.email,
      expiresAt: row.expires_at,
    } satisfies Delivery;
  });

  if (delivery.state === "failed") return "failed";
  if (delivery.state === "sent") return "sent";

  const token = decryptInvitationToken(delivery);
  const tokenDigest = hashAuthToken(token);
  // Do not send a corrupted or mismatched outbox record. The guarded failure update also cannot
  // overwrite a replacement generation which raced this worker.
  if (tokenDigest.length !== delivery.tokenDigest.length || !timingSafeEqual(tokenDigest, delivery.tokenDigest)) {
    const changed = await withWorkspace(workspaceId, (sql) => sql<{ invitation_id: string }[]>`
      UPDATE workspace_invitation_delivery SET state='failed',failed_at=now(),updated_at=now()
      WHERE invitation_id=${invitationId} AND workspace_id=${workspaceId}
        AND generation=${delivery.generation} AND token_digest=${delivery.tokenDigest}
      RETURNING invitation_id`);
    return changed.length ? "failed" : "superseded";
  }

  try {
    await sendAuthEmail(
      { to: delivery.email, kind: "invitation", token, expiresAt: delivery.expiresAt },
      { idempotencyKey: invitationDeliveryIdempotencyKey(invitationId, token) },
    );
  } catch {
    const changed = await withWorkspace(workspaceId, (sql) => sql<{ invitation_id: string }[]>`
      UPDATE workspace_invitation_delivery SET state='failed',failed_at=now(),updated_at=now()
      WHERE invitation_id=${invitationId} AND workspace_id=${workspaceId}
        AND generation=${delivery.generation} AND token_digest=${delivery.tokenDigest}
      RETURNING invitation_id`);
    return changed.length ? "failed" : "superseded";
  }

  const changed = await withWorkspace(workspaceId, (sql) => sql<{ invitation_id: string }[]>`
    UPDATE workspace_invitation_delivery SET state='sent',sent_at=now(),failed_at=NULL,updated_at=now()
    WHERE invitation_id=${invitationId} AND workspace_id=${workspaceId}
      AND generation=${delivery.generation} AND token_digest=${delivery.tokenDigest}
    RETURNING invitation_id`);
  return changed.length ? "sent" : "superseded";
}
