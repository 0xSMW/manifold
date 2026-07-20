// apps/gateway — runnable Node HTTP entry (SPEC §2, §8.1). Loads a local snapshot, wires the
// Node port adapters, resolves the profile from Host, and delegates to gateway-core.handleRequest.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { SnapshotTarget } from "@manifold/ports";
import { openAesGcm, unpackBase64, unwrapDek } from "@manifold/crypto";
import { handleRequest, type GatewayContext, type SsrfPolicy } from "@manifold/gateway-core";
import {
  EgressFetcher,
  JsonlIngestSink,
  NodeCrypto,
  SnapshotFileStore,
  SystemClock,
} from "./adapters.ts";

/** Dev-only pepper. Production supplies MANIFOLD_KEY_PEPPER (a gateway-only secret, §14.3). */
export const DEV_PEPPER = "dev-pepper-not-for-production";

export interface ServerOptions {
  snapshotPath?: string;
  observationsPath?: string;
  pepper?: string;
  installationId?: string;
  port?: number;
  host?: string;
  /** Egress policy override (tests relax it to reach a local mock upstream). */
  ssrfPolicy?: SsrfPolicy;
  /** Fetcher override (tests inject a fake/mock-pointing fetcher). */
  fetcher?: GatewayContext["fetcher"];
  /** KEK override for credential decryption (tests supply a known 32-byte key). */
  kek?: Uint8Array;
}

/** Dev-only KEK (all-zero 32 bytes) for local runs without MANIFOLD_DATA_KEK. */
const DEV_KEK = new Uint8Array(32);

/** Resolve the KEK from env (base64 32-byte) or fall back to the dev KEK. */
function kekFromEnv(): Uint8Array {
  const b64 = process.env.MANIFOLD_DATA_KEK;
  if (!b64) return DEV_KEK;
  const k = unpackBase64(b64);
  if (k.length !== 32) throw new Error("MANIFOLD_DATA_KEK must be base64 of exactly 32 bytes");
  return k;
}

/**
 * Real provider-secret resolution (§14.3, ADR-0022): decrypt the credential envelope in-proc —
 * unwrap the DEK with the KEK, then open the AES-256-GCM ciphertext. No DB read, no plaintext at
 * rest. THROWS on a tampered ciphertext / wrong KEK — the caller (handleRequest) fails closed.
 */
export function decryptTargetSecret(
  target: Pick<SnapshotTarget, "credentialCiphertext" | "wrappedDek">,
  kek: Uint8Array,
): string {
  const dek = unwrapDek(kek, unpackBase64(target.wrappedDek));
  const plaintext = openAesGcm(dek, unpackBase64(target.credentialCiphertext));
  return new TextDecoder().decode(plaintext);
}

/**
 * Secret resolver: decrypts the credential envelope (real path). Falls back to an env var ONLY
 * for a legacy demo target that carries no ciphertext (e.g. the local Anthropic example).
 */
export function makeSecretResolver(kek: Uint8Array): (target: SnapshotTarget) => Promise<string> {
  return async (target) => {
    if (target.credentialCiphertext && target.wrappedDek) {
      return decryptTargetSecret(target, kek);
    }
    if (target.secretEnv) return process.env[target.secretEnv] ?? "";
    return "";
  };
}

export async function buildContext(opts: ServerOptions = {}): Promise<GatewayContext> {
  const snapshotPath =
    opts.snapshotPath ?? process.env.MANIFOLD_SNAPSHOT ?? "./snapshot.example.json";
  const installationId = opts.installationId ?? "local-dev";
  const store = new SnapshotFileStore(snapshotPath);
  const snapshot = await store.loadActive(installationId);

  const pepper = new TextEncoder().encode(
    opts.pepper ?? process.env.MANIFOLD_KEY_PEPPER ?? DEV_PEPPER,
  );

  return {
    installationId,
    snapshot,
    crypto: new NodeCrypto(),
    clock: new SystemClock(),
    ingest: new JsonlIngestSink(opts.observationsPath ?? "./observations.log"),
    fetcher: opts.fetcher ?? new EgressFetcher(opts.ssrfPolicy),
    pepper,
    resolveSecret: makeSecretResolver(opts.kek ?? kekFromEnv()),
    ssrfPolicy: opts.ssrfPolicy,
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
      .catch((err) => {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: { message: String(err), type: "api_error", param: null, code: "INTERNAL" },
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
