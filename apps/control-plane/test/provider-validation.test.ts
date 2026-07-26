import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderValidationRequest, defaultProviderAllowedHosts, validateProviderCredential } from "../lib/provider-validation.ts";

const PUBLIC_RESOLVER = async () => ["203.0.113.10"];

test("provider request construction uses non-mutating provider-specific probes", () => {
  const openai = buildProviderValidationRequest({
    provider: "openai",
    secret: "openai-secret",
    baseUrl: null,
    allowedHosts: defaultProviderAllowedHosts("openai"),
  });
  assert.ok(openai.request);
  assert.equal(openai.request.method ?? "GET", "GET");
  assert.equal(openai.request.url, "https://api.openai.com/v1/models");
  assert.equal(new Headers(openai.request.headers).get("authorization"), "Bearer openai-secret");

  const anthropic = buildProviderValidationRequest({
    provider: "anthropic",
    secret: "anthropic-secret",
    baseUrl: null,
    allowedHosts: defaultProviderAllowedHosts("anthropic"),
  });
  assert.ok(anthropic.request);
  assert.equal(anthropic.request.url, "https://api.anthropic.com/v1/models");
  assert.equal(new Headers(anthropic.request.headers).get("x-api-key"), "anthropic-secret");
  assert.equal(
    new Headers(anthropic.request.headers).get("anthropic-version"),
    "2023-06-01",
  );

  const google = buildProviderValidationRequest({
    provider: "google",
    secret: "google-secret",
    baseUrl: null,
    allowedHosts: defaultProviderAllowedHosts("google"),
  });
  assert.ok(google.request);
  assert.equal(
    google.request.url,
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(new Headers(google.request.headers).get("x-goog-api-key"), "google-secret");
  assert.equal(new URL(google.request.url).search, "");

  const azure = buildProviderValidationRequest({
    provider: "azure-openai",
    secret: "azure-secret",
    baseUrl: "https://tenant.openai.azure.com",
    allowedHosts: ["tenant.openai.azure.com"],
  });
  assert.ok(azure.request);
  assert.equal(
    azure.request.url,
    "https://tenant.openai.azure.com/openai/models?api-version=2024-10-21",
  );
  assert.equal(new Headers(azure.request.headers).get("api-key"), "azure-secret");
});

test("OpenAI-compatible validation treats a configured base URL as its API root", () => {
  const cases = [
    ["https://api.openai.com", "https://api.openai.com/v1/models"],
    [
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    ],
    ["https://example.com/v1", "https://example.com/v1/models"],
  ] as const;

  for (const [baseUrl, expectedUrl] of cases) {
    const built = buildProviderValidationRequest({
      provider: "openai-compatible",
      secret: "test-secret",
      baseUrl: `${baseUrl}?ignored=true#fragment`,
      allowedHosts: [new URL(baseUrl).hostname],
    });
    assert.ok(built.request);
    assert.equal(built.request.url, expectedUrl);
    assert.equal(new Headers(built.request.headers).get("authorization"), "Bearer test-secret");
  }
});

test("Bedrock returns an honest unsupported outcome without network access", async () => {
  let fetched = false;
  const result = await validateProviderCredential(
    {
      provider: "amazon-bedrock",
      secret: "aws-secret",
      baseUrl: null,
      allowedHosts: [],
    },
    {
      resolve: PUBLIC_RESOLVER,
      fetch: async () => {
        fetched = true;
        return new Response();
      },
    },
  );
  assert.equal(fetched, false);
  assert.equal(result.outcome, "unsupported");
  assert.equal(result.classification, "PROVIDER_UNSUPPORTED");
});

test("provider validation classifies auth failures and redacts echoed secrets", async () => {
  const result = await validateProviderCredential(
    {
      provider: "openai",
      secret: "do-not-leak",
      baseUrl: null,
      allowedHosts: ["api.openai.com"],
    },
    {
      resolve: PUBLIC_RESOLVER,
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { message: "API key do-not-leak is invalid" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    },
  );
  assert.equal(result.outcome, "invalid");
  assert.equal(result.classification, "PROVIDER_HTTP_AUTH");
  assert.equal(result.upstreamStatus, 401);
  assert.equal(result.message.includes("do-not-leak"), false);
  assert.equal(result.message, "API key [REDACTED] is invalid");
});

test("provider validation preserves plain-text upstream errors with secret redaction", async () => {
  const result = await validateProviderCredential(
    {
      provider: "openai",
      secret: "plain-secret",
      baseUrl: null,
      allowedHosts: ["api.openai.com"],
    },
    {
      resolve: PUBLIC_RESOLVER,
      fetch: async () => new Response("credential plain-secret denied", { status: 403 }),
    },
  );
  assert.equal(result.message, "credential [REDACTED] denied");
  assert.equal(result.classification, "PROVIDER_HTTP_AUTH");
});

test("provider validation marks a successful non-mutating probe valid", async () => {
  let request: Request | null = null;
  const result = await validateProviderCredential(
    {
      provider: "anthropic",
      secret: "secret",
      baseUrl: null,
      allowedHosts: ["api.anthropic.com"],
    },
    {
      resolve: PUBLIC_RESOLVER,
      fetch: async (seen) => {
        request = seen;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    },
  );
  assert.equal(result.outcome, "valid");
  assert.equal(result.classification, "PROVIDER_VALID");
  assert.equal((request as Request | null)?.method, "GET");
});
