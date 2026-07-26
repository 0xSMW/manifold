import { timingSafeEqual } from "node:crypto";
import { openAesGcm, resolveDataKek, unwrapDek, utf8 } from "@manifold/crypto";
import { executeControlEgress, ControlEgressError } from "@/lib/control-egress";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { auditDeliveryPayload as wirePayload, signedAuditDeliveryHeaders as wireHeaders } from "./audit-delivery-wire";

const MAX_ATTEMPTS = 8;
const MAX_PAYLOAD_BYTES = 48 * 1024;
const LEASE_SECONDS = 60;

type ClaimedJob = {
  id: string; workspace_id: string; destination_id: string; audit_event_id: string; attempt_count: number;
  kind: "webhook" | "siem"; encrypted_endpoint: Uint8Array; encrypted_secret: Uint8Array | null; wrapped_dek: Uint8Array;
  event_id: string; actor_kind: string; actor_id: string | null; action: string; target_kind: string | null; target_id: string | null;
  request_ref: string | null; before_hash: string | null; after_hash: string | null; detail: unknown; chain_hash: Uint8Array | null; created_at: string;
};

export type AuditDeliveryEgress = typeof executeControlEgress;
export interface AuditDeliveryDependencies { egress?: AuditDeliveryEgress; }

class AuditDeliveryError extends Error {
  readonly code: "DELIVERY_CREDENTIAL_UNAVAILABLE" | "DELIVERY_PAYLOAD_TOO_LARGE" | "EGRESS_POLICY";
  constructor(code: "DELIVERY_CREDENTIAL_UNAVAILABLE" | "DELIVERY_PAYLOAD_TOO_LARGE" | "EGRESS_POLICY") {
    super(code);
    this.code = code;
  }
}

function aad(destinationId: string) { return utf8(`manifold:audit-destination:v1:${destinationId}`); }
function backoffSeconds(attempt: number) { return Math.min(3600, 5 * 2 ** Math.min(attempt - 1, 10)); }
function safeError(error: unknown): string {
  if (error instanceof ControlEgressError || error instanceof AuditDeliveryError) return error.code;
  return "DELIVERY_UNAVAILABLE";
}
function isRetryableStatus(status: number) { return status === 408 || status === 429 || status >= 500; }
function internalSecretOk(presented: string | null): boolean {
  const expected = process.env.MANIFOLD_AUDIT_DELIVERY_SECRET;
  if (!presented || !expected) return false;
  const a = Buffer.from(presented); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Exported for the internal worker route; never accept this credential from a browser request. */
export function authorizeAuditDeliveryWorker(presented: string | null): boolean { return internalSecretOk(presented); }

/** The canonical signed export envelope. It contains audit truth, never destination credentials. */
export function auditDeliveryPayload(job: Pick<ClaimedJob, "event_id" | "created_at" | "actor_kind" | "actor_id" | "action" | "target_kind" | "target_id" | "request_ref" | "before_hash" | "after_hash" | "detail" | "chain_hash" | "kind">): Buffer {
  try { return wirePayload({ eventId: job.event_id, createdAt: job.created_at, actorKind: job.actor_kind, actorId: job.actor_id, action: job.action, targetKind: job.target_kind, targetId: job.target_id, requestRef: job.request_ref, beforeHash: job.before_hash, afterHash: job.after_hash, detail: job.detail, chainHash: job.chain_hash, destinationKind: job.kind }, MAX_PAYLOAD_BYTES); }
  catch { throw new AuditDeliveryError("DELIVERY_PAYLOAD_TOO_LARGE"); }
}

function decrypt(job: ClaimedJob): { endpoint: string; secret: string | null } {
  try {
    const dek = unwrapDek(resolveDataKek(process.env.MANIFOLD_DATA_KEK), job.wrapped_dek);
    const endpoint = new TextDecoder().decode(openAesGcm(dek, job.encrypted_endpoint, aad(job.destination_id)));
    const secret = job.encrypted_secret ? new TextDecoder().decode(openAesGcm(dek, job.encrypted_secret, aad(job.destination_id))) : null;
    if (!endpoint) throw new Error("empty endpoint");
    return { endpoint, secret: secret || null };
  } catch { throw new AuditDeliveryError("DELIVERY_CREDENTIAL_UNAVAILABLE"); }
}

export function signedAuditDeliveryHeaders(eventId: string, body: Buffer, secret: string | null): Record<string, string> {
  return wireHeaders(eventId, body, secret);
}

async function claim(workspaceId: string): Promise<ClaimedJob | null> {
  return withWorkspace(workspaceId, async (sql) => {
    // A worker crash consumes an attempt even if it dies before egress. Never revive it forever.
    await sql`UPDATE audit_delivery_job SET status = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
      lease_until = NULL, run_after = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN run_after ELSE now() + interval '5 seconds' END,
      last_error_code = 'DELIVERY_LEASE_EXPIRED', updated_at = now()
      WHERE workspace_id = ${workspaceId} AND status = 'processing' AND lease_until < now()`;
    await sql`UPDATE audit_delivery_job j SET status = 'cancelled', lease_until = NULL, updated_at = now()
      FROM audit_destination d WHERE j.workspace_id = ${workspaceId} AND d.id = j.destination_id AND d.workspace_id = j.workspace_id
        AND (d.status <> 'configured' OR d.disabled_at IS NOT NULL) AND j.status IN ('pending', 'processing')`;
    const rows = await sql<ClaimedJob[]>`
      WITH next AS (
        SELECT j.id FROM audit_delivery_job j JOIN audit_destination d ON d.id = j.destination_id AND d.workspace_id = j.workspace_id
        WHERE j.workspace_id = ${workspaceId} AND j.status = 'pending' AND j.attempt_count < ${MAX_ATTEMPTS} AND j.run_after <= now()
          AND d.status = 'configured' AND d.disabled_at IS NULL
        ORDER BY j.run_after, j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ), claimed AS (
        UPDATE audit_delivery_job j SET status = 'processing', lease_until = now() + (${LEASE_SECONDS}::text || ' seconds')::interval,
          attempt_count = attempt_count + 1, last_attempt_at = now(), updated_at = now()
        FROM next WHERE j.id = next.id RETURNING j.*
      )
      SELECT j.id, j.workspace_id, j.destination_id, j.audit_event_id, j.attempt_count, d.kind, d.encrypted_endpoint,
        d.encrypted_secret, dek.wrapped_dek, e.id AS event_id, e.actor_kind, e.actor_id, e.action, e.target_kind, e.target_id,
        e.request_ref, e.before_hash, e.after_hash, e.detail, e.chain_hash, e.created_at
      FROM claimed j JOIN audit_destination d ON d.id = j.destination_id AND d.workspace_id = j.workspace_id
      JOIN data_encryption_key dek ON dek.id = d.dek_id AND dek.workspace_id = d.workspace_id AND dek.status IN ('active', 'retiring')
      JOIN audit_event e ON e.id = j.audit_event_id AND e.workspace_id = j.workspace_id
      WHERE d.status = 'configured' AND d.disabled_at IS NULL`;
    return rows[0] ?? null;
  });
}

async function finish(workspaceId: string, job: ClaimedJob, outcome: "delivered" | "retry" | "dead", statusCode: number | null, errorCode: string | null): Promise<boolean> {
  return withWorkspace(workspaceId, async (sql) => {
    const rows = outcome === "delivered"
      ? await sql<{ id: string }[]>`UPDATE audit_delivery_job SET status = 'delivered', delivered_at = now(), lease_until = NULL, last_error_code = NULL, updated_at = now()
          WHERE id = ${job.id} AND workspace_id = ${workspaceId} AND status = 'processing' AND attempt_count = ${job.attempt_count} RETURNING id`
      : outcome === "dead"
        ? await sql<{ id: string }[]>`UPDATE audit_delivery_job SET status = 'dead', lease_until = NULL, last_error_code = ${errorCode}, updated_at = now()
            WHERE id = ${job.id} AND workspace_id = ${workspaceId} AND status = 'processing' AND attempt_count = ${job.attempt_count} RETURNING id`
        : await sql<{ id: string }[]>`UPDATE audit_delivery_job SET status = 'pending', lease_until = NULL, last_error_code = ${errorCode},
            run_after = now() + (${backoffSeconds(job.attempt_count)}::text || ' seconds')::interval, updated_at = now()
            WHERE id = ${job.id} AND workspace_id = ${workspaceId} AND status = 'processing' AND attempt_count = ${job.attempt_count} RETURNING id`;
    if (!rows[0]) return false; // A newer lease owns this job; do not overwrite its truthful state.
    await sql`INSERT INTO audit_delivery_attempt (id, workspace_id, job_id, attempt_number, outcome, status_code, error_code)
      VALUES (${genId("ada")}, ${workspaceId}, ${job.id}, ${job.attempt_count}, ${outcome}, ${statusCode}, ${errorCode})`;
    return true;
  });
}

export async function deliverAuditJob(job: ClaimedJob, dependencies: AuditDeliveryDependencies = {}): Promise<{ outcome: "delivered" | "retry" | "dead"; statusCode: number | null; errorCode: string | null }> {
  let outcome: "delivered" | "retry" | "dead" = "retry"; let statusCode: number | null = null; let errorCode: string | null = null;
  try {
    // The last operation before egress: plaintext is never stored or logged.
    const credentials = decrypt(job); const body = auditDeliveryPayload(job);
    let endpoint: URL;
    try { endpoint = new URL(credentials.endpoint); } catch { throw new AuditDeliveryError("EGRESS_POLICY"); }
    const response = await (dependencies.egress ?? executeControlEgress)({ url: endpoint.toString(), allowedHosts: [endpoint.hostname], method: "POST", body: body as unknown as BodyInit,
      headers: signedAuditDeliveryHeaders(job.event_id, body, credentials.secret) }, { maxResponseBytes: 8 * 1024, maxRedirects: 0, timeoutMs: 8_000 });
    statusCode = response.status;
    outcome = response.status >= 200 && response.status < 300 ? "delivered" : isRetryableStatus(response.status) && job.attempt_count < MAX_ATTEMPTS ? "retry" : "dead";
    errorCode = outcome === "delivered" ? null : `HTTP_${response.status}`;
  } catch (error) {
    errorCode = safeError(error);
    const permanent = errorCode === "EGRESS_POLICY" || errorCode === "EGRESS_REDIRECT" || errorCode === "DELIVERY_CREDENTIAL_UNAVAILABLE" || errorCode === "DELIVERY_PAYLOAD_TOO_LARGE";
    outcome = permanent || job.attempt_count >= MAX_ATTEMPTS ? "dead" : "retry";
  }
  return { outcome, statusCode, errorCode };
}

export async function drainAuditDelivery(workspaceId: string, limit = 10, dependencies: AuditDeliveryDependencies = {}): Promise<{ claimed: number; delivered: number; retried: number; dead: number }> {
  const result = { claimed: 0, delivered: 0, retried: 0, dead: 0 };
  for (let index = 0; index < Math.min(Math.max(limit, 1), 50); index += 1) {
    const job = await claim(workspaceId); if (!job) break; result.claimed += 1;
    const { outcome, statusCode, errorCode } = await deliverAuditJob(job, dependencies);
    if (!await finish(workspaceId, job, outcome, statusCode, errorCode)) continue;
    if (outcome === "delivered") result.delivered += 1; else if (outcome === "dead") result.dead += 1; else result.retried += 1;
  }
  return result;
}
