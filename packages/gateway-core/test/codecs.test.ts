import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RequestCodecError,
  decodeOpenAiRequest,
  toOpenAiProviderRequest,
} from "../src/codecs.ts";

function post(path: string, body: BodyInit, headers: HeadersInit = { "content-type": "application/json" }): Request {
  return new Request(`https://gateway.example${path}`, { method: "POST", headers, body });
}

async function codecFailure(request: Request, expected: { status: number; code: string }): Promise<void> {
  await assert.rejects(
    () => decodeOpenAiRequest(request),
    (error: unknown) => error instanceof RequestCodecError && error.status === expected.status && error.code === expected.code,
  );
}

test("recognizes the supported endpoint and method pairs", async () => {
  for (const [path, kind] of [
    ["/v1/chat/completions", "chat"],
    ["/v1/responses", "responses"],
    ["/v1/embeddings", "embeddings"],
  ] as const) {
    const decoded = await decodeOpenAiRequest(post(path, '{"model":"public-model"}'));
    assert.equal(decoded.endpointKind, kind);
    assert.equal(decoded.publicModel, "public-model");
  }
  const models = await decodeOpenAiRequest(new Request("https://gateway.example/v1/models?after=a&after=b", { method: "GET" }));
  assert.equal(models.endpointKind, "models");
  assert.equal(models.publicModel, undefined);
});

test("rejects unsupported endpoints, methods, and content types with typed safe errors", async () => {
  await codecFailure(post("/v1/audio/speech", "{}"), { status: 404, code: "ROUTE_ENDPOINT_UNSUPPORTED" });
  await codecFailure(new Request("https://gateway.example/v1/models", { method: "POST" }), { status: 405, code: "REQUEST_METHOD_UNSUPPORTED" });
  await codecFailure(post("/v1/responses", "{}", { "content-type": "text/plain" }), { status: 415, code: "REQUEST_CONTENT_TYPE_UNSUPPORTED" });
});

test("enforces the byte cap while reading chunked request bodies", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"model":"'));
      controller.enqueue(new TextEncoder().encode("much-too-large"));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const request = new Request("https://gateway.example/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    () => decodeOpenAiRequest(request, { maxBodyBytes: 10 }),
    (error: unknown) => error instanceof RequestCodecError && error.status === 413 && error.code === "POLICY_BODY_TOO_LARGE",
  );
});

test("rejects malformed JSON and a missing or non-string model", async () => {
  await codecFailure(post("/v1/chat/completions", "{"), { status: 400, code: "REQUEST_JSON_MALFORMED" });
  await codecFailure(post("/v1/chat/completions", "{}"), { status: 400, code: "REQUEST_MODEL_REQUIRED" });
  await codecFailure(post("/v1/chat/completions", '{"model":42}'), { status: 400, code: "REQUEST_MODEL_REQUIRED" });
});

test("preserves unknown JSON fields and repeated query parameters in the replay and provider request", async () => {
  const decoded = await decodeOpenAiRequest(post(
    "/v1/responses?include=reasoning&include=output_text",
    '{"model":"public","input":[{"role":"user","content":"hi"}],"store":false,"future_field":{"nested":[1,true]}}',
  ));
  assert.deepEqual(decoded.body?.future_field, { nested: [1, true] });
  assert.equal(new URL(decoded.request.url).search, "?include=reasoning&include=output_text");
  assert.deepEqual(await decoded.request.json(), decoded.body);

  const provider = toOpenAiProviderRequest(decoded, { providerModelId: "provider-responses-model" });
  assert.equal(new URL(provider.url).pathname, "/v1/responses");
  assert.equal(new URL(provider.url).search, "?include=reasoning&include=output_text");
  assert.deepEqual(await provider.json(), {
    model: "provider-responses-model",
    input: [{ role: "user", content: "hi" }],
    store: false,
    future_field: { nested: [1, true] },
  });
});

test("provider transform replaces only model for chat and embeddings", async () => {
  for (const path of ["/v1/chat/completions", "/v1/embeddings"]) {
    const decoded = await decodeOpenAiRequest(post(path, '{"model":"public","extra":{"keep":true}}'));
    const provider = toOpenAiProviderRequest(decoded, { providerModelId: "provider-model" });
    assert.equal((await provider.json() as { model: string }).model, "provider-model");
    assert.equal(new URL(provider.url).pathname, path);
  }
});
