// apps/gateway — runnable Node HTTP entry (SPEC §2, §8.1). Loads a local snapshot, wires the
// Node port adapters, resolves the profile from Host, and delegates to gateway-core.handleRequest.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { IngestSink, Snapshot, SnapshotTarget } from "@manifold/ports";
import {
  DEV_PEPPER,
  credentialAad,
  openAesGcm,
  resolveDataKek,
  resolveKeyPepper,
  unpackBase64,
  unwrapDek,
} from "@manifold/crypto";
import { handleRequest, type GatewayContext, type SsrfPolicy } from "@manifold/gateway-core";
import {
  JsonlIngestSink,
  makeDbBudgetReserver,
  makeDbIngestSink,
  NodeCrypto,
  SnapshotFileStore,
  SystemClock,
} from "./adapters.js";
import { PinnedEgressFetcher } from "./pinnedEgress.js";

// DEV_PEPPER / DEV_KEK and the env resolvers are owned once by @manifold/crypto so the
// control plane (seal / mint) and this gateway (open / authenticate) resolve identical key
// material. Re-exported here to preserve this module's public surface.
export { DEV_PEPPER };

const MAX_PEPPERS = 2;
const MAX_PEPPER_LENGTH = 4_096;
const MAX_KEKS = 4;
const MAX_KEK_ID_LENGTH = 256;
const KEK_ID_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidEnv(name: string): never {
  throw new Error(`${name} is malformed`);
}

/** Strictly parse bounded virtual-key pepper overlap without including values in errors. */
export function parseKeyPeppers(raw: string): readonly string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalidEnv("MANIFOLD_KEY_PEPPERS"); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_PEPPERS ||
    parsed.some((pepper) => typeof pepper !== "string" || !pepper || pepper.length > MAX_PEPPER_LENGTH)) {
    return invalidEnv("MANIFOLD_KEY_PEPPERS");
  }
  return Object.freeze([...parsed]);
}

/** Strictly parse versioned 32-byte KEKs. Keys are never put into error text. */
export function parseDataKeks(raw: string): Readonly<Record<string, Uint8Array>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return invalidEnv("MANIFOLD_DATA_KEKS"); }
  if (!parsed || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return invalidEnv("MANIFOLD_DATA_KEKS");
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > MAX_KEKS) return invalidEnv("MANIFOLD_DATA_KEKS");
  const result: Record<string, Uint8Array> = {};
  for (const [kekId, encoded] of entries) {
    if (!kekId || kekId.length > MAX_KEK_ID_LENGTH || !KEK_ID_RE.test(kekId) ||
      typeof encoded !== "string" || !encoded || !BASE64_RE.test(encoded)) return invalidEnv("MANIFOLD_DATA_KEKS");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) return invalidEnv("MANIFOLD_DATA_KEKS");
    result[kekId] = new Uint8Array(decoded);
  }
  return Object.freeze(result);
}

function normalizePeppers(peppers: readonly string[]): readonly Uint8Array[] {
  const validated = parseKeyPeppers(JSON.stringify(peppers));
  return Object.freeze(validated.map((pepper) => new TextEncoder().encode(pepper)));
}

function normalizeKeks(keks: Readonly<Record<string, Uint8Array>>): Readonly<Record<string, Uint8Array>> {
  const encoded: Record<string, string> = {};
  for (const [id, key] of Object.entries(keks)) encoded[id] = Buffer.from(key).toString("base64");
  return parseDataKeks(JSON.stringify(encoded));
}

export interface ServerOptions {
  /** Preloaded, already-verified snapshot. Runtime adapters use this instead of a local file. */
  snapshot?: Snapshot;
  snapshotPath?: string;
  /** Pinned snapshot-signing public key for the local-file adapter. */
  snapshotPublicKey?: string;
  observationsPath?: string;
  /** Runtime-specific ingest transport. Vercel supplies a request-scoped durable job sink. */
  ingest?: IngestSink;
  pepper?: string;
  /** Rotation overlap, ordered new then old. Takes precedence over `pepper`. */
  peppers?: readonly string[];
  installationId?: string;
  port?: number;
  host?: string;
  /** Egress policy override (tests relax it to reach a local mock upstream). */
  ssrfPolicy?: SsrfPolicy;
  /** Fetcher override (tests inject a fake/mock-pointing fetcher). */
  fetcher?: GatewayContext["fetcher"];
  /** KEK override for credential decryption (tests supply a known 32-byte key). */
  kek?: Uint8Array;
  /** Versioned KEKs for targets carrying `kekId`; may coexist with legacy `kek`. */
  keks?: Readonly<Record<string, Uint8Array>>;
  /**
   * Hard-budget reserver (SPEC §16.3, ADR-0012). Optional: when unset, a key that carries a hard
   * budget fails closed in the core. Production binds this to @manifold/budget via
   * BudgetReserverAdapter; tests inject the in-memory FakeBudgetReserver.
   */
  reserveBudget?: GatewayContext["reserveBudget"];
  /**
   * This installation's one workspace (SPEC §7/§6.16). Falls back to MANIFOLD_WORKSPACE_ID.
   * REQUIRED whenever a reservation/observability DB is configured (MANIFOLD_BUDGET_DB_URL /
   * DATABASE_URL): budget_account/usage_record/cost_ledger are FORCE-RLS workspace-scoped tables
   * (§9), and the owning workspace cannot be safely discovered from an unscoped read under the
   * non-superuser `manifold_app` role — it must be supplied out-of-band. One `gateway_installation`
   * belongs to exactly one workspace, so one running gateway process has exactly one answer here.
   */
  workspaceId?: string;
  /** Explicit pooled runtime database URL. Falls back to gateway env vars. */
  budgetDbUrl?: string;
}

/**
 * Real provider-secret resolution (§14.3, ADR-0022): decrypt the credential envelope in-proc —
 * unwrap the DEK with the KEK, then open the AES-256-GCM ciphertext. No DB read, no plaintext at
 * rest. THROWS on a tampered ciphertext / wrong KEK — the caller (handleRequest) fails closed.
 */
export function decryptTargetSecret(
  target: Pick<SnapshotTarget, "credentialCiphertext" | "wrappedDek" | "credentialId">,
  kek: Uint8Array,
): string {
  const dek = unwrapDek(kek, unpackBase64(target.wrappedDek));
  // Open with the credential-identity AAD (§14.3): a ciphertext sealed for a DIFFERENT credentialId
  // (a swap under the shared workspace DEK) fails the GCM tag check and throws — never a wrong secret.
  const plaintext = openAesGcm(
    dek,
    unpackBase64(target.credentialCiphertext),
    credentialAad(target.credentialId),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Secret resolver: decrypts the credential envelope in-proc (§14.3, ADR-0022). This is the ONLY
 * credential path — there is no env fallback.
 *
 * FAIL CLOSED (§14.3): when there is no decryptable envelope (missing/empty ciphertext or wrappedDek),
 * or the envelope decrypts to an empty string, this THROWS instead of returning "". Returning an empty
 * string would let handleRequest dispatch `Authorization: Bearer <empty>` / `x-api-key: ''` upstream (a
 * fail-OPEN credential). The throw is mapped by handleRequest to 502 CREDENTIAL_UNAVAILABLE — never
 * dispatched, never leaked.
 */
export function makeSecretResolver(
  legacyKek?: Uint8Array,
  keyring?: Readonly<Record<string, Uint8Array>>,
): (target: SnapshotTarget) => Promise<string> {
  return async (target) => {
    if (!target.credentialCiphertext || !target.wrappedDek) {
      throw new Error(
        `no provider credential available for offering ${target.offeringId}: ` +
          "no credentialCiphertext/wrappedDek to decrypt (fail closed, §14.3)",
      );
    }
    // A versioned target must use its exact KEK. Falling back to the legacy key would make a
    // typo/deleted key silently decrypt under an unintended trust root.
    const kek = target.kekId ? keyring?.[target.kekId] : legacyKek;
    if (!kek) throw new Error("no matching credential encryption key is available");
    const secret = decryptTargetSecret(target, kek);
    // An envelope that decrypts to EMPTY is NOT a real credential — returning "" would let
    // handleRequest dispatch `x-api-key: ''` / `Authorization: Bearer ` upstream (fail-OPEN).
    // Treat it as no-credential and THROW so the caller fails CLOSED (502).
    if (!secret) {
      throw new Error(
        `decrypted provider credential is empty for offering ${target.offeringId}: ` +
          "an empty secret is not a credential (fail closed, §14.3)",
      );
    }
    return secret;
  };
}

export async function buildContext(opts: ServerOptions = {}): Promise<GatewayContext> {
  const installationId =
    opts.installationId ?? process.env.MANIFOLD_INSTALLATION_ID ?? "local-dev";
  let snapshot = opts.snapshot;
  if (!snapshot) {
    const snapshotPath =
      opts.snapshotPath ?? process.env.MANIFOLD_SNAPSHOT ?? "./snapshot.example.json";
    const store = new SnapshotFileStore(
      snapshotPath,
      opts.snapshotPublicKey ?? process.env.MANIFOLD_SNAPSHOT_PUBLIC_KEY,
    );
    snapshot = await store.loadActive(installationId);
  }
  if (snapshot.meta.installationId !== installationId) {
    throw new Error("loaded snapshot installation does not match gateway installation");
  }

  const envPeppers = process.env.MANIFOLD_KEY_PEPPERS;
  const peppers = opts.peppers
    ? normalizePeppers(opts.peppers)
    : envPeppers === undefined
      ? Object.freeze([new TextEncoder().encode(opts.pepper ?? resolveKeyPepper(process.env.MANIFOLD_KEY_PEPPER))])
      : normalizePeppers(parseKeyPeppers(envPeppers));
  const envKeks = process.env.MANIFOLD_DATA_KEKS;
  const keyring = opts.keks
    ? normalizeKeks(opts.keks)
    : envKeks === undefined ? undefined : parseDataKeks(envKeks);
  // Keep a legacy KEK only when explicitly supplied alongside the keyring. A keyring-only runtime
  // must fail closed for old ID-less snapshots instead of silently using a dev/default value.
  const legacyKek = opts.kek ?? (keyring
    ? (process.env.MANIFOLD_DATA_KEK?.trim() ? resolveDataKek(process.env.MANIFOLD_DATA_KEK) : undefined)
    : resolveDataKek(process.env.MANIFOLD_DATA_KEK));

  // Hard-budget reservation (SPEC §16.3, ADR-0012) + the observation/billing ingest (§8.3-8.4): an
  // explicit test override (reserveBudget) wins for the reserver; otherwise, when a reservation DB
  // is configured (MANIFOLD_BUDGET_DB_URL / DATABASE_URL), bind the REAL @manifold/budget.reserve
  // transaction AND a real DbIngestSink so the running gateway both denies a DB hard-budget over-cap
  // AND actually writes usage_record/cost_ledger + commits the reservation reserved→committed
  // (review live-money-wiring #1: JsonlIngestSink alone never drove ingestTrace on the live path, so
  // production never wrote cost_ledger and every hard-budget hold was stranded at 'reserved'). With
  // no DB configured, `reserveBudget` stays undefined (a hard budget fails closed in the core, never
  // dispatched unmetered) and ingest stays JSONL-only, exactly the prior dev behavior.
  const budgetDbUrl =
    opts.budgetDbUrl ?? process.env.MANIFOLD_BUDGET_DB_URL ?? process.env.DATABASE_URL;
  const jsonlIngest = opts.ingest
    ? undefined
    : new JsonlIngestSink(opts.observationsPath ?? "./observations.log");
  let reserveBudget = opts.reserveBudget;
  let ingest: GatewayContext["ingest"] = opts.ingest ?? jsonlIngest!;
  if (budgetDbUrl) {
    const workspaceId = opts.workspaceId ?? process.env.MANIFOLD_WORKSPACE_ID;
    if (!workspaceId) {
      // Fail LOUD at startup, not silently: without a workspace, a "fixed" reserveBudget would either
      // (a) still fail-closed on every request (safe but a silent DoS on every hard budget) or (b) be
      // skipped entirely, leaving hard budgets unmetered. Neither should happen quietly in production.
      throw new Error(
        "MANIFOLD_WORKSPACE_ID (or ServerOptions.workspaceId) must be set when a reservation/" +
          "observability DB is configured (MANIFOLD_BUDGET_DB_URL / DATABASE_URL): budget_account, " +
          "usage_record and cost_ledger are workspace-scoped RLS tables (§6.16) and the workspace " +
          "cannot be discovered from an unscoped read — it must be supplied out-of-band.",
      );
    }
    if (!reserveBudget) {
      const reserver = makeDbBudgetReserver(budgetDbUrl, workspaceId);
      reserveBudget = (input) => reserver.reserve(input);
    }
    if (!opts.ingest) {
      // Keep JSONL too for the local server — a debug trail independent of the DB write.
      ingest = makeDbIngestSink(budgetDbUrl, workspaceId, installationId, jsonlIngest);
    }
  }

  return {
    installationId,
    snapshot,
    crypto: new NodeCrypto(),
    clock: new SystemClock(),
    ingest,
    fetcher: opts.fetcher ?? new PinnedEgressFetcher(opts.ssrfPolicy),
    pepper: peppers[0]!,
    peppers,
    resolveSecret: makeSecretResolver(legacyKek, keyring),
    ssrfPolicy: opts.ssrfPolicy,
    reserveBudget,
  };
}

/** Convert a Node IncomingMessage into a Web Request (streaming body, no buffering). */
function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = (req.method ?? "GET").toUpperCase();
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (typeof value === "string") headers.set(name, value);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Relay a Web Response to the Node ServerResponse, streaming the body through. */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (response.body) {
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(res);
  } else {
    res.end();
  }
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const ctx = await buildContext(opts);
  const server = createServer((req, res) => {
    handleRequest(ctx, toWebRequest(req))
      .then((response) => writeWebResponse(res, response))
      .catch(() => {
        // NEVER leak internal error text (review gateway-F4): a driver/postgres error can carry the
        // host/DSN or other internals straight to the client. handleRequest already maps every known
        // failure to a reason code + terminal internally; anything reaching here is an unexpected bug,
        // so return a GENERIC envelope with no error detail.
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: { message: "internal error", type: "api_error", param: null, code: "INTERNAL" },
          }),
        );
      });
  });

  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    server,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run directly: `node src/server.ts` (dev) / `node dist/server.js` (start).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer()
    .then(({ url }) => console.log(`manifold gateway listening on ${url}`))
    .catch((err) => {
      console.error("failed to start gateway:", err);
      process.exit(1);
    });
}
