/**
 * Internal RFC 8628-shaped device authorization. `start` takes a workspace slug, allowlisted
 * client id and requested scopes; `/settings` is the phishing-resistant human verification step.
 * Device codes are opaque one-time capabilities and are persisted only as HMAC hashes.
 */
import { randomBytes } from "node:crypto";
import { keyedHash } from "@/lib/crypto";
import { ManifoldError } from "@/lib/http";

const TOKEN_SCOPES = new Set([
  "routes:read", "observations:read", "registry:read", "budgets:read", "audit:read", "system:read",
  "routes:write", "keys:read", "keys:write", "providers:read", "providers:write", "policies:read",
  "policies:write", "budgets:write", "registry:write", "config:read", "policies:approve", "config:write",
  "storage:read", "storage:write", "deployments:read", "deployments:write", "cli:approve",
]);
const VIEWER = new Set(["routes:read", "observations:read", "registry:read", "budgets:read", "audit:read", "system:read"]);
const EDITOR = new Set([...VIEWER, "routes:write", "keys:read", "keys:write", "providers:read", "providers:write", "policies:read", "policies:write", "budgets:write", "registry:write", "config:read"]);
const ADMIN = new Set([...EDITOR, "policies:approve", "config:write", "storage:read", "storage:write", "deployments:read", "deployments:write", "cli:approve"]);
const BILLING = new Set(["budgets:read", "audit:read"]);

function validation(message: string, field: string): never {
  throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path: field, message }] } });
}

export function requestedScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) validation("scopes must be a non-empty array of at most 32 scopes", "scopes");
  const scopes = [...new Set(value.map((scope) => typeof scope === "string" ? scope.trim() : ""))];
  if (scopes.some((scope) => !TOKEN_SCOPES.has(scope))) validation("scopes contains an unsupported or wildcard scope", "scopes");
  return scopes;
}

export function scopesBoundedByRole(scopes: unknown, role: string): string[] {
  const requested = requestedScopes(scopes);
  const ceiling = role === "owner" ? TOKEN_SCOPES : role === "admin" ? ADMIN : role === "editor" ? EDITOR : role === "viewer" ? VIEWER : role === "billing" ? BILLING : new Set<string>();
  if (requested.some((scope) => !ceiling.has(scope))) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "requested scopes exceed the approving member's role ceiling", reasonCodes: ["CLI_SCOPE_ROLE_CEILING"] });
  }
  return requested;
}

export function allowedClient(clientId: unknown): { id: string; name: string } {
  if (typeof clientId !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(clientId)) validation("clientId must be a stable client identifier", "clientId");
  const configured = process.env.MANIFOLD_CLI_CLIENT_IDS ?? "manifold-cli,mfctl";
  const ids = new Set(configured.split(",").map((id) => id.trim()).filter(Boolean));
  if (!ids.has(clientId)) throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "unrecognized CLI client", reasonCodes: ["CLI_CLIENT_UNTRUSTED"] });
  return { id: clientId, name: clientId === "mfctl" ? "mfctl compatibility CLI" : "Manifold CLI" };
}

export function verificationOrigin(): string {
  const raw = process.env.MANIFOLD_CONSOLE_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error("MANIFOLD_CONSOLE_ORIGIN must be an absolute HTTPS origin without path or credentials");
  }
}

export function newDeviceCode(): string { return `mfd_${randomBytes(32).toString("base64url")}`; }
export function newUserCode(): string { const value = randomBytes(5).toString("hex").toUpperCase(); return `${value.slice(0, 5)}-${value.slice(5)}`; }
export function deviceHash(code: string): Buffer { return keyedHash(code); }
