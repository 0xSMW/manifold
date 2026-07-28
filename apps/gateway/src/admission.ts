/**
 * Strict, fleet-wide gateway admission backed by Postgres.
 *
 * This adapter deliberately uses database time and short transactions.  It is
 * an authority for a configured strict-installation mode; it is not a cache or
 * a best-effort replacement for the local Fluid guards.
 */
import { setWorkspaceGuc, type Sql } from "@manifold/database";
import type {
  DistributedAdmission,
  DistributedAdmissionDecision,
  DistributedAdmissionInput,
} from "@manifold/gateway-core";

export type {
  DistributedAdmission,
  DistributedAdmissionDecision,
  DistributedAdmissionInput,
} from "@manifold/gateway-core";

export interface PostgresDistributedAdmissionOptions {
  sql: Sql;
  workspaceId: string;
  /** Maximum active streams for this installation. */
  installationConcurrency: number;
  /** Maximum active streams for one virtual key. */
  perKeyConcurrency: number;
  /** Must outlive the 300 second Vercel gateway max duration. */
  leaseTtlMs?: number;
}

interface ClockRow { now: Date; }
interface LeaseRow { state: "active" | "released" | "expired"; }
interface CountRow { count: string; }
interface OwnershipRow { installation_id: string; }
interface BucketRow {
  request_tokens: number;
  token_tokens: number;
  refilled_at: Date;
  config_fingerprint: string;
}

const MIN_LEASE_TTL_MS = 300_001;
const DEFAULT_LEASE_TTL_MS = 330_000;

function positiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function nonEmpty(name: string, value: string): void {
  if (value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
}

interface NormalizedRateLimit {
  rpm: number | null;
  tpm: number | null;
  burst: number | null;
  fingerprint: string;
}

function normalizeRateLimit(value: DistributedAdmissionInput["rateLimit"]): NormalizedRateLimit {
  if (!value) return { rpm: null, tpm: null, burst: null, fingerprint: "none" };
  const rpm = value.rpm ?? null;
  const tpm = value.tpm ?? null;
  const burst = value.burst ?? rpm;
  if (rpm !== null) positiveSafeInteger("rateLimit.rpm", rpm);
  if (tpm !== null) positiveSafeInteger("rateLimit.tpm", tpm);
  if (burst !== null) positiveSafeInteger("rateLimit.burst", burst);
  if (burst !== null && rpm === null) {
    throw new TypeError("rateLimit.burst requires rateLimit.rpm");
  }
  return { rpm, tpm, burst, fingerprint: `v1:${rpm ?? "-"}:${tpm ?? "-"}:${burst ?? "-"}` };
}

function asNumber(value: number | string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw new TypeError("database returned a non-finite bucket balance");
  return result;
}

/**
 * Postgres authority for strict RPM, TPM, and active-stream caps. All mutable
 * state is workspace-RLS scoped, and all comparisons/refills use
 * `clock_timestamp()` from the same transaction.
 */
export class PostgresDistributedAdmission {
  private readonly sql: Sql;
  private readonly workspaceId: string;
  private readonly installationConcurrency: number;
  private readonly perKeyConcurrency: number;
  private readonly leaseTtlMs: number;

  constructor(options: PostgresDistributedAdmissionOptions) {
    nonEmpty("workspaceId", options.workspaceId);
    positiveSafeInteger("installationConcurrency", options.installationConcurrency);
    positiveSafeInteger("perKeyConcurrency", options.perKeyConcurrency);
    const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    positiveSafeInteger("leaseTtlMs", leaseTtlMs);
    if (leaseTtlMs < MIN_LEASE_TTL_MS) {
      throw new TypeError(`leaseTtlMs must exceed the 300 second gateway duration (${MIN_LEASE_TTL_MS}ms minimum)`);
    }
    this.sql = options.sql;
    this.workspaceId = options.workspaceId;
    this.installationConcurrency = options.installationConcurrency;
    this.perKeyConcurrency = options.perKeyConcurrency;
    this.leaseTtlMs = leaseTtlMs;
  }

  async admit(input: DistributedAdmissionInput): Promise<DistributedAdmissionDecision> {
    try {
      this.validateInput(input);
      const rate = normalizeRateLimit(input.rateLimit);
      const granted = await this.sql.begin(async (tx) => {
        await setWorkspaceGuc(tx, this.workspaceId);
        // Prove both foreign identities belong to this tenant before creating
        // operational state. The foreign keys alone allow an otherwise-valid
        // installation/key pair from a different workspace.
        const ownership = await tx<OwnershipRow[]>`
          SELECT i.id AS installation_id
          FROM gateway_installation AS i
          JOIN virtual_key AS k ON k.id = ${input.virtualKeyId}
          JOIN gateway_ingress_profile AS p
            ON p.id = k.profile_id
           AND p.workspace_id = k.workspace_id
           AND p.installation_id = i.id
          WHERE i.id = ${input.installationId}
            AND i.workspace_id = ${this.workspaceId}
            AND k.workspace_id = ${this.workspaceId}
          LIMIT 1
        `;
        if (!ownership[0]) throw new TypeError("installation or virtual key is unavailable in this workspace");
        // Lock ordering is globally fixed: installation before virtual key.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`admission:installation:${input.installationId}`}, 0))`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`admission:key:${input.installationId}:${input.virtualKeyId}`}, 0))`;
        const clock = await tx<ClockRow[]>`SELECT clock_timestamp() AS now`;
        const now = clock[0]?.now;
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("database did not return clock time");

        await tx`
          UPDATE gateway_concurrency_lease
          SET state = 'expired', updated_at = ${now}
          WHERE installation_id = ${input.installationId}
            AND state = 'active' AND expires_at <= ${now}
        `;

        // A replay while its lease remains active owns the same admission and
        // cannot consume either a second slot or a second rate token.
        const existing = await tx<LeaseRow[]>`
          SELECT state FROM gateway_concurrency_lease
          WHERE id = ${input.traceId}
          FOR UPDATE
        `;
        if (existing[0]?.state === "active") return true;
        // A terminal retry with the same trace must never dispatch a second
        // provider call. Its idempotent release is already complete.
        if (existing[0]) return true;

        const global = await tx<CountRow[]>`
          SELECT count(*)::text AS count FROM gateway_concurrency_lease
          WHERE installation_id = ${input.installationId} AND state = 'active' AND expires_at > ${now}
        `;
        const perKey = await tx<CountRow[]>`
          SELECT count(*)::text AS count FROM gateway_concurrency_lease
          WHERE installation_id = ${input.installationId} AND virtual_key_id = ${input.virtualKeyId}
            AND state = 'active' AND expires_at > ${now}
        `;
        if (Number(global[0]?.count ?? "NaN") >= this.installationConcurrency ||
            Number(perKey[0]?.count ?? "NaN") >= this.perKeyConcurrency) {
          return false as const;
        }

        if (rate.rpm !== null || rate.tpm !== null) {
          await tx`
            INSERT INTO gateway_rate_limit_state
              (workspace_id, installation_id, virtual_key_id, config_fingerprint,
               request_tokens, token_tokens, refilled_at, updated_at)
            VALUES (${this.workspaceId}, ${input.installationId}, ${input.virtualKeyId},
              ${rate.fingerprint}, ${rate.burst ?? 0}, ${rate.tpm ?? 0}, ${now}, ${now})
            ON CONFLICT (installation_id, virtual_key_id) DO NOTHING
          `;
          const buckets = await tx<BucketRow[]>`
            SELECT request_tokens, token_tokens, refilled_at, config_fingerprint
            FROM gateway_rate_limit_state
            WHERE installation_id = ${input.installationId} AND virtual_key_id = ${input.virtualKeyId}
            FOR UPDATE
          `;
          const bucket = buckets[0];
          if (!bucket) throw new TypeError("rate bucket disappeared during admission");
          const elapsedMs = Math.max(0, now.getTime() - new Date(bucket.refilled_at).getTime());
          const requestCap = rate.burst ?? 0;
          const tokenCap = rate.tpm ?? 0;
          // Config changes clamp existing balances. They do not reset a new burst.
          const requestTokens = rate.rpm === null ? 0 : Math.min(
            requestCap,
            Math.max(0, asNumber(bucket.request_tokens)) + (elapsedMs * rate.rpm) / 60_000,
          );
          const tokenTokens = rate.tpm === null ? 0 : Math.min(
            tokenCap,
            Math.max(0, asNumber(bucket.token_tokens)) + (elapsedMs * rate.tpm) / 60_000,
          );
          if (rate.rpm !== null && requestTokens < 1) return "rpm" as const;
          if (rate.tpm !== null && tokenTokens < input.estimatedTokens) return "tpm" as const;
          await tx`
            UPDATE gateway_rate_limit_state
            SET config_fingerprint = ${rate.fingerprint},
                request_tokens = ${rate.rpm === null ? 0 : requestTokens - 1},
                token_tokens = ${rate.tpm === null ? 0 : tokenTokens - input.estimatedTokens},
                refilled_at = ${now}, updated_at = ${now}
            WHERE installation_id = ${input.installationId} AND virtual_key_id = ${input.virtualKeyId}
          `;
        }

        await tx`
          INSERT INTO gateway_concurrency_lease
            (id, workspace_id, installation_id, virtual_key_id, state, expires_at, created_at, updated_at)
          VALUES (${input.traceId}, ${this.workspaceId}, ${input.installationId}, ${input.virtualKeyId},
                  'active', ${new Date(now.getTime() + this.leaseTtlMs)}, ${now}, ${now})
        `;
        return true;
      });
      if (granted === true) return { allowed: true, release: () => this.release(input.traceId) };
      if (granted === "rpm" || granted === "tpm") {
        return { allowed: false, reason: granted, retryAfterSeconds: 1 };
      }
      return { allowed: false, reason: "concurrency", retryAfterSeconds: 1 };
    } catch {
      return { allowed: false, reason: "unavailable", retryAfterSeconds: 1 };
    }
  }

  /** Convenient port binding for GatewayContext. */
  readonly admission: DistributedAdmission = (input) => this.admit(input);

  /**
   * Prove the strict admission schema and manifold_app RLS grants are usable
   * before readiness turns green. This does not create or mutate admission
   * state.
   */
  async checkReady(installationId: string): Promise<void> {
    nonEmpty("installationId", installationId);
    await this.sql.begin(async (tx) => {
      await setWorkspaceGuc(tx, this.workspaceId);
      const bindings = await tx<{ installation_id: string }[]>`
        SELECT i.id AS installation_id
        FROM gateway_installation AS i
        WHERE i.id = ${installationId}
          AND i.workspace_id = ${this.workspaceId}
          AND i.disabled_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM gateway_ingress_profile AS p
            WHERE p.installation_id = i.id
              AND p.workspace_id = ${this.workspaceId}
              AND p.disabled_at IS NULL
          )
        LIMIT 1
      `;
      if (!bindings[0]) throw new Error("configured gateway installation is unavailable");
      await tx`SELECT 1 FROM gateway_rate_limit_state LIMIT 0`;
      await tx`SELECT 1 FROM gateway_concurrency_lease LIMIT 0`;
    });
  }

  async release(traceId: string): Promise<void> {
    try {
      nonEmpty("traceId", traceId);
      await this.sql.begin(async (tx) => {
        await setWorkspaceGuc(tx, this.workspaceId);
        const clock = await tx<ClockRow[]>`SELECT clock_timestamp() AS now`;
        const now = clock[0]?.now;
        if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("database did not return clock time");
        await tx`
          UPDATE gateway_concurrency_lease
          SET state = 'released', released_at = ${now}, updated_at = ${now}
          WHERE id = ${traceId} AND state = 'active'
        `;
      });
    } catch {
      // Release is best-effort and idempotent; the bounded lease is the crash
      // recovery backstop. The next strict admission reclaims expired leases.
    }
  }

  private validateInput(input: DistributedAdmissionInput): void {
    nonEmpty("installationId", input.installationId);
    nonEmpty("virtualKeyId", input.virtualKeyId);
    nonEmpty("traceId", input.traceId);
    if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens < 0) {
      throw new TypeError("estimatedTokens must be a non-negative safe integer");
    }
  }
}
