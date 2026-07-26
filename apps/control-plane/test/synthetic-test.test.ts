import assert from "node:assert/strict";
import test from "node:test";
import { executeSyntheticGatewayRequest, SyntheticTestError } from "../lib/synthetic-test.ts";

const publicResolver = async () => ["93.184.216.34"];

test("synthetic gateway requests bind the configured origin to the published hostname", async () => {
  let called = false;
  await assert.rejects(
    executeSyntheticGatewayRequest({ gatewayUrl: "https://other.example", diagnosticsToken: "diagnostic-key", hostname: "gateway.example", endpointKind: "chat", publicName: "public-chat" }, {
      resolve: publicResolver,
      fetch: async () => { called = true; return new Response(); },
    }),
    (error: unknown) => error instanceof SyntheticTestError && error.code === "SYNTHETIC_POLICY",
  );
  assert.equal(called, false);
});

test("synthetic gateway requests pin public DNS, authenticate, and expose only trace metadata", async () => {
  let request: Request | undefined;
  let destination: unknown;
  const result = await executeSyntheticGatewayRequest({ gatewayUrl: "https://gateway.example", diagnosticsToken: "diagnostic-key", hostname: "gateway.example", endpointKind: "chat", publicName: "public-chat" }, {
    resolve: publicResolver,
    fetch: async (seen, validated) => {
      request = seen; destination = validated;
      return new Response(JSON.stringify({ secret: "must never leave helper" }), { status: 200, headers: { "x-trace-id": "01JTRACE" } });
    },
  });
  assert.deepEqual(destination, { hostname: "gateway.example", address: "93.184.216.34", family: 4 });
  assert.equal(request?.url, "https://gateway.example/v1/chat/completions");
  assert.equal(request?.headers.get("authorization"), "Bearer diagnostic-key");
  assert.deepEqual(await request?.json(), { model: "public-chat", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, temperature: 0, stream: false });
  assert.deepEqual(result, { gatewayStatus: 200, traceId: "01JTRACE", responseTruncated: false });
});

test("synthetic gateway requests reject private DNS and redirects", async () => {
  await assert.rejects(
    executeSyntheticGatewayRequest({ gatewayUrl: "https://gateway.example", diagnosticsToken: "diagnostic-key", hostname: "gateway.example", endpointKind: "embeddings", publicName: "public-embed" }, { resolve: async () => ["127.0.0.1"] }),
    (error: unknown) => error instanceof SyntheticTestError && error.code === "SYNTHETIC_POLICY",
  );
  await assert.rejects(
    executeSyntheticGatewayRequest({ gatewayUrl: "https://gateway.example", diagnosticsToken: "diagnostic-key", hostname: "gateway.example", endpointKind: "responses", publicName: "public-response" }, { resolve: publicResolver, fetch: async () => new Response(null, { status: 302, headers: { location: "https://gateway.example/elsewhere" } }) }),
    (error: unknown) => error instanceof SyntheticTestError && error.code === "SYNTHETIC_POLICY",
  );
});
