// @manifold/ports/testing — in-memory fakes for every port (SPEC §4.4, §21).
// Back unit tests and deterministic storage tests. Uses only Web-standard globals
// (crypto.subtle, TextEncoder) — no node:* imports — so it runs unchanged under Node
// and Workers, keeping ports platform-free.
import type {
  Clock,
  Crypto,
  Fetcher,
  IngestSink,
  ObservationEvent,
  Snapshot,
  SnapshotStore,
} from "./index.js";

/** Lower-case hex encode. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** SnapshotStore fake: serves a single in-memory snapshot. */
export class FakeSnapshotStore implements SnapshotStore {
  constructor(private snapshot: Snapshot) {}
  async loadActive(_installationId: string): Promise<Snapshot> {
    return this.snapshot;
  }
  set(snapshot: Snapshot): void {
    this.snapshot = snapshot;
  }
}

/** IngestSink fake: records every emitted event so tests can assert on them. */
export class FakeIngestSink implements IngestSink {
  readonly events: ObservationEvent[] = [];
  async emit(event: ObservationEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Clock fake: returns a fixed, optionally advanceable, instant. */
export class FixedClock implements Clock {
  constructor(private t: Date = new Date("2026-07-20T00:00:00.000Z")) {}
  now(): Date {
    return this.t;
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/**
 * Crypto fake. hmacSha256 is a real HMAC-SHA256 via WebCrypto (deterministic, so the
 * key-hash a test stores in a snapshot matches what authenticate() recomputes). The
 * AES helpers are a trivial reversible XOR stand-in — the passthrough skeleton resolves
 * provider secrets from env (§14.3 TODO), so real GCM is not on this hot path.
 */
export class FakeCrypto implements Crypto {
  private counter = 0;
  async hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as unknown as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", cryptoKey, msg as unknown as BufferSource);
    return new Uint8Array(sig);
  }
  randomId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_fake${this.counter.toString().padStart(6, "0")}`;
  }
  sealAesGcm(dek: Uint8Array, pt: Uint8Array): Uint8Array {
    return xor(dek, pt);
  }
  openAesGcm(dek: Uint8Array, ct: Uint8Array): Uint8Array {
    return xor(dek, ct);
  }
}

function xor(key: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
  return out;
}

/**
 * Fetcher fake: routes to a supplied handler. Records the last request (headers/url/body)
 * so tests can assert what was forwarded upstream (e.g. inbound Authorization stripped).
 */
export class FakeFetcher implements Fetcher {
  lastRequest: Request | null = null;
  lastHeaders: Record<string, string> = {};
  constructor(private handler: (req: Request) => Promise<Response> | Response) {}
  async fetch(req: Request): Promise<Response> {
    this.lastRequest = req;
    this.lastHeaders = Object.fromEntries(req.headers.entries());
    return this.handler(req);
  }
}

/** Convenience: hex(HMAC(pepper, plaintextKey)) using the fake crypto, for building test snapshots. */
export async function keyedHashHex(
  crypto: Crypto,
  pepper: Uint8Array,
  plaintextKey: string,
): Promise<string> {
  const digest = await crypto.hmacSha256(pepper, new TextEncoder().encode(plaintextKey));
  return toHex(digest);
}
