// apps/gateway adapters — the thin Node implementations of the platform ports (SPEC §4.4).
// This is the ONLY layer allowed to touch node:* / platform globals; gateway-core stays pure.
import { createHash, createHmac, randomUUID } from "node:crypto";
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
  HotPathObservationEvent,
  IngestSink,
  Snapshot,
  SnapshotStore,
} from "@manifold/ports";
import { isPrivateIp, schemeAllowed, type SsrfPolicy, STRICT_SSRF } from "@manifold/gateway-core";
import { isUlid, ulidFromBytes } from "@manifold/ids";
import { bucketStart, reserve as budgetReserve } from "@manifold/budget";
// `@manifold/database` is the sole owner of the postgres driver (§4.2): we take both its `Sql` type
// and its `getClient` opener from it, so the reservation connection is created (and its json/jsonb
// serializers applied) in the one place allowed to touch the driver — not re-opened here.
import { getClient, type Sql } from "@manifold/database";
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
  async emit(event: HotPathObservationEvent): Promise<void> {
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

// ── Real Postgres-backed reservation (ADR-0012 / §16.3): the gateway's enterprise DB touch ──────
//
// This is the concrete `reserveFn` that `BudgetReserverAdapter` wraps in production: the single
// strong-consistency reserve transaction from `@manifold/budget`, run against the reservation
// Postgres. The port (`BudgetReserveInput`) hands us only { budgetAccountId, requestId(=traceId),
// estMicroUsd }; `@manifold/budget.reserve` additionally needs the account's `workspaceId` (to scope
// the RLS GUC before it locks any row) and a fixed-window bucket. We read the (workspace_id, window)
// off the budget_account once, derive `windowStart = bucketStart(account.window, now)`, and call
// reserve. gateway-core never imports @manifold/budget or a driver — this adapter is the seam.

/**
 * The ULID `request_id` the reservation transaction uses. `@manifold/budget.reserve` derives
 * `created_at` (and thus the monthly partition + the `(budget_account_id, request_id, created_at)`
 * idempotency key) from this ULID's timestamp, so it MUST be a ULID — validated and synthesized via
 * the ONE shared id vocabulary (`@manifold/ids`).
 *
 * When the gateway trace-id already IS a ULID (the production intent — the pure core now mints one)
 * we pass it straight through — full idempotency + trace linkage. Otherwise (a legacy `trace_<hex>`
 * id, or a 26-char Crockford lookalike whose timestamp overflows) we synthesize a ULID whose TIME is
 * `now` — so `created_at ≈ now` and the reserve's own `bucketStart(window, created_at)` lands in the
 * SAME window we reserved against — and whose 16 random chars are a deterministic function of the
 * trace-id's sha256, so the reservation still ties back to the trace and same-millisecond retries of
 * one trace collapse to a single reservation.
 */
export function reservationRequestId(traceId: string, now: Date): string {
  if (isUlid(traceId)) return traceId.toUpperCase();
  const digest = createHash("sha256").update(traceId).digest();
  return ulidFromBytes(now.getTime(), digest);
}

interface BudgetAccountMetaRow {
  workspace_id: string;
  window: string;
}

export interface DbBudgetReserverOptions {
  /** Postgres reservation client (postgres-js). */
  sql: Sql;
  /** Wall clock; the reservation window + created_at anchor. Defaults to `Date`. */
  now?: () => Date;
}

/**
 * Build the production `reserveFn` bound to a Postgres reservation connection. Returns a
 * `BudgetReserveResult` the gateway core understands; every failure mode (unknown account, over
 * cap, driver error) fails CLOSED as `BUDGET_RESERVE_DENIED` so an unmetered request is never
 * dispatched (§16.3 deny-first).
 */
export function makeDbBudgetReserveFn(
  opts: DbBudgetReserverOptions,
): (input: BudgetReserveInput) => Promise<BudgetReserveResult> {
  const { sql } = opts;
  const now = opts.now ?? (() => new Date());
  return async (input: BudgetReserveInput): Promise<BudgetReserveResult> => {
    // FAIL CLOSED on ANY driver/connection/deadlock error (review gateway-F4): a throw here would
    // propagate to the server's top-level catch — a 500 that both leaks internal detail and skips the
    // budget gate. A hard budget we cannot evaluate MUST deny, never dispatch unmetered.
    try {
      const rows = await sql<BudgetAccountMetaRow[]>`
        SELECT workspace_id, "window"
        FROM budget_account
        WHERE id = ${input.budgetAccountId}
        LIMIT 1
      `;
      const acct = rows[0];
      // A hard budget whose account we cannot resolve is not honorable → fail closed.
      if (!acct) return { ok: false, reason: "BUDGET_RESERVE_DENIED" };

      const at = now();
      const result = await budgetReserve(sql, {
        budgetAccountId: input.budgetAccountId,
        requestId: reservationRequestId(input.requestId, at),
        estMicroUsd: input.estMicroUsd,
        workspaceId: acct.workspace_id,
        windowStart: bucketStart(acct.window, at),
        shard: 0,
        // Thread the token estimate so a unit=tokens hard budget enforces pre-dispatch (#3).
        estimatedInputTokens: input.estimatedInputTokens,
        maxOutputTokens: input.maxOutputTokens,
      });
      return result.ok
        ? { ok: true, reservationId: result.reservationId }
        : { ok: false, reason: "BUDGET_RESERVE_DENIED" };
    } catch {
      return { ok: false, reason: "BUDGET_RESERVE_DENIED" };
    }
  };
}

/**
 * Convenience factory: a `BudgetReserverAdapter` reserving against the Postgres connection named by
 * `url` (the gateway's reservation DB, from MANIFOLD_BUDGET_DB_URL / DATABASE_URL). Wired into
 * `buildContext` so the running gateway honors DB hard budgets; tests inject the in-memory
 * FakeBudgetReserver instead.
 */
export function makeDbBudgetReserver(url: string, now?: () => Date): BudgetReserverAdapter {
  // §2.4/§4.2: @manifold/database is the sole driver opener — getClient applies the max:1
  // serverless default (one connection per invocation against the pooler) and the json/jsonb
  // serializers for us.
  const sql = getClient(url);
  return new BudgetReserverAdapter(makeDbBudgetReserveFn({ sql, now }));
}

/** Redirect hops we follow before giving up (same order of magnitude as browser/undici defaults). */
const MAX_REDIRECTS = 10;

/**
 * Provider-egress Fetcher (§14.4): https-only, rejects private destinations, and does NOT let
 * `fetch` auto-follow redirects — it validates every hop itself (SSRF defense in depth; gateway-core
 * already applied the per-target allowlist to the ORIGIN).
 *
 * Redirects (redirect SSRF + credential exfil): an allowlisted upstream returning `302 Location:
 * http://169.254.169.254/` or `https://evil.example/` would otherwise be followed WITH the injected
 * provider secret still attached. We use `redirect:"manual"` and re-validate each Location: scheme +
 * resolved-private-IP + it must stay on the SAME host as the origin (the fetcher can't see the
 * per-target allowlist, so a cross-host redirect — which the allowlist never vetted — is refused).
 *
 * DNS (§14.4): the host is resolved with `{all:true}` and EVERY resolved address (v4 AND v6) must be
 * public — a name with a public A but a private AAAA (or vice-versa) is blocked. RESIDUAL: this
 * resolves-then-fetches, and `fetch` re-resolves; true pinning (connect to the exact validated
 * address, no rebind) needs a custom undici dispatcher. Checking all families closes the common
 * dual-stack/rebind cases. Loopback/http are permitted only when the injected policy relaxes them.
 */
/** Resolve a hostname to its addresses (all families). Injectable so an adversarial test can
 *  simulate hostile DNS (a name resolving to a private/metadata address). */
export type HostResolver = (host: string) => Promise<{ address: string }[]>;

export class EgressFetcher implements Fetcher {
  private readonly policy: SsrfPolicy;
  private readonly resolve: HostResolver;
  constructor(policy: SsrfPolicy = STRICT_SSRF, resolve?: HostResolver) {
    this.policy = policy;
    this.resolve = resolve ?? ((host) => lookup(host, { all: true }));
  }

  /** Validate one destination URL: scheme (via the shared predicate) + no resolved private address. */
  private async assertDestinationAllowed(url: URL): Promise<void> {
    // Reuse gateway-core's single scheme/policy predicate so this gate can never drift from
    // ssrfCheck's (§14.4).
    const scheme = schemeAllowed(url, this.policy);
    if (!scheme.ok) throw new Error(`egress: ${scheme.reason}`);
    if (this.policy.allowPrivate) return;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      if (isPrivateIp(host)) throw new Error(`egress: blocked private address ${host}`);
      return;
    }
    // Resolve ALL families and reject if ANY resolved address is private (dual-stack blind spot).
    // This is the core DNS-rebind defense: a name whose DNS answer points at a private/metadata
    // address is blocked BEFORE the request is issued. (Full connection pinning to the exact validated
    // address — closing the fetch-time re-resolution TOCTOU — needs a custom dispatcher; see the class
    // doc RESIDUAL. This check catches a hostile answer at validation time.)
    const resolved = await this.resolve(host);
    for (const { address } of resolved) {
      if (isPrivateIp(address)) {
        throw new Error(`egress: blocked private address ${address} (resolved from ${host})`);
      }
    }
  }

  async fetch(req: Request): Promise<Response> {
    const originHost = new URL(req.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    let current = req;
    for (let hop = 0; ; hop++) {
      await this.assertDestinationAllowed(new URL(current.url));
      // redirect:"manual" — never let fetch auto-follow; we vet each Location ourselves.
      const res = await globalThis.fetch(current, { redirect: "manual" });
      if (res.status < 300 || res.status >= 400) return res; // not a redirect → hand it back
      const location = res.headers.get("location");
      if (!location) return res; // 3xx with no Location → nothing to follow
      if (hop >= MAX_REDIRECTS) throw new Error("egress: too many redirects");
      const next = new URL(location, current.url);
      const nextHost = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      // Refuse any CROSS-HOST redirect: the origin is the ONLY host gateway-core checked against the
      // per-target allowlist. A redirect to a different host (evil.example / a private IP / cloud
      // metadata) must NOT receive the injected provider secret.
      if (nextHost !== originHost) {
        throw new Error(`egress: refused cross-host redirect ${originHost} -> ${nextHost}`);
      }
      // Same host: re-validate scheme + resolved-private-IP (catch an https→http downgrade or a name
      // that now resolves private) before following.
      await this.assertDestinationAllowed(next);
      await res.body?.cancel().catch(() => {});
      // Re-issue to the same host carrying method + headers. NOTE: a request body is not replayed on
      // a same-host redirect (the origin stream is already consumed) — an acceptable residual for the
      // uncommon provider-side same-host redirect; the security-critical cross-host case is refused.
      current = new Request(next.toString(), { method: current.method, headers: current.headers });
    }
  }
}
