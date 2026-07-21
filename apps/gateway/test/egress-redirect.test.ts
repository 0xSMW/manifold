// Adversarial tests for the provider-egress Fetcher's REDIRECT handling (SPEC §14.4).
//
// BUG (redirect SSRF + credential exfil): `globalThis.fetch(req)` follows 3xx redirects by default
// with NO re-check. An allowlisted upstream that returns `302 Location: http://169.254.169.254/`
// (or `https://evil.example/`) would be followed WITH the injected `x-api-key`/`Authorization`
// still attached — leaking the provider secret to an attacker-chosen host or the cloud metadata
// endpoint. The Fetcher must NOT auto-follow: it re-validates each Location (scheme + private-IP +
// same-host) and refuses cross-host / private / non-allowlisted redirects.
//
// BUG (DNS name → private address): a hostname that resolves to a loopback/RFC-1918 address must
// be blocked, checking ALL resolved families (v4 and v6), not just the first.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { EgressFetcher, type HostResolver } from "../src/adapters.ts";

const SECRET = "sk-ant-SECRET-must-never-leak-to-a-redirect-target";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

// ── (1) 302 → a DIFFERENT (non-allowlisted) host must NOT receive the secret ──────────────────
test("EgressFetcher refuses a 302 to a non-allowlisted host — secret never reaches the redirect target", async () => {
  let sinkHits = 0;
  let sinkSawSecret = false;
  const sink = createServer((reqIn, res) => {
    sinkHits++;
    if (reqIn.headers["x-api-key"] === SECRET) sinkSawSecret = true;
    res.writeHead(200);
    res.end("sink");
  });
  const sinkPort = await listen(sink);
  after(() => sink.close());

  // The allowlisted origin (127.0.0.1) redirects to a DIFFERENT host ("localhost") = the sink.
  const upstream = createServer((_reqIn, res) => {
    res.writeHead(302, { location: `http://localhost:${sinkPort}/steal` });
    res.end();
  });
  const upstreamPort = await listen(upstream);
  after(() => upstream.close());

  // allowPrivate/http relaxed so the ORIGIN is reachable; the cross-host redirect is the attack.
  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: true });
  const req = new Request(`http://127.0.0.1:${upstreamPort}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": SECRET },
    body: "{}",
  });

  await assert.rejects(fetcher.fetch(req), /redirect/i, "must refuse the cross-host redirect");
  assert.equal(sinkHits, 0, "the redirect target must NEVER be contacted");
  assert.equal(sinkSawSecret, false, "the injected secret must NEVER reach the redirect target");
});

// ── (2) 302 → a loopback / RFC-1918 / metadata host must be refused ───────────────────────────
for (const location of [
  "http://169.254.169.254/latest/meta-data/", // cloud metadata
  "http://10.0.0.1/internal", // RFC-1918
  "https://evil.example/steal", // attacker-controlled non-allowlisted host
]) {
  test(`EgressFetcher refuses a 302 → ${location}`, async () => {
    const upstream = createServer((_reqIn, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    const port = await listen(upstream);
    after(() => upstream.close());

    const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: true });
    const req = new Request(`http://127.0.0.1:${port}/`, { headers: { "x-api-key": SECRET } });
    await assert.rejects(fetcher.fetch(req), /redirect/i);
  });
}

// ── (2b) 302 → the SAME host but a DIFFERENT port must NOT receive the secret ──────────────────
// BUG: the redirect guard compared only `hostname`, so a same-host redirect to a different port
// (e.g. `https://api.example.com:8443/steal`) was treated as "same host" and followed WITH the
// injected secret attached — a listener on another port is a different destination the per-target
// allowlist never vetted.
test("EgressFetcher refuses a same-host DIFFERENT-PORT redirect — secret never reaches the other port", async () => {
  let sinkHits = 0;
  let sinkSawSecret = false;
  const sink = createServer((reqIn, res) => {
    sinkHits++;
    if (reqIn.headers["x-api-key"] === SECRET) sinkSawSecret = true;
    res.writeHead(200);
    res.end("sink");
  });
  const sinkPort = await listen(sink);
  after(() => sink.close());

  // Same host (127.0.0.1) as the sink, but the upstream listens on a DIFFERENT port.
  const upstream = createServer((_reqIn, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/steal` });
    res.end();
  });
  const upstreamPort = await listen(upstream);
  after(() => upstream.close());
  assert.notEqual(upstreamPort, sinkPort, "the two servers must be on different ports");

  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: true });
  const req = new Request(`http://127.0.0.1:${upstreamPort}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": SECRET },
    body: "{}",
  });

  await assert.rejects(fetcher.fetch(req), /redirect/i, "must refuse the same-host different-port redirect");
  assert.equal(sinkHits, 0, "the redirect target on the other port must NEVER be contacted");
  assert.equal(sinkSawSecret, false, "the injected secret must NEVER reach the other port");
});

// ── (2c) 302 → the SAME host:port but downgrading https → http must be refused ─────────────────
// A real TLS upstream isn't needed to exercise this: stub `globalThis.fetch` so the origin request
// is seen as `https://api.example.com:8443/...` (same explicit port as the redirect target, so the
// host/port guard above would pass) while the 302 Location downgrades to `http://` on that SAME
// host:port — only the dedicated downgrade check can catch this.
test("EgressFetcher refuses a same-host:port scheme downgrade on redirect (https origin → http Location)", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let redirectTargetHit = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.example.com:8443/v1/messages") {
      return new Response(null, { status: 302, headers: { location: "http://api.example.com:8443/steal" } });
    }
    if (url === "http://api.example.com:8443/steal") {
      redirectTargetHit = true;
      return new Response("stolen", { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;

  // Stub the resolver too — no real DNS/network in this test, `api.example.com` just needs to
  // resolve to a public address so the (unrelated) DNS-rebind gate doesn't get in the way.
  const resolver: HostResolver = async () => [{ address: "93.184.216.34" }];
  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: false }, resolver);
  const req = new Request("https://api.example.com:8443/v1/messages", {
    headers: { "x-api-key": SECRET },
  });
  await assert.rejects(fetcher.fetch(req), /downgrade/i, "must refuse the https → http downgrade");
  assert.equal(redirectTargetHit, false, "the downgraded target must NEVER be contacted");
});

// ── (3) a hostname that RESOLVES to a private address is blocked (all families) ───────────────
test("EgressFetcher blocks a hostname that resolves to a private/loopback address", async () => {
  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: false });
  await assert.rejects(
    fetcher.fetch(new Request("http://localhost/")),
    /blocked private address/,
    "localhost resolves to a loopback address and must be blocked",
  );
});

// ── (4) a same-host, same-scheme redirect is still allowed to proceed (no false-positive) ─────
test("EgressFetcher follows a SAME-host redirect (does not over-block legitimate 3xx)", async () => {
  let finalHits = 0;
  const upstream = createServer((reqIn, res) => {
    if (reqIn.url === "/final") {
      finalHits++;
      res.writeHead(200);
      res.end("done");
      return;
    }
    res.writeHead(302, { location: "/final" }); // relative → same host
    res.end();
  });
  const port = await listen(upstream);
  after(() => upstream.close());

  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: true });
  const res = await fetcher.fetch(new Request(`http://127.0.0.1:${port}/start`));
  assert.equal(res.status, 200);
  assert.equal(finalHits, 1, "the same-host redirect target should be reached");
});

// ── DNS-rebind defense (§14.4): a hostile DNS answer that points a name at a private/metadata address
// must be blocked at validation, BEFORE any request is issued. These inject the resolver to simulate
// the rebind answer deterministically (no real DNS). NOTE: this is the resolve-then-validate defense;
// full connection PINNING to the exact validated IP (closing the fetch-time re-resolution window) is a
// documented residual that needs a custom dispatcher — not claimed here.
test("DNS rebind: a hostname resolving to cloud-metadata is blocked before dispatch", async () => {
  const rebind: HostResolver = async () => [{ address: "169.254.169.254" }]; // hostile answer
  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: false }, rebind);
  await assert.rejects(
    fetcher.fetch(new Request("https://provider.example.com/v1/messages")),
    /blocked private address 169\.254\.169\.254/,
    "a name resolving to 169.254.169.254 must be refused, never dispatched",
  );
});

test("DNS rebind: a name resolving to public AND private is blocked (any-private-blocks, dual-stack)", async () => {
  const mixed: HostResolver = async () => [{ address: "8.8.8.8" }, { address: "10.0.0.5" }];
  const fetcher = new EgressFetcher({ allowInsecureHttp: true, allowPrivate: false }, mixed);
  await assert.rejects(
    fetcher.fetch(new Request("https://dual.example.com/")),
    /blocked private address 10\.0\.0\.5/,
    "a private address in ANY resolved family blocks the whole request",
  );
});
