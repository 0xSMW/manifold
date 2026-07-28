import assert from "node:assert/strict";
import test from "node:test";
import { KeysApi, ModelsApi, ProvidersApi, RoutesApi, StorageContracts } from "../src/index.ts";

test("provider wire contracts pin lifecycle projections and strict mutation bodies", () => {
  const list = { data: [{ id: "pc_1", provider: "openai", label: "Primary", baseUrl: null, status: "valid", lastValidatedAt: null, createdAt: "2026-07-25T00:00:00.000Z" }], nextCursor: null };
  assert.deepEqual(ProvidersApi.listResponse.parse(list), list);
  assert.equal(ProvidersApi.createRequest.safeParse({ provider: "openai", label: "Primary", secret: "sk", accidental: true }).success, false);
  assert.equal(ProvidersApi.rotateRequest.safeParse({ secret: "sk", extra: true }).success, false);
  const rotated = { id: "pc_1", status: "unvalidated", rotated: true, plaintextStored: false };
  assert.deepEqual(ProvidersApi.rotateResponse.parse(rotated), rotated);
});

test("key copy-once fields are only accepted in mint and rotate results", () => {
  const copyOnce = { keyId: "key_2", displayPrefix: "sk-mf-…", plaintext: "sk-mf-secret", published: true };
  assert.deepEqual(KeysApi.mintResponse.parse(copyOnce), copyOnce);
  assert.equal(KeysApi.detailResponse.safeParse({ ...copyOnce, id: "key_2" }).success, false);
  assert.equal(KeysApi.mintRequest.safeParse({ profileId: "prf_1", rateLimit: { rpm: 10, unexpected: 1 } }).success, false);
  assert.equal(KeysApi.patchRequest.safeParse({}).success, false);
});

test("route contracts reject nested drift and pin list cursor shape", () => {
  const list = { data: [{ id: "rt_1", publicName: "chat", endpointKind: "chat", installationId: "ins_1", activeRevisionId: "rev_1", status: "staged", targetCount: 1, healthyTargetCount: 1, createdAt: "2026-07-25T00:00:00.000Z" }], nextCursor: null };
  assert.deepEqual(RoutesApi.listResponse.parse(list), list);
  assert.equal(RoutesApi.createRequest.safeParse({ installationId: "ins_1", publicName: "chat", targets: [{ providerCredentialId: "pc_1", offeringId: "off_1", leaked: true }] }).success, false);
  assert.equal(RoutesApi.testRequest.safeParse({ profileId: "prf_1", extra: true }).success, false);
});

test("route contracts allow only the target-scoped provider idempotency replay shape", () => {
  const request = {
    installationId: "ins_1",
    publicName: "chat",
    targets: [{ clientRef: "primary", providerCredentialId: "pc_1", offeringId: "off_1" }],
    retryPolicy: {
      maxAttempts: 2,
      providerIdempotency: { targetRef: "primary", headerName: "idempotency-key" },
    },
  };
  assert.deepEqual(RoutesApi.createRequest.parse(request), request);
  assert.equal(RoutesApi.createRequest.safeParse({
    ...request,
    retryPolicy: { providerIdempotency: { targetRef: "primary", headerName: "Idempotency-Key" } },
  }).success, false);
  assert.equal(RoutesApi.createRequest.safeParse({
    ...request,
    retryPolicy: { providerIdempotency: { targetRef: "primary", headerName: "idempotency-key", scope: "provider" } },
  }).success, false);
});

test("model contracts cover list/detail price variants and override bodies", () => {
  const item = { id: "off_1", canonicalModel: { id: "mdl_1", slug: "gpt", displayName: "GPT", family: null, modalityIn: ["text"], modalityOut: ["text"], openWeights: false, source: "catalog" }, provider: "openai", providerModelId: "gpt", endpointKinds: ["chat"], adapterRevision: "v1", capabilities: {}, limits: { contextTokens: "128000", outputTokens: null }, region: null, routable: true, activePrice: { id: "price_1", fidelity: "catalog", source: "catalog", effectiveFrom: "2026-07-25T00:00:00.000Z", currency: "USD", unit: "per_mtok", inputPerMtokMicrousd: "1", outputPerMtokMicrousd: "2" } };
  assert.deepEqual(ModelsApi.listResponse.parse({ data: [item], nextCursor: null }), { data: [item], nextCursor: null });
  assert.equal(ModelsApi.overrideRequest.safeParse({ offeringId: "off_1", inputPerMtokMicrousd: "2", injected: true }).success, false);
  assert.equal(ModelsApi.overrideResponse.safeParse({ id: "pr_1", offeringId: "off_1", fidelity: "operator_override", contentHash: "hash", status: "staged", publishRequired: true, replay: false, plaintext: "never" }).success, false);
});

test("models list query is strict, bounded, and preserves its normalized golden", () => {
  const query = { limit: "25", provider: "openai", endpointKind: "chat", q: "gpt", routable: "true", family: "gpt", priceFidelity: "provider_verified" };
  assert.deepEqual(ModelsApi.listQuery.parse(query), { cursor: null, limit: 25, provider: "openai", endpointKind: "chat", query: "gpt", routable: "true", family: "gpt", priceFidelity: "provider_verified" });
  assert.equal(ModelsApi.listQuery.safeParse({ ...query, unknown: "no" }).success, false);
  assert.equal(ModelsApi.listQuery.safeParse({ ...query, limit: "0" }).success, false);
  assert.equal(ModelsApi.listQuery.safeParse({ ...query, routable: "sometimes" }).success, false);
});

test("storage retention contracts pin strict named query, request, and response shapes", () => {
  const request = { observationRetentionDays: 30, exportTarget: "object_storage", exportLocation: "s3://exports/manifold", enabled: true };
  const response = { configured: true, observationRetentionDays: 30, exportTarget: "object_storage", exportConfigured: true, destructiveDeletion: "eligible_after_verified_export", remediation: null, updatedAt: "2026-07-25T00:00:00.000Z" };
  assert.deepEqual(StorageContracts.retentionQuery.parse({}), {});
  assert.equal(StorageContracts.retentionQuery.safeParse({ unknown: "x" }).success, false);
  assert.deepEqual(StorageContracts.retentionRequest.parse(request), request);
  assert.equal(StorageContracts.retentionRequest.safeParse({ ...request, destructiveDeletion: "forged" }).success, false);
  assert.deepEqual(StorageContracts.retentionResponse.parse(response), response);
  assert.equal(StorageContracts.retentionResponse.safeParse({ ...response, exportLocation: "leaked" }).success, false);
});

test("storage overview accepts a pending compaction before it has been claimed", () => {
  const overview = {
    measuredAt: null, usedBytes: null, ceilingBytes: null, usedPct: null, tier: null,
    pressure: null, thresholds: null, tables: null, indexesBytes: null, toastBytes: null,
    growthBytesPerDay: null, forecastExhaustionAt: null,
    retention: { available: true, observationRetentionDays: null, exportTarget: "disabled", exportConfigured: false, enabled: false, destructiveDeletion: "blocked", checkpoints: {} },
    lastCompaction: { id: "job_1", status: "pending", queuedAt: "2026-07-26T00:00:00.000Z", claimedAt: null, updatedAt: "2026-07-26T00:00:00.000Z", error: null, freedBytes: null, progress: null },
  };
  assert.deepEqual(StorageContracts.overviewResponse.parse(overview), overview);
});
