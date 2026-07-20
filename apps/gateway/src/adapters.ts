// apps/gateway adapters — the thin Node implementations of the platform ports (SPEC §4.4).
// This is the ONLY layer allowed to touch node:* / platform globals; gateway-core stays pure.
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { isIP } from "node:net";
import { sealAesGcm as cryptoSealAesGcm, openAesGcm as cryptoOpenAesGcm } from "@manifold/crypto";
import type {
  BudgetReserveInput,
  BudgetReserveResult,
  BudgetReserver,
  Clock,
  Crypto,
  Fetcher,
  IngestSink,
  ObservationEvent,
  Snapshot,
  SnapshotStore,
} from "@manifold/ports";
import { isPrivateIp, schemeAllowed, type SsrfPolicy, STRICT_SSRF } from "@manifold/gateway-core";
import { assertSnapshotTrusted } from "./snapshotVerify.ts";

/** node:crypto-backed Crypto port (§14.3). */
export class NodeCrypto implements Crypto {
  async hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHmac("sha256", key).update(msg).digest());
  }
  randomId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "")}`;
  }
  // Delegate to the attack-tested @manifold/crypto (same iv|ct|tag layout) so the
  // seal/open path gets its key-length assert, short-blob check and authTagLength
  // pinning for free — no second AES implementation to keep in sync (§14.3).
  sealAesGcm(dek: Uint8Array, pt: Uint8Array): Uint8Array {
    return new Uint8Array(cryptoSealAesGcm(dek, pt));
  }
  openAesGcm(dek: Uint8Array, sealed: Uint8Array): Uint8Array {
    return new Uint8Array(cryptoOpenAesGcm(dek, sealed));
  }
}

/** Wall-clock Clock port. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * IngestSink that appends one JSON line per observation event (§8.3). Stand-in for
 * Vercel after()+job_ledger / the Cloudflare Queue.
 */
export class JsonlIngestSink implements IngestSink {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async emit(event: ObservationEvent): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(event)}\n`);
  }
}

/**
 * SnapshotStore that loads a signed snapshot blob from a local JSON file.
 * §7.3: the snapshot is VERIFIED on load — recompute the canonical contentHash and ed25519-verify
 * meta.signature against the pinned public key (env MANIFOLD_SNAPSHOT_PUBLIC_KEY, base64). A forged
 * snapshot (rewritten routes/keys/baseUrl/ciphertext) is rejected (throw → fail closed). When no
 * key is pinned, an unsigned snapshot is allowed with a loud warning (DEV escape hatch).
 */
export class SnapshotFileStore implements SnapshotStore {
  private readonly snapshot: Snapshot;
  constructor(path: string, publicKeyBase64?: string) {
    this.snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
    assertSnapshotTrusted(this.snapshot, publicKeyBase64);
  }
  async loadActive(_installationId: string): Promise<Snapshot> {
    return this.snapshot;
  }
}

/**
 * BudgetReserver adapter (SPEC §16.3, ADR-0012/§4.4). The port's single `reserve` maps to the
 * one strong-consistency transaction in @manifold/budget (`committed + reserved + est ≤ limit`).
 *
 * The gateway core calls the PORT only — it never imports @manifold/budget or a DB driver (§4.2).
 * The concrete transaction is injected here as `reserveFn` so this adapter carries no `Sql` and no
 * driver import of its own: production wiring binds `reserveFn` to `budget.reserve(sql, …)` (which
 * also resolves workspace + fixed-window bucket from the account), exactly as `makeSecretResolver`
 * is the seam for credential decryption. Tests inject the in-memory FakeBudgetReserver instead.
 */
export class BudgetReserverAdapter implements BudgetReserver {
  // NOTE: explicit field assignment (no constructor parameter property) — Node runs this file
  // under strip-only TS, which rejects parameter properties (same reason the other adapters here
  // assign fields by hand).
  private readonly reserveFn: (input: BudgetReserveInput) => Promise<BudgetReserveResult>;
  constructor(reserveFn: (input: BudgetReserveInput) => Promise<BudgetReserveResult>) {
    this.reserveFn = reserveFn;
  }
  reserve(input: BudgetReserveInput): Promise<BudgetReserveResult> {
    return this.reserveFn(input);
  }
}

/**
 * Is a resolved IP literal loopback / link-local / RFC-1918 / unique-local? (§14.4)
 * Delegates to gateway-core's single classifier so the literal-URL check and the
 * resolved-address check share one correct implementation (no duplicate blind spots).
 */
export function isPrivateAddress(ip: string): boolean {
  return isPrivateIp(ip);
}

/**
 * Provider-egress Fetcher (§14.4): https-only, DNS-resolves the host once and rejects private
 * destinations (SSRF defense in depth — gateway-core already applied the per-target allowlist).
 * NOTE(§14.4): true DNS pinning (connect to the exact validated address, no rebind) needs a
 * custom dispatcher; this skeleton resolves-then-checks-then-fetches, which closes the common
 * cases. Loopback/http are permitted only when the injected policy relaxes them (local tests).
 */
export class EgressFetcher implements Fetcher {
  private readonly policy: SsrfPolicy;
  constructor(policy: SsrfPolicy = STRICT_SSRF) {
    this.policy = policy;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Reuse gateway-core's single scheme/policy predicate so this gate can never
    // drift from ssrfCheck's (§14.4); the post-DNS resolved-IP recheck below stays
    // as intentional defense-in-depth against name→private-address rebinding.
    const scheme = schemeAllowed(url, this.policy);
    if (!scheme.ok) throw new Error(`egress: ${scheme.reason}`);
    if (!this.policy.allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const address = isIP(host) ? host : (await lookup(host)).address;
      if (isPrivateAddress(address)) throw new Error(`egress: blocked private address ${address}`);
    }
    return globalThis.fetch(req);
  }
}
