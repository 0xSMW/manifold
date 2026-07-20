// apps/gateway adapters — the thin Node implementations of the platform ports (SPEC §4.4).
// This is the ONLY layer allowed to touch node:* / platform globals; gateway-core stays pure.
import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { isIP } from "node:net";
import type {
  Clock,
  Crypto,
  Fetcher,
  IngestSink,
  ObservationEvent,
  Snapshot,
  SnapshotStore,
} from "@manifold/ports";
import { isPrivateIp, type SsrfPolicy, STRICT_SSRF } from "@manifold/gateway-core";

/** node:crypto-backed Crypto port (§14.3). */
export class NodeCrypto implements Crypto {
  async hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHmac("sha256", key).update(msg).digest());
  }
  randomId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "")}`;
  }
  sealAesGcm(dek: Uint8Array, pt: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([iv, ct, tag]));
  }
  openAesGcm(dek: Uint8Array, sealed: Uint8Array): Uint8Array {
    const buf = Buffer.from(sealed);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
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
 * TODO(§7.3): verify meta.signature (ed25519) + recompute contentHash before serving; the real
 * store fails closed to the last-good snapshot on a bad signature.
 */
export class SnapshotFileStore implements SnapshotStore {
  private readonly snapshot: Snapshot;
  constructor(path: string) {
    this.snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  }
  async loadActive(_installationId: string): Promise<Snapshot> {
    return this.snapshot;
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
    const scheme = url.protocol.replace(/:$/, "");
    if (scheme === "http") {
      if (!this.policy.allowInsecureHttp) throw new Error("egress: scheme must be https");
    } else if (scheme !== "https") {
      throw new Error(`egress: scheme '${scheme}' not allowed`);
    }
    if (!this.policy.allowPrivate) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const address = isIP(host) ? host : (await lookup(host)).address;
      if (isPrivateAddress(address)) throw new Error(`egress: blocked private address ${address}`);
    }
    return globalThis.fetch(req);
  }
}
