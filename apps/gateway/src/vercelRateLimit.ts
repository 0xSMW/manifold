import { LocalRateLimiter } from "@manifold/gateway-core";

interface ConsumeInput {
  installationId: string;
  virtualKeyId: string;
  estimatedTokens: number;
  rpm?: number;
  tpm?: number;
  burst?: number;
}

const UNLIMITED = 1_000_000_000;
const MAX_CONFIGS = 256;

/**
 * Groups keys by their signed limit tuple so module state stays bounded while each bucket remains
 * keyed by installation + stable virtual-key id. Fleet-wide burst can scale with warm isolate
 * count; hard monetary limits remain authoritative in Postgres.
 */
export class VercelRateLimitRegistry {
  private readonly limiters = new Map<string, LocalRateLimiter>();

  consume(input: ConsumeInput): ReturnType<LocalRateLimiter["consume"]> {
    const rpm = input.rpm ?? UNLIMITED;
    const tpm = input.tpm ?? UNLIMITED;
    const signature = `${rpm}:${tpm}:${input.burst ?? ""}`;
    let limiter = this.limiters.get(signature);
    if (!limiter) {
      if (this.limiters.size >= MAX_CONFIGS) {
        const oldest = this.limiters.keys().next().value as string | undefined;
        if (oldest) this.limiters.delete(oldest);
      }
      limiter = new LocalRateLimiter({
        rpm,
        tpm,
        ...(input.burst !== undefined ? { burst: input.burst } : {}),
        maxEntries: 10_000,
      });
      this.limiters.set(signature, limiter);
    } else {
      this.limiters.delete(signature);
      this.limiters.set(signature, limiter);
    }
    return limiter.consume(input);
  }
}
