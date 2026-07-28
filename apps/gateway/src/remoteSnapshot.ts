// Remote signed snapshot loader. The control plane remains the source of truth; this adapter
// keeps only a short-lived, verified last-known-good copy in the gateway isolate.
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import type { Clock, Snapshot, SnapshotStore } from "@manifold/ports";
import {
  assertSnapshotTrusted,
  validateSnapshotPublicKeys,
  type SnapshotPublicKeyring,
} from "./snapshotVerify.js";

export interface RemoteSnapshotStoreOptions {
  /** Control-plane origin, for example https://control.example. */
  controlPlaneBaseUrl: string;
  /** Base64 PKCS#8 Ed25519 installation identity private key. Never included in errors. */
  installationPrivateKeyBase64: string;
  /** Legacy base64 Ed25519 public key pinned by this gateway. */
  publicKeyBase64?: string;
  /** Rotation-safe signing-key-id to base64 Ed25519 public key map. */
  publicKeys?: SnapshotPublicKeyring;
  /** Optional full accelerator endpoint, attempted before the control-plane endpoint. */
  acceleratorUrl?: string;
  /** Optional accelerator-specific bearer token. The control-plane token is never sent there. */
  acceleratorBearerToken?: string;
  /** How long a verified entry is fresh. Defaults to 5 seconds. */
  freshnessTtlMs?: number;
  /** Age after which even a verified last-known-good entry must not be served. Defaults to 60 seconds. */
  maxStaleMs?: number;
  /** Per-request remote timeout. Defaults to 2 seconds. */
  timeoutMs?: number;
  /** Maximum JSON response size. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  clock?: Clock;
}

interface CachedSnapshot {
  snapshot: Snapshot;
  fetchedAtMs: number;
}

/** A verified snapshot together with the time its current content was last verified remotely. */
export interface VerifiedActiveSnapshot {
  snapshot: Snapshot;
  verifiedAtMs: number;
}

// Module state is intentionally per isolate. Include the authoritative origin in the key so
// independent gateway configurations in one process cannot share an installation's snapshot.
const cache = new Map<string, CachedSnapshot>();
const refreshes = new Map<string, Promise<Snapshot>>();

const DEFAULT_FRESHNESS_TTL_MS = 5_000;
const DEFAULT_MAX_STALE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Cache keys must not contain raw trust material. Hashing a sorted representation keeps equivalent
 * JSON keyrings together while separating overlap/retirement configurations in a warm isolate.
 */
function trustFingerprint(publicKeyBase64: string | undefined, publicKeys: SnapshotPublicKeyring | undefined): string {
  const material = publicKeys
    ? Object.entries(publicKeys).sort(([a], [b]) => a.localeCompare(b))
    : publicKeyBase64 ?? "";
  return createHash("sha256").update(JSON.stringify(material)).digest("base64url");
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error("remote snapshot timing option must be a non-negative finite number");
  return value;
}

function positiveBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error("maxResponseBytes must be a positive safe integer");
  return result;
}

function controlPlaneEndpoint(baseUrl: string, installationId: string): string {
  const url = new URL("api/v1/config/active", `${baseUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("installationId", installationId);
  return url.toString();
}

function acceleratorEndpoint(baseUrl: string, installationId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("installationId", installationId);
  return url.toString();
}

async function readResponseJson(response: Response, maxBytes: number): Promise<Snapshot> {
  if (!response.ok) throw new Error("remote snapshot response was unsuccessful");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Error("remote snapshot response exceeded size limit");
  }
  if (!response.body) throw new Error("remote snapshot response had no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        throw new Error("remote snapshot response exceeded size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Snapshot;
  } catch {
    throw new Error("remote snapshot response was not valid JSON");
  }
}

/** A SnapshotStore backed by the signed control-plane active-snapshot endpoint. */
export class RemoteSnapshotStore implements SnapshotStore {
  private readonly controlPlaneBaseUrl: string;
  private readonly installationPrivateKeyBase64: string;
  private readonly publicKeyBase64?: string;
  private readonly publicKeys?: SnapshotPublicKeyring;
  private readonly trustFingerprint: string;
  private readonly acceleratorUrl?: string;
  private readonly acceleratorBearerToken?: string;
  private readonly freshnessTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;

  constructor(options: RemoteSnapshotStoreOptions) {
    this.controlPlaneBaseUrl = options.controlPlaneBaseUrl;
    this.installationPrivateKeyBase64 = options.installationPrivateKeyBase64;
    this.publicKeyBase64 = options.publicKeyBase64;
    this.publicKeys = options.publicKeys && validateSnapshotPublicKeys(options.publicKeys);
    this.trustFingerprint = trustFingerprint(this.publicKeyBase64, this.publicKeys);
    this.acceleratorUrl = options.acceleratorUrl;
    this.acceleratorBearerToken = options.acceleratorBearerToken;
    this.freshnessTtlMs = positiveMs(options.freshnessTtlMs, DEFAULT_FRESHNESS_TTL_MS);
    this.maxStaleMs = positiveMs(options.maxStaleMs, DEFAULT_MAX_STALE_MS);
    this.timeoutMs = positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveBytes(options.maxResponseBytes);
    this.fetchFn = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => new Date() };
    // Validate eagerly, without echoing either sensitive configuration value.
    const controlPlane = new URL(this.controlPlaneBaseUrl);
    if (controlPlane.pathname !== "/" || controlPlane.search || controlPlane.hash) {
      throw new Error("controlPlaneBaseUrl must be an origin without a path, query, or fragment");
    }
    if (this.acceleratorUrl) new URL(this.acceleratorUrl);
    if (!this.installationPrivateKeyBase64 || (!this.publicKeyBase64 && !this.publicKeys)) {
      throw new Error("installation authentication and snapshot verification trust are required");
    }
  }

  async loadActive(installationId: string): Promise<Snapshot> {
    const key = `${this.controlPlaneBaseUrl}\u0000${installationId}\u0000${this.trustFingerprint}`;
    const now = this.clock.now().getTime();
    const existing = cache.get(key);
    if (
      existing &&
      now - existing.fetchedAtMs <= this.freshnessTtlMs &&
      now - existing.fetchedAtMs <= this.maxStaleMs
    ) {
      return existing.snapshot;
    }

    const inFlight = refreshes.get(key);
    if (inFlight) return inFlight;
    const refresh = this.refresh(key, installationId, existing, now);
    refreshes.set(key, refresh);
    try {
      return await refresh;
    } finally {
      if (refreshes.get(key) === refresh) refreshes.delete(key);
    }
  }

  /**
   * Load an active snapshot and report the time of its last successful remote
   * verification. Readiness must use this rather than immutable publication
   * metadata: an unchanged, valid configuration can be verified repeatedly.
   */
  async checkReady(installationId: string): Promise<VerifiedActiveSnapshot> {
    const snapshot = await this.loadActive(installationId);
    const key = `${this.controlPlaneBaseUrl}\u0000${installationId}\u0000${this.trustFingerprint}`;
    const verified = cache.get(key);
    const now = this.clock.now().getTime();
    if (!verified || verified.snapshot !== snapshot || now - verified.fetchedAtMs > this.maxStaleMs) {
      throw new Error("no fresh verified remote snapshot is available");
    }
    return { snapshot, verifiedAtMs: verified.fetchedAtMs };
  }

  private async refresh(
    key: string,
    installationId: string,
    existing: CachedSnapshot | undefined,
    now: number,
  ): Promise<Snapshot> {
    const sources: Array<{ url: string; bearerToken?: string; installationId?: string }> = [];
    if (this.acceleratorUrl) {
      sources.push({
        url: acceleratorEndpoint(this.acceleratorUrl, installationId),
        bearerToken: this.acceleratorBearerToken,
      });
    }
    sources.push({
      url: controlPlaneEndpoint(this.controlPlaneBaseUrl, installationId),
      installationId,
    });
    for (const source of sources) {
      try {
        const candidate = await this.fetchCandidate(source.url, source.bearerToken, source.installationId);
        if (candidate.meta.installationId !== installationId) throw new Error("remote snapshot installation did not match request");
        assertSnapshotTrusted(candidate, { publicKeyBase64: this.publicKeyBase64, publicKeys: this.publicKeys });
        // Assignment happens only after all checks above, so an invalid response cannot replace LKG.
        cache.set(key, { snapshot: candidate, fetchedAtMs: this.clock.now().getTime() });
        return candidate;
      } catch {
        // Try the authoritative endpoint after an accelerator failure. Do not log: failures may
        // contain URL details and fetch implementations can include request-sensitive text.
      }
    }

    if (existing && now - existing.fetchedAtMs <= this.maxStaleMs) return existing.snapshot;
    throw new Error("no verified remote snapshot is available");
  }

  private async fetchCandidate(url: string, bearerToken?: string, installationId?: string): Promise<Snapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (installationId) Object.assign(headers, await this.installationHeaders(url, installationId));
      else if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
      const response = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      return await readResponseJson(response, this.maxResponseBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Report the revision this gateway has actually adopted using the installation identity. */
  async reportHeartbeat(installationId: string, appliedConfigRevision: string): Promise<void> {
    const url = new URL(
      `api/v1/installations/${encodeURIComponent(installationId)}/heartbeat`,
      `${this.controlPlaneBaseUrl.replace(/\/$/, "")}/`,
    );
    const body = JSON.stringify({
      appliedConfigRevision,
      reportedAt: this.clock.now().toISOString(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...await this.installationHeaders(url.toString(), installationId, "POST", body),
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("installation heartbeat was rejected");
    } finally {
      clearTimeout(timer);
    }
  }

  private async installationHeaders(
    urlValue: string,
    installationId: string,
    method = "GET",
    body = "",
  ): Promise<Record<string, string>> {
    const url = new URL(urlValue);
    const timestamp = this.clock.now().toISOString();
    const nonce = randomBytes(24).toString("base64url");
    const bodyHash = createHash("sha256").update(body).digest("base64url");
    const query = new URLSearchParams([...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))).toString();
    const message = Buffer.from(["manifold-installation-auth-v1", installationId, timestamp, nonce, method, url.pathname, query, bodyHash].join("\n"));
    const signature = sign(null, message, createPrivateKey({ key: Buffer.from(this.installationPrivateKeyBase64, "base64"), format: "der", type: "pkcs8" })).toString("base64");
    return { "x-manifold-installation-id": installationId, "x-manifold-timestamp": timestamp, "x-manifold-nonce": nonce, "x-manifold-signature": signature };
  }
}
