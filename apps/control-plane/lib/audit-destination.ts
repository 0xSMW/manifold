import { randomBytes } from "node:crypto";
import { resolveDataKek, sealAesGcm, utf8, wrapDek } from "@manifold/crypto";
import { ManifoldError } from "@/lib/http";

export interface DestinationInput { kind: "webhook" | "siem"; label: string; endpoint: string; secret: string | null; }

export function parseDestination(value: Record<string, unknown>, partial = false): Partial<DestinationInput> {
  const allowed = new Set(["kind", "label", "endpoint", "secret"]);
  const issues = Object.keys(value).filter((key) => !allowed.has(key)).map((path) => ({ path, message: "unknown field" }));
  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const label = typeof value.label === "string" ? value.label.trim() : undefined;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : undefined;
  const secret = typeof value.secret === "string" ? value.secret : value.secret === null ? null : undefined;
  if (!partial || kind !== undefined) if (kind !== "webhook" && kind !== "siem") issues.push({ path: "kind", message: "must be webhook or siem" });
  if (!partial || label !== undefined) if (!label || label.length > 120) issues.push({ path: "label", message: "must be 1-120 characters" });
  if (!partial || endpoint !== undefined) {
    try { if (!endpoint || new URL(endpoint).protocol !== "https") throw new Error(); } catch { issues.push({ path: "endpoint", message: "must be an HTTPS URL" }); }
  }
  if (typeof secret === "string" && secret.length > 4096) issues.push({ path: "secret", message: "must be at most 4096 characters" });
  if (issues.length) throw new ManifoldError({ status: 422, code: "VALIDATION", message: "audit destination request is invalid", reasonCodes: [], details: { issues } });
  return { kind: kind as DestinationInput["kind"] | undefined, label, endpoint, secret };
}

export function encryptDestination(id: string, endpoint: string, secret: string | null) {
  const dek = new Uint8Array(randomBytes(32));
  const kek = resolveDataKek(process.env.MANIFOLD_DATA_KEK);
  const aad = utf8(`manifold:audit-destination:v1:${id}`);
  return {
    wrappedDek: Buffer.from(wrapDek(kek, dek)),
    endpoint: Buffer.from(sealAesGcm(dek, utf8(endpoint), aad)),
    secret: secret === null ? null : Buffer.from(sealAesGcm(dek, utf8(secret), aad)),
  };
}
