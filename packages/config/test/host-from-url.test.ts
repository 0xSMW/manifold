// Regression test for review bug #10: config must emit the URL *hostname* (no port) into a
// target's allowedHosts, because the gateway's ssrfCheck allowlist-matches URL.hostname. If
// build.ts used URL.host, a ported base_url (https://proxy.example:8443) would produce an
// allowlist entry "proxy.example:8443" that never matches → SSRF_BLOCKED for a valid target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostFromUrl } from "@manifold/config";

test("bug #10: hostFromUrl strips the port (matches ssrfCheck's URL.hostname)", () => {
  assert.equal(hostFromUrl("https://proxy.example:8443"), "proxy.example");
  assert.equal(hostFromUrl("https://api.anthropic.com:443"), "api.anthropic.com");
  assert.equal(hostFromUrl("https://api.anthropic.com"), "api.anthropic.com");
  assert.equal(hostFromUrl("https://api.anthropic.com/v1/messages"), "api.anthropic.com");
  assert.equal(hostFromUrl("not a url"), null);
  // sanity: this is exactly what a URL's hostname is (never includes the port)
  assert.equal(new URL("https://proxy.example:8443").hostname, "proxy.example");
});
