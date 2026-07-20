// @manifold/ports — platform-adapter INTERFACES only. Pure types, ZERO platform imports.
// SPEC §4.4 (port interfaces), §7.2 (snapshot schema). Adapters (apps/gateway, adapters-*)
// implement these; gateway-core depends only on the interfaces, never on an adapter (§4.2).
import type { ReasonCode } from "@manifold/contracts";

// ────────────────────────────────────────────────────────────────────────────
// Snapshot schema (SPEC §7.2). The hot-path blob the gateway reads to route,
// authenticate, and apply static policy with zero DB reads (ADR-0005). Modeled
// here as pure TS types; the control plane's `config.buildSnapshot` (§7.5) emits
// this shape and signs it. Contracts will host the zod version; ports carries the
// structural types the runtime seam needs.
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotMeta {
  /** SPEC §7.2: pinned snapshot schema id. */
  schema: "manifold.snapshot.v1";
  installationId: string;
  revision: string;
  /** sha256:… over canonical body excluding meta.signature (§7.3). */
  contentHash: string;
  builtAt: string;
  /** base64 ed25519 over contentHash (§7.3). Verified against pinned public key on load. */
  signature: string;
  signingKeyId: string;
}

export interface SnapshotProfile {
  /** Stable profile id, referenced by SnapshotKey.profileId. Independent of the host string. */
  id: string;
  /** ADR-0001: the two disjoint trust models. */
  mode: "public_app" | "enterprise_egress";
  /** Bound policy revision id for this profile. */
  policyRevision: string | null;
  /** Default route-set id (§7.1). */
  defaultRouteSet: string | null;
}

export interface SnapshotKey {
  id: string;
  /** ADR-0001: a key belongs to exactly one profile; cross-profile use fails AUTH_PROFILE_MISMATCH. */
  profileId: string;
  scopes: string[];
  allowedAppIds: string[];
  budgetAccountId: string | null;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  revoked: boolean;
}

/**
 * Provider auth injection template (SPEC §2.8/§14.4: "provider auth is injected fresh").
 * Header values may contain the literal `${secret}` placeholder, substituted at dispatch
 * time with the decrypted provider secret. Works across providers:
 *   Anthropic → { "x-api-key": "${secret}", "anthropic-version": "2023-06-01" }
 *   OpenAI    → { "authorization": "Bearer ${secret}" }
 */
export interface AuthInject {
  headers: Record<string, string>;
}

export interface SnapshotTarget {
  offeringId: string;
  credentialId: string;
  dekId: string;
  /** base64 AES-256-GCM {iv|ct|tag} of the provider secret (ADR-0022). Never plaintext. */
  credentialCiphertext: string;
  /** base64 KEK-wrapped DEK; unwrapped once per isolate, KEK never in snapshot (A2). */
  wrappedDek: string;
  weight: number;
  priority: number;
  /** Provider base URL, e.g. https://api.anthropic.com. */
  baseUrl: string;
  region: string | null;
  /** SSRF egress allowlist for this target (§2.8/§14.4, `provider_credential.allowed_hosts`). */
  allowedHosts: string[];
  /** How to inject provider auth freshly on the upstream request (§2.8). */
  authInject: AuthInject;
  /**
   * SKELETON ONLY: env var name the runtime reads the provider secret from.
   * TODO(§14.3): the real path decrypts `credentialCiphertext` in-proc with the
   * KEK-unwrapped DEK (ADR-0022); this env shortcut disappears then.
   */
  secretEnv: string | null;
}

export interface SnapshotRoute {
  routeId: string;
  revision: string;
  mode: "ordered" | "weighted";
  targets: SnapshotTarget[];
  /** Milliseconds; overall upstream timeout (§14.4). */
  timeoutMs: number;
  capturePolicyId: string;
}

export interface Snapshot {
  meta: SnapshotMeta;
  /** host → profile (§7.2). Resolved pre-auth from the trusted host (ADR-0001). */
  profiles: Record<string, SnapshotProfile>;
  /** hex(HMAC(pepper, presentedKey)) → key (§7.2). O(1) lookup, no scan. */
  keys: Record<string, SnapshotKey>;
  /** `${profileId}:${path}` → route (§7.2, composite string key). O(1) lookup. */
  routes: Record<string, SnapshotRoute>;
}

// ────────────────────────────────────────────────────────────────────────────
// Observation events (SPEC §8.3 / ADR-0011). The gateway is a producer; the sink
// is write-only. Minimal shape the passthrough path needs.
// ────────────────────────────────────────────────────────────────────────────

export type ObservationEventKind = "accepted" | "provider_attempt" | "terminal";

export interface ObservationEvent {
  /** Idempotency anchor for the trace (§8.1). */
  traceId: string;
  kind: ObservationEventKind;
  /** Monotonic per-producer sequence within a trace (ADR-0011). */
  seq: number;
  occurredAt: string;
  profileId: string;
  keyId: string | null;
  routeId: string | null;
  offeringId: string | null;
  /** HTTP status observed upstream / returned to client, if known. */
  status: number | null;
  /** Reason codes attached to this event (§0.2). */
  reasonCodes: ReasonCode[];
}

// ────────────────────────────────────────────────────────────────────────────
// Platform adapter interfaces (SPEC §4.4). The runtime seam.
// ────────────────────────────────────────────────────────────────────────────

export interface SnapshotStore {
  /** Load the active snapshot for an installation. Zero-DB-read hot path (ADR-0005). */
  loadActive(installationId: string): Promise<Snapshot>;
}

export interface IngestSink {
  /** Emit an observation event (after()+ledger on Vercel | Queue on Cloudflare). */
  emit(event: ObservationEvent): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Crypto {
  /**
   * Keyed hash for virtual keys/tokens (§14.3). Async per review M10: some runtimes
   * (WebCrypto/Workers) only expose async HMAC, so the port is async everywhere.
   */
  hmacSha256(key: Uint8Array, msg: Uint8Array): Promise<Uint8Array>;
  /** Generate a prefixed random id (e.g. trace id). */
  randomId(prefix: string): string;
  /** Seal plaintext under a DEK (AES-256-GCM), producing {iv|ct|tag} (§14.3). */
  sealAesGcm(dek: Uint8Array, pt: Uint8Array): Uint8Array;
  /** Open ciphertext {iv|ct|tag} under a DEK (AES-256-GCM) in-proc (ADR-0022, §14.3). */
  openAesGcm(dek: Uint8Array, ct: Uint8Array): Uint8Array;
}

export interface Fetcher {
  /** Provider egress. Implementations wrap SSRF policy (§14.4). */
  fetch(req: Request): Promise<Response>;
}
