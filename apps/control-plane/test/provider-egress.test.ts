import assert from "node:assert/strict";
import test from "node:test";
import { buildPinnedHttpsRequestOptions, ControlEgressError, executeControlEgress } from "../lib/control-egress.ts";

const PUBLIC_RESOLVER = async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];

test("control egress enforces HTTPS and an exact allowed host before fetch", async () => {
  let calls = 0;
  await assert.rejects(
    executeControlEgress(
      { url: "http://api.example.com/v1/models", allowedHosts: ["api.example.com"] },
      {
        resolve: PUBLIC_RESOLVER,
        fetch: async () => {
          calls += 1;
          return new Response();
        },
      },
    ),
    (error: unknown) =>
      error instanceof ControlEgressError && error.code === "EGRESS_POLICY",
  );
  await assert.rejects(
    executeControlEgress(
      { url: "https://evil.example/v1/models", allowedHosts: ["api.example.com"] },
      {
        resolve: PUBLIC_RESOLVER,
        fetch: async () => {
          calls += 1;
          return new Response();
        },
      },
    ),
    (error: unknown) =>
      error instanceof ControlEgressError && error.code === "EGRESS_POLICY",
  );
  assert.equal(calls, 0);
});

test("control egress sends a bounded caller POST only to the pinned allowed host", async () => {
  let method = "";
  let body = "";
  await executeControlEgress(
    { url: "https://collector.example/events", allowedHosts: ["collector.example"], method: "POST", body: "{\"v\":1}", headers: { "content-type": "application/json" } },
    { resolve: async () => ["93.184.216.34"], fetch: async (request) => { method = request.method; body = await request.text(); return new Response("ok", { status: 202 }); } },
  );
  assert.equal(method, "POST");
  assert.equal(body, "{\"v\":1}");
});

test("control egress rejects a hostname when any DNS answer is private", async () => {
  let fetched = false;
  await assert.rejects(
    executeControlEgress(
      { url: "https://api.example.com/v1/models", allowedHosts: ["api.example.com"] },
      {
        resolve: async () => ["93.184.216.34", "169.254.169.254"],
        fetch: async () => {
          fetched = true;
          return new Response();
        },
      },
    ),
    (error: unknown) =>
      error instanceof ControlEgressError && error.code === "EGRESS_POLICY",
  );
  assert.equal(fetched, false);
});

test("validated DNS address is passed to the transport and pins HTTPS lookup", async () => {
  let destination:
    | { hostname: string; address: string; family: 4 | 6 }
    | undefined;
  await executeControlEgress(
    { url: "https://api.example.com/v1/models", allowedHosts: ["api.example.com"] },
    {
      resolve: async () => ["93.184.216.34"],
      fetch: async (request, validated) => {
        destination = validated;
        const options = buildPinnedHttpsRequestOptions(request, validated);
        assert.equal(options.hostname, "api.example.com");
        assert.equal(options.servername, "api.example.com");
        assert.equal(options.path, "/v1/models");
        const pinned = await new Promise<{ address: string; family: number }>(
          (resolve, reject) => {
            const lookup = options.lookup;
            assert.equal(typeof lookup, "function");
            (lookup as (
              hostname: string,
              options: object,
              callback: (error: Error | null, address: string, family: number) => void,
            ) => void)(
              "api.example.com",
              {},
              (error, address, family) =>
                error ? reject(error) : resolve({ address, family }),
            );
          },
        );
        assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
        return new Response("ok");
      },
    },
  );
  assert.deepEqual(destination, {
    hostname: "api.example.com",
    address: "93.184.216.34",
    family: 4,
  });
});

test("control egress follows same-host redirects manually without forwarding credentials", async () => {
  const seen: Request[] = [];
  const response = await executeControlEgress(
    {
      url: "https://api.example.com/start",
      allowedHosts: ["api.example.com"],
      headers: {
        authorization: "Bearer top-secret",
        "x-api-key": "top-secret",
        accept: "application/json",
      },
    },
    {
      resolve: PUBLIC_RESOLVER,
      fetch: async (request) => {
        seen.push(request);
        return seen.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://api.example.com/final" },
            })
          : new Response("ok", { status: 200 });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.redirects, 1);
  assert.equal(seen[0]?.headers.get("authorization"), "Bearer top-secret");
  assert.equal(seen[1]?.headers.get("authorization"), null);
  assert.equal(seen[1]?.headers.get("x-api-key"), null);
  assert.equal(seen[1]?.headers.get("accept"), "application/json");
});

test("control egress refuses cross-host redirects", async () => {
  await assert.rejects(
    executeControlEgress(
      {
        url: "https://api.example.com/start",
        allowedHosts: ["api.example.com", "other.example.com"],
        headers: { authorization: "Bearer secret" },
      },
      {
        resolve: PUBLIC_RESOLVER,
        fetch: async () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://other.example.com/final" },
          }),
      },
    ),
    (error: unknown) =>
      error instanceof ControlEgressError && error.code === "EGRESS_REDIRECT",
  );
});

test("control egress bounds response reads", async () => {
  const response = await executeControlEgress(
    { url: "https://api.example.com/data", allowedHosts: ["api.example.com"] },
    {
      resolve: PUBLIC_RESOLVER,
      maxResponseBytes: 4,
      fetch: async () => new Response("abcdefgh"),
    },
  );
  assert.equal(new TextDecoder().decode(response.body), "abcd");
  assert.equal(response.truncated, true);
});

test("control egress applies an overall timeout", async () => {
  await assert.rejects(
    executeControlEgress(
      { url: "https://api.example.com/slow", allowedHosts: ["api.example.com"] },
      {
        resolve: PUBLIC_RESOLVER,
        timeoutMs: 10,
        fetch: async (request) =>
          new Promise<Response>((_resolve, reject) => {
            if (request.signal.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            request.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      },
    ),
    (error: unknown) =>
      error instanceof ControlEgressError && error.code === "EGRESS_TIMEOUT",
  );
});
