import { randomUUID } from "node:crypto";
import { canonicalAuthOrigin } from "@/lib/auth-origin";
import { hashAuthToken } from "@/lib/auth-secret";

type Environment = Record<string, string | undefined>;
export type AuthEmailKind = "activation" | "invitation" | "password-reset";
export interface SendAuthEmailInput {
  to: string;
  kind: AuthEmailKind;
  token: string;
  /** The persisted action-token expiry, if the caller has one. */
  expiresAt?: Date | string;
}
export interface SendAuthEmailDependencies { env?: Environment; fetch?: typeof fetch; idempotencyKey?: string; }

/**
 * Bind Resend de-duplication to the exact opaque invitation capability, never
 * the invitation record alone. The header contains only an HMAC digest, not
 * the action-token plaintext.
 */
export function invitationDeliveryIdempotencyKey(invitationId: string, token: string): string {
  return `manifold-invitation-${invitationId}-${hashAuthToken(token).toString("base64url")}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

const EMAIL_COPY: Record<AuthEmailKind, { path: string; subject: string; action: string; label: string }> = {
  activation: { path: "/activate", subject: "Activate your Manifold account", action: "Activate your account", label: "activation" },
  invitation: { path: "/invite", subject: "You are invited to Manifold", action: "Accept your invitation", label: "invitation" },
  "password-reset": { path: "/reset-password", subject: "Reset your Manifold password", action: "Reset your password", label: "password reset" },
};

function expiryCopy(kind: AuthEmailKind, expiresAt: Date | string | undefined): string {
  if (!expiresAt) return `Use this ${EMAIL_COPY[kind].label} link before it expires.`;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw new Error("expiresAt must be a valid date");
  return `This ${EMAIL_COPY[kind].label} link expires at ${date.toISOString()}.`;
}

function emailContent(input: SendAuthEmailInput, origin: string) {
  const copy = EMAIL_COPY[input.kind];
  const path = input.kind === "invitation" ? `${copy.path}/${encodeURIComponent(input.token)}` : `${copy.path}?token=${encodeURIComponent(input.token)}`;
  const url = `${origin}${path}`;
  const expiry = expiryCopy(input.kind, input.expiresAt);
  return { subject: copy.subject, text: `${copy.action}: ${url}\n\n${expiry}`, html: `<p>Hello ${escapeHtml(input.to)},</p><p><a href="${escapeHtml(url)}">${copy.action}</a></p><p>${escapeHtml(expiry)}</p>` };
}

export async function sendAuthEmail(input: SendAuthEmailInput, dependencies: SendAuthEmailDependencies = {}): Promise<void> {
  const env = dependencies.env ?? process.env;
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL must be set");
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const content = emailContent(input, canonicalAuthOrigin(env));
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": dependencies.idempotencyKey ?? `manifold-auth-${randomUUID()}`,
    },
    body: JSON.stringify({ from, to: [input.to], subject: content.subject, html: content.html, text: content.text }),
  });
  if (!response.ok) throw new Error(`Resend email request failed (${response.status})`);
}
