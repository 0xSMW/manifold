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
import { EgressFetcher } from "../src/adapters.ts";

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
