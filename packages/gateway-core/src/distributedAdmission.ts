/**
 * Strict admission authority contract. The runtime adapter owns the distributed
 * implementation (for example Postgres or Redis); gateway-core only owns the
 * lifecycle boundary around its grant.
 */
export interface DistributedAdmissionInput {
  installationId: string;
  virtualKeyId: string;
  traceId: string;
  estimatedTokens: number;
  rateLimit?: {
    rpm?: number;
    tpm?: number;
    burst?: number;
  };
}

export interface DistributedAdmissionDenied {
  allowed: false;
  reason: "rpm" | "tpm" | "concurrency" | "unavailable";
  retryAfterSeconds: number;
}

export interface DistributedAdmissionGrant {
  allowed: true;
  /** Cancels provider work when the authority revokes an active grant. */
  signal?: AbortSignal;
  /** Releases the held permit exactly once when the client response settles. */
  release(): Promise<void>;
}

export type DistributedAdmissionDecision = DistributedAdmissionDenied | DistributedAdmissionGrant;

export type DistributedAdmission = (
  input: DistributedAdmissionInput,
) => Promise<DistributedAdmissionDecision>;
