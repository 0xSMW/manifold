// ssrfCheck(url, allowlist) — SPEC §2.8 / §14.4 outbound URL policy, enforced before any
// provider call. Rules: https only; host ∈ the target allowlist; no loopback / link-local /
// RFC-1918 / unique-local destinations. This check operates on the URL/host literal; the
// runtime Fetcher additionally does DNS resolution and re-checks the resolved address with
// the SAME classifier exported here (isPrivateIp), so encoding tricks and name→private
// resolution are caught in one place.
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

function parseIpv4(host: string): number[] | null {
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

/**
 * Parse an IPv6 literal (bracketed or not, zone-id tolerated, with an optional embedded
 * dotted-IPv4 tail) into its 8 16-bit hextets, or null if it is not IPv6.
 */
function parseIpv6(raw: string): number[] | null {
  let h = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const pct = h.indexOf("%");
  if (pct >= 0) h = h.slice(0, pct); // strip zone id
  if (!h.includes(":")) return null;
  // Normalize an embedded dotted-IPv4 tail (::ffff:127.0.0.1) into two hextets so the hex
  // and dotted forms classify identically.
  const v4m = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4m) {
    const o = parseIpv4(v4m[2]!);
    if (!o) return null;
    h = `${v4m[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === "" ? NaN : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isPrivateIpv6Groups(g: number[]): boolean {
  const first = g[0]!;
  const headZero = g.slice(0, 7).every((x) => x === 0);
  if (headZero && (g[7] === 1 || g[7] === 0)) return true; // ::1 loopback, :: unspecified
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  // IPv4-mapped ::ffff:a.b.c.d  (first 5 groups zero, 6th == 0xffff)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIpv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  return false;
}

/** Classify any IP literal (v4 or v6, any legal encoding) as private/loopback/link-local/ULA. */
export function isPrivateIp(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  const v6 = parseIpv6(host);
  if (v6) return isPrivateIpv6Groups(v6);
  return false;
}

/** True for hostnames that name the local host or private zones by name (trailing dot tolerated). */
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.+$/, ""); // strip trailing dot(s): "localhost." == "localhost"
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

  const host = url.hostname; // no port, no userinfo; WHATWG-normalized

  if (!policy.allowPrivate) {
    if (isPrivateIp(host)) return { ok: false, reason: `blocked private address ${host}` };
    if (isPrivateHostname(host)) return { ok: false, reason: `blocked private host ${host}` };
  }

  // Host must be explicitly allowlisted (§14.4). Empty allowlist = fail closed.
  const normHost = host.toLowerCase().replace(/\.+$/, "");
  const allowed = allowlist.some((h) => h.toLowerCase().replace(/\.+$/, "") === normHost);
  if (!allowed) return { ok: false, reason: `host ${host} not in egress allowlist` };

  return { ok: true };
}
