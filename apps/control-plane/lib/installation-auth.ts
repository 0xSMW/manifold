// Installation identity authentication for gateway-only endpoints (SPEC §7.4, §10.3).
// A gateway proves either possession of its registered Ed25519 private key or a pinned OIDC
// workload identity. The installation record, never a token claim, selects the workspace.
import { constants, createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKeyInput } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isPrivateIp } from "@manifold/gateway-core";
import { rawSql } from "@/lib/db";
import { ManifoldError } from "@/lib/http";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_JWKS_CACHE_ENTRIES = 32;
const MAX_JWKS_BYTES = 256 * 1024;
const NONCE_RE = /^[A-Za-z0-9_-]{22,256}$/;
const SIGNATURE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const JWT_PART_RE = /^[A-Za-z0-9_-]+$/;
const APPROVED_JWT_ALGORITHMS = new Set(["RS256", "PS256", "EdDSA"]);

type WorkloadIdentity = { issuer: string; jwksUrl: string; audience: string; subject: string };
type InstallationRow = { id: string; workspace_id: string; public_key: Buffer | null; workload_identity: unknown; disabled_at: string | null };
type Jwk = JsonWebKey & { kid?: unknown; kty?: unknown; alg?: unknown; use?: unknown; key_ops?: unknown };
type Jwks = { keys: Jwk[] };
type CachedJwks = { expiresAt: number; keys: Jwk[] };
const jwksCache = new Map<string, CachedJwks>();

export interface InstallationPrincipal { installationId: string; workspaceId: string }
export interface InstallationAuthOptions { path: string; installationId?: string; now?: Date; workloadJwksFetcher?: (url: string) => Promise<Jwks> }
export interface WorkloadVerificationOptions { now?: Date; jwksFetcher?: (url: string) => Promise<Jwks> }
export interface SafeJwksFetchOptions { resolve?: (hostname: string) => Promise<{ address: string; family: number }[]> }

function authError(reason: string, message: string): ManifoldError {
  return new ManifoldError({ status: 401, code: "UNAUTHENTICATED", message, reasonCodes: [reason], remediation: "authenticate with the registered installation identity" });
}
function value(headers: Headers, name: string): string {
  const result = headers.get(name)?.trim();
  if (!result) throw authError("AUTH_INSTALLATION_SIGNATURE_INVALID", `missing ${name} header`);
  return result;
}
function canonicalQuery(url: URL): string {
  return new URLSearchParams([...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))).toString();
}
async function requestBodyHash(request: Request): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await request.clone().arrayBuffer())).digest("base64url");
}
/** Stable signed material shared by the gateway runtime and interoperability tests. */
export function installationRequestSigningInput(input: { installationId: string; timestamp: string; nonce: string; method: string; pathname: string; query: string; bodyHash: string }): Buffer {
  return Buffer.from(["manifold-installation-auth-v1", input.installationId, input.timestamp, input.nonce, input.method.toUpperCase(), input.pathname, input.query, input.bodyHash].join("\n"), "utf8");
}
function exactBytesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function exactClaim(value: unknown, expected: string): boolean {
  return typeof value === "string" && exactBytesEqual(value, expected);
}
function parseIdentity(value: unknown): WorkloadIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const fields = ["issuer", "jwksUrl", "audience", "subject"] as const;
  if (fields.some((field) => typeof candidate[field] !== "string" || !(candidate[field] as string).trim())) return null;
  return { issuer: candidate.issuer as string, jwksUrl: candidate.jwksUrl as string, audience: candidate.audience as string, subject: candidate.subject as string };
}
async function lookupInstallation(installationId: string): Promise<InstallationRow | null> {
  const rows = await rawSql()<InstallationRow[]>`SELECT id, workspace_id, public_key, workload_identity, disabled_at FROM auth_lookup_installation(${installationId})`;
  return rows[0] ?? null;
}
async function claimNonce(installationId: string, nonce: string, expiresAt: Date): Promise<boolean> {
  const nonceHash = createHash("sha256").update(nonce, "utf8").digest();
  const rows = await rawSql()<{ claimed: boolean }[]>`SELECT auth_claim_installation_nonce(${installationId}, ${nonceHash}, ${expiresAt.toISOString()}) AS claimed`;
  return rows[0]?.claimed === true;
}

function parseSafeJwksUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw authError("AUTH_INSTALLATION_JWKS_UNSAFE", "workload identity JWKS URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || isIP(url.hostname) !== 0 || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw authError("AUTH_INSTALLATION_JWKS_UNSAFE", "workload identity JWKS URL is not a public HTTPS endpoint");
  }
  return url;
}
export async function fetchWorkloadIdentityJwks(rawUrl: string, options: SafeJwksFetchOptions = {}): Promise<Jwks> {
  const url = parseSafeJwksUrl(rawUrl);
  let addresses: { address: string; family: number }[];
  try { addresses = await (options.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true })))(url.hostname); } catch { throw authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS host could not be resolved"); }
  if (!addresses.length || addresses.some(({ address }) => isIP(address) === 0 || isPrivateIp(address))) throw authError("AUTH_INSTALLATION_JWKS_UNSAFE", "workload identity JWKS host resolves to a non-public address");
  const address = addresses[0]!;
  const body = await new Promise<string>((resolve, reject) => {
    const request = httpsRequest(url, { method: "GET", headers: { accept: "application/json" }, timeout: 5_000, lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS endpoint did not return success")); return; }
      let bytes = 0; let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > MAX_JWKS_BYTES) { request.destroy(); reject(authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS response is too large")); } else result += chunk; });
      response.on("end", () => resolve(result));
    });
    request.once("timeout", () => request.destroy(new Error("JWKS request timed out")));
    request.once("error", () => reject(authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS request failed")));
    request.end();
  });
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error("invalid JWKS");
    return parsed as Jwks;
  } catch { throw authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS response is invalid"); }
}
async function getJwks(url: string, fetcher: (url: string) => Promise<Jwks>): Promise<Jwks> {
  const now = Date.now(); const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > now) return { keys: cached.keys };
  const fresh = await fetcher(url);
  if (!Array.isArray(fresh.keys) || fresh.keys.length > 32) throw authError("AUTH_INSTALLATION_JWKS_FETCH_FAILED", "workload identity JWKS response is invalid");
  if (jwksCache.size >= MAX_JWKS_CACHE_ENTRIES) jwksCache.delete(jwksCache.keys().next().value!);
  jwksCache.set(url, { keys: fresh.keys, expiresAt: now + JWKS_CACHE_TTL_MS });
  return fresh;
}
function decodeJwtPart(part: string): Record<string, unknown> {
  if (!JWT_PART_RE.test(part)) throw authError("AUTH_INSTALLATION_JWT_INVALID", "workload identity token is malformed");
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch { throw authError("AUTH_INSTALLATION_JWT_INVALID", "workload identity token is malformed"); }
}
function selectJwk(keys: Jwk[], header: Record<string, unknown>, algorithm: string): Jwk {
  if (typeof header.kid !== "string" || !header.kid) throw authError("AUTH_INSTALLATION_JWT_KEY_INVALID", "workload identity token is missing a key id");
  const matches = keys.filter((key) => key.kid === header.kid);
  if (matches.length !== 1) throw authError("AUTH_INSTALLATION_JWT_KEY_INVALID", "workload identity signing key is not accepted");
  const key = matches[0]!;
  if ((typeof key.alg === "string" && key.alg !== algorithm) || (typeof key.use === "string" && key.use !== "sig") || (Array.isArray(key.key_ops) && !key.key_ops.includes("verify"))) throw authError("AUTH_INSTALLATION_JWT_KEY_INVALID", "workload identity signing key is not accepted");
  if ((algorithm === "EdDSA" && (key.kty !== "OKP" || key.crv !== "Ed25519")) || (algorithm !== "EdDSA" && key.kty !== "RSA")) throw authError("AUTH_INSTALLATION_JWT_KEY_INVALID", "workload identity signing key is not accepted");
  return key;
}
function verifyJwtSignature(algorithm: string, key: Jwk, signed: Buffer, signature: Buffer): boolean {
  try {
    const publicKey = createPublicKey({ key: key as JsonWebKeyInput["key"], format: "jwk" });
    if (algorithm !== "EdDSA" && (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
    if (algorithm === "RS256") return verify("RSA-SHA256", signed, publicKey, signature);
    if (algorithm === "PS256") return verify("RSA-SHA256", signed, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    return verify(null, signed, publicKey, signature);
  } catch { return false; }
}
/** Verifies a compact OIDC JWT against the installation's exact issuer, audience, subject, and JWKS. */
export async function verifyWorkloadIdentityJwt(identity: WorkloadIdentity, token: string, options: WorkloadVerificationOptions = {}): Promise<{ jti: string; expiresAt: Date }> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw authError("AUTH_INSTALLATION_JWT_INVALID", "workload identity token is malformed");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header = decodeJwtPart(encodedHeader); const claims = decodeJwtPart(encodedClaims);
  const algorithm = header.alg;
  if (typeof algorithm !== "string" || !APPROVED_JWT_ALGORITHMS.has(algorithm) || header.crit !== undefined) throw authError("AUTH_INSTALLATION_JWT_ALGORITHM_INVALID", "workload identity token algorithm is not accepted");
  const jwks = await getJwks(identity.jwksUrl, options.jwksFetcher ?? fetchWorkloadIdentityJwks);
  const signature = Buffer.from(encodedSignature, "base64url");
  if (!signature.length || !verifyJwtSignature(algorithm, selectJwk(jwks.keys, header, algorithm), Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii"), signature)) throw authError("AUTH_INSTALLATION_JWT_SIGNATURE_INVALID", "workload identity token signature is invalid");
  const now = options.now ?? new Date(); const nowSeconds = Math.floor(now.getTime() / 1000);
  const exp = claims.exp; const nbf = claims.nbf;
  if (!exactClaim(claims.iss, identity.issuer) || !(exactClaim(claims.aud, identity.audience) || Array.isArray(claims.aud) && claims.aud.some((audience) => exactClaim(audience, identity.audience))) || !exactClaim(claims.sub, identity.subject)) throw authError("AUTH_INSTALLATION_JWT_CLAIMS_INVALID", "workload identity token claims are not accepted");
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds || exp > nowSeconds + 24 * 60 * 60 || nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf > nowSeconds + Math.floor(MAX_CLOCK_SKEW_MS / 1000))) throw authError("AUTH_INSTALLATION_JWT_TIME_INVALID", "workload identity token is expired or not yet valid");
  if (typeof claims.jti !== "string" || !NONCE_RE.test(claims.jti)) throw authError("AUTH_INSTALLATION_JWT_REPLAY_UNSAFE", "workload identity token must contain a valid jti claim");
  return { jti: claims.jti, expiresAt: new Date(Math.min(exp * 1000, now.getTime() + NONCE_TTL_MS)) };
}

/** Verify the registered public-key or workload-identity credentials for one exact installation endpoint. */
export async function authenticateInstallation(request: Request, options: InstallationAuthOptions): Promise<InstallationPrincipal> {
  const url = new URL(request.url);
  if (url.pathname !== options.path) throw authError("AUTH_INSTALLATION_PATH_MISMATCH", "signed request path does not match this endpoint");
  const installationId = value(request.headers, "x-manifold-installation-id");
  const queryInstallationId = url.searchParams.get("installationId");
  if (options.installationId && !exactBytesEqual(options.installationId, installationId)) throw authError("AUTH_INSTALLATION_ID_MISMATCH", "installation identity does not match request path");
  if (queryInstallationId && !exactBytesEqual(queryInstallationId, installationId)) throw authError("AUTH_INSTALLATION_ID_MISMATCH", "installation identity does not match query parameter");
  const installation = await lookupInstallation(installationId);
  if (!installation || installation.disabled_at) throw authError("AUTH_INSTALLATION_UNKNOWN", "installation identity is not accepted");
  const workloadIdentity = parseIdentity(installation.workload_identity);
  if (workloadIdentity) {
    const authorization = request.headers.get("authorization");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if (!match || installation.public_key) throw authError("AUTH_INSTALLATION_BEARER_INVALID", "installation requires a workload identity bearer token");
    const verified = await verifyWorkloadIdentityJwt(workloadIdentity, match[1]!, { now: options.now, jwksFetcher: options.workloadJwksFetcher });
    if (!(await claimNonce(installation.id, `jwt:${verified.jti}`, verified.expiresAt))) throw authError("AUTH_INSTALLATION_REPLAY", "workload identity token was already used");
    return { installationId: installation.id, workspaceId: installation.workspace_id };
  }
  if (request.headers.has("authorization")) throw authError("AUTH_INSTALLATION_BEARER_FORBIDDEN", "installation endpoint does not accept bearer credentials");
  if (!installation.public_key) throw authError("AUTH_INSTALLATION_UNKNOWN", "installation identity is not accepted");
  const timestamp = value(request.headers, "x-manifold-timestamp");
  const timestampMs = Date.parse(timestamp); const now = options.now ?? new Date();
  if (!Number.isFinite(timestampMs) || Math.abs(now.getTime() - timestampMs) > MAX_CLOCK_SKEW_MS) throw authError("AUTH_INSTALLATION_TIMESTAMP_INVALID", "installation request timestamp is stale or invalid");
  const nonce = value(request.headers, "x-manifold-nonce");
  if (!NONCE_RE.test(nonce)) throw authError("AUTH_INSTALLATION_NONCE_INVALID", "installation request nonce is invalid");
  const encodedSignature = value(request.headers, "x-manifold-signature");
  if (!SIGNATURE_RE.test(encodedSignature)) throw authError("AUTH_INSTALLATION_SIGNATURE_INVALID", "installation request signature is invalid");
  const signature = Buffer.from(encodedSignature, "base64");
  if (signature.length !== 64) throw authError("AUTH_INSTALLATION_SIGNATURE_INVALID", "installation request signature is invalid");
  const signed = installationRequestSigningInput({ installationId, timestamp, nonce, method: request.method, pathname: url.pathname, query: canonicalQuery(url), bodyHash: await requestBodyHash(request) });
  let verified = false;
  try { verified = verify(null, signed, createPublicKey({ key: installation.public_key, format: "der", type: "spki" }), signature); } catch { verified = false; }
  if (!verified) throw authError("AUTH_INSTALLATION_SIGNATURE_INVALID", "installation request signature is invalid");
  const expiry = new Date(Math.min(timestampMs + NONCE_TTL_MS, now.getTime() + NONCE_TTL_MS));
  if (!(await claimNonce(installation.id, nonce, expiry))) throw authError("AUTH_INSTALLATION_REPLAY", "installation request nonce was already used");
  return { installationId: installation.id, workspaceId: installation.workspace_id };
}
