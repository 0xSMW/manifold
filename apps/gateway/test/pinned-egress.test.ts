import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { PinnedEgressFetcher, type PinnedHostResolver } from "../src/pinnedEgress.ts";

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

const localPolicy = { allowInsecureHttp: true, allowPrivate: true };

test("pins the TCP connection to the validated answer when DNS changes afterwards", async () => {
  const validated = createServer((_req, res) => res.end("validated-peer"));
  const port = await listen(validated);
  let calls = 0;
  const resolver: PinnedHostResolver = async () => {
    calls += 1;
    // A resolver that would rebind on the connection lookup must never receive a
    // second call: the dispatcher is pinned to the first validated address.
    return [{ address: calls === 1 ? "127.0.0.1" : "127.0.0.2" }];
  };

  try {
    const fetcher = new PinnedEgressFetcher(localPolicy, resolver);
    const response = await fetcher.fetch(new Request(`http://provider.test:${port}/v1/chat`));
    assert.equal(await response.text(), "validated-peer");
    assert.equal(calls, 1);
  } finally {
    await close(validated);
  }
});

test("rejects a dual-stack DNS answer when any answer is private", async () => {
  const resolver: PinnedHostResolver = async () => [
    { address: "8.8.8.8" },
    { address: "fd00::1" },
  ];
  const fetcher = new PinnedEgressFetcher({ allowInsecureHttp: true }, resolver);
  await assert.rejects(
    fetcher.fetch(new Request("http://provider.test/v1/models")),
    /blocked private address fd00::1/,
  );
});

test("refuses a same-scheme redirect to a different host before sending a second request", async () => {
  let destinationHits = 0;
  const destination = createServer((_req, res) => {
    destinationHits += 1;
    res.end("secret leaked");
  });
  const destinationPort = await listen(destination);
  const origin = createServer((_req, res) => {
    res.writeHead(302, { location: `http://other.test:${destinationPort}/steal` });
    res.end();
  });
  const originPort = await listen(origin);
  const resolver: PinnedHostResolver = async () => [{ address: "127.0.0.1" }];

  try {
    const fetcher = new PinnedEgressFetcher(localPolicy, resolver);
    await assert.rejects(
      fetcher.fetch(new Request(`http://origin.test:${originPort}/start`, { headers: { authorization: "Bearer secret" } })),
      /refused cross-host redirect/,
    );
    assert.equal(destinationHits, 0);
  } finally {
    await close(origin);
    await close(destination);
  }
});

test("manually follows an allowed same-host redirect", async () => {
  let finalHits = 0;
  const body = "followed";
  const server = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    finalHits += 1;
    const compressed = gzipSync(body);
    res.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
      "x-provider-trace": "preserved",
    });
    res.end(compressed);
  });
  const port = await listen(server);
  const resolver: PinnedHostResolver = async () => [{ address: "127.0.0.1" }];

  try {
    const fetcher = new PinnedEgressFetcher(localPolicy, resolver);
    const response = await fetcher.fetch(new Request(`http://provider.test:${port}/start`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("x-provider-trace"), "preserved");
    assert.equal(await response.text(), body);
    assert.equal(finalHits, 1);
  } finally {
    await close(server);
  }
});
