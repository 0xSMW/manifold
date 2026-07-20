// ssrfCheck(url, allowlist) — SPEC §2.8 / §14.4 outbound URL policy, enforced before any
// provider call. Rules: https only; host ∈ the target allowlist; no loopback / link-local /
// RFC-1918 / unique-local destinations. This check operates on the URL/host literal; the
// runtime Fetcher additionally does DNS-pinned resolution (resolve once, pin to the validated
// address, no rebind) — that lives in the platform adapter because it needs node:dns.
export interface SsrfPolicy {
  /** Allow http:// (default false — https only, §14.4). Relaxed only for local test upstreams. */
  allowInsecureHttp?: boolean;
  /** Allow loopback / private addresses (default false). Relaxed only for local test upstreams. */
  allowPrivate?: boolean;
}

export type SsrfResult = { ok: true } | { ok: false; reason: string };

/** Strict production defaults (§14.4). */
export const STRICT_SSRF: Required<SsrfPolicy> = {
  allowInsecureHttp: false,
  allowPrivate: false,
};

function isIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

function isPrivateIpv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC-1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC-1918 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // Strip brackets if present.
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80")) return true; // link-local fe80::/10
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) {
    const o = isIpv4(mapped[1]!);
    return o ? isPrivateIpv4(o) : true;
  }
  return false;
}

/** True for hostnames that name the local host or private zones by name. */
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true; // cloud metadata endpoint
  return false;
}

export function ssrfCheck(
  rawUrl: string,
  allowlist: readonly string[],
  policy: SsrfPolicy = STRICT_SSRF,
): SsrfResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed url" };
  }

  const scheme = url.protocol.replace(/:$/, "");
  if (scheme === "http") {
    if (!policy.allowInsecureHttp) return { ok: false, reason: "scheme must be https" };
  } else if (scheme !== "https") {
    return { ok: false, reason: `scheme '${scheme}' not allowed` };
  }

  const host = url.hostname; // no port, no userinfo
  const isBracketedV6 = rawUrl.includes("[") && host.includes(":");

  if (!policy.allowPrivate) {
    const v4 = isIpv4(host);
    if (v4 && isPrivateIpv4(v4)) return { ok: false, reason: `blocked private address ${host}` };
    if ((isBracketedV6 || host.includes(":")) && isPrivateIpv6(host)) {
      return { ok: false, reason: `blocked private address ${host}` };
    }
    if (isPrivateHostname(host)) return { ok: false, reason: `blocked private host ${host}` };
  }

  // Host must be explicitly allowlisted (§14.4). Empty allowlist = fail closed.
  const allowed = allowlist.some((h) => h.toLowerCase() === host.toLowerCase());
  if (!allowed) return { ok: false, reason: `host ${host} not in egress allowlist` };

  return { ok: true };
}
