// Adversarial regression tests for the SSRF/egress policy (SPEC §2.8/§14.4).
// Each case is a real encoding an attacker would try to reach a private/loopback host past
// the allowlist. The host is ALLOWLISTED in every case, so the ONLY thing that can block is
// the private-address/hostname classifier — this isolates the SSRF logic, not the allowlist.
// History: `::ffff:127.0.0.1` (normalizes to `::ffff:7f00:1`), the expanded IPv6 loopback,
// and trailing-dot `localhost.` all BYPASSED before this test existed.
import test from "node:test";
import assert from "node:assert/strict";
import { ssrfCheck, isPrivateIp } from "../src/ssrf.ts";

const ALLOW_PRIVATE_OFF = { allowInsecureHttp: false, allowPrivate: false };

// URLs that MUST be blocked (private/loopback/link-local by some encoding), host allowlisted.
const mustBlock = [
  "https://127.0.0.1/",
  "https://2130706433/", // decimal 127.0.0.1
  "https://0x7f000001/", // hex 127.0.0.1
  "https://127.1/", // short-form loopback
  "https://[::1]/",
  "https://[0:0:0:0:0:0:0:1]/", // expanded IPv6 loopback
  "https://[::ffff:7f00:1]/", // hex IPv4-mapped loopback
  "https://[::ffff:127.0.0.1]/", // dotted IPv4-mapped loopback
  "https://localhost/",
  "https://localhost./", // trailing-dot FQDN loopback
  "https://LocalHost/", // case
  "https://foo.internal/",
  "https://10.0.0.5/",
  "https://172.16.0.1/",
  "https://192.168.1.1/",
  "https://169.254.169.254/", // cloud metadata
  "https://[fc00::1]/", // unique-local
  "https://[fe80::1]/", // link-local
  "https://0.0.0.0/",
  "https://metadata.google.internal/",
  "https://[::7f00:1]/", // IPv4-COMPATIBLE ::hex:hex loopback (127.0.0.1) — first 6 groups zero
  "https://[::127.0.0.1]/", // IPv4-COMPATIBLE ::a.b.c.d loopback (dotted tail)
  "https://[::a9fe:a9fe]/", // IPv4-COMPATIBLE link-local/metadata 169.254.169.254
  "https://[::a00:1]/", // IPv4-COMPATIBLE RFC-1918 10.0.0.1
  "https://100.100.100.200/", // CGNAT 100.64.0.0/10 (cloud metadata on some providers)
  "https://100.64.0.1/", // CGNAT lower bound
  "https://100.127.255.255/", // CGNAT upper bound
  "https://[64:ff9b::a9fe:a9fe]/", // NAT64 64:ff9b::/96 embedding 169.254.169.254 (metadata)
];

for (const url of mustBlock) {
  test(`ssrfCheck blocks ${url}`, () => {
    const host = new URL(url).hostname;
    const r = ssrfCheck(url, [host], ALLOW_PRIVATE_OFF); // host allowlisted on purpose
    assert.equal(r.ok, false, `expected BLOCK but ssrfCheck allowed ${url}`);
  });
}

test("ssrfCheck allows a genuine public allowlisted host", () => {
  assert.deepEqual(ssrfCheck("https://api.anthropic.com/v1/messages", ["api.anthropic.com"], ALLOW_PRIVATE_OFF), {
    ok: true,
  });
});

test("ssrfCheck rejects http scheme by default", () => {
  const r = ssrfCheck("http://api.anthropic.com/", ["api.anthropic.com"], ALLOW_PRIVATE_OFF);
  assert.equal(r.ok, false);
});

test("ssrfCheck fails closed on empty allowlist even for a public host", () => {
  const r = ssrfCheck("https://api.anthropic.com/", [], ALLOW_PRIVATE_OFF);
  assert.equal(r.ok, false);
});

test("ssrfCheck rejects a public host not on the allowlist", () => {
  const r = ssrfCheck("https://evil.example.com/", ["api.anthropic.com"], ALLOW_PRIVATE_OFF);
  assert.equal(r.ok, false);
});

// isPrivateIp is the classifier the runtime Fetcher runs on the RESOLVED address.
const privateIps = [
  "127.0.0.1",
  "0:0:0:0:0:0:0:1",
  "::1",
  "::ffff:7f00:1", // hex IPv4-mapped loopback
  "::ffff:127.0.0.1",
  "fc00::1",
  "fd12:3456::1",
  "fe80::1",
  "10.1.2.3",
  "169.254.169.254",
  // IPv4-COMPATIBLE IPv6 (first 6 groups zero, embedded v4 in the last 2) — hex and dotted forms.
  "::7f00:1", // 127.0.0.1 (hex) — regression: was FALSE before the classifier fix
  "::127.0.0.1", // 127.0.0.1 (dotted)
  "::a9fe:a9fe", // 169.254.169.254 link-local/metadata
  "::a00:1", // 10.0.0.1 RFC-1918
  // CGNAT 100.64.0.0/10 (used as a metadata/shared range on some clouds).
  "100.64.0.0", // lower bound
  "100.100.100.200",
  "100.127.255.255", // upper bound
  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) embedding a private/metadata v4.
  "64:ff9b::a9fe:a9fe", // 169.254.169.254 (cloud metadata) via NAT64
  "64:ff9b::7f00:1", // 127.0.0.1 (loopback) via NAT64
  "64:ff9b::a00:1", // 10.0.0.1 (RFC-1918) via NAT64
];
for (const ip of privateIps) {
  test(`isPrivateIp('${ip}') === true`, () => assert.equal(isPrivateIp(ip), true));
}
// Public addresses that must NOT be misclassified — including the boundaries just OUTSIDE CGNAT.
const publicIps = [
  "8.8.8.8",
  "1.1.1.1",
  "2606:4700:4700::1111",
  "100.63.255.255", // one below CGNAT (100.64.0.0/10)
  "100.128.0.1", // one above CGNAT
  "99.64.0.1", // shares the second octet but not the first
  "64:ff9b::808:808", // NAT64-wrapped 8.8.8.8 — a wrapped PUBLIC v4 must stay public (no false block)
]; // real public v4/v6
for (const ip of publicIps) {
  test(`isPrivateIp('${ip}') === false`, () => assert.equal(isPrivateIp(ip), false));
}
