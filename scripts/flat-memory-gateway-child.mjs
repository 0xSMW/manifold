#!/usr/bin/env node
// This child is the local gateway process: it imports the built core artifact and routes a
// request through handleRequest into a generated provider ReadableStream.
import { createHmac } from "node:crypto";
import { handleRequest } from "../packages/gateway-core/dist/index.js";

const bytes = Number(process.env.MANIFOLD_FLAT_MEMORY_BYTES);
const chunkBytes = Number(process.env.MANIFOLD_FLAT_MEMORY_CHUNK_BYTES ?? 64 * 1024);
const forceGrowth = Number(process.env.MANIFOLD_FLAT_MEMORY_FORCE_GROWTH_BYTES ?? 0);
if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || !Number.isSafeInteger(forceGrowth) || forceGrowth < 0) throw new Error("invalid flat-memory child limits");

const key = "flat-memory-release-key";
const pepper = new TextEncoder().encode("flat-memory-release-pepper");
const keyHash = createHmac("sha256", pepper).update(key).digest("hex");
const crypto = {
  async hmacSha256(keyBytes, message) { return new Uint8Array(createHmac("sha256", keyBytes).update(message).digest()); },
  randomId(prefix) { return `${prefix}_flat_memory`; },
  sealAesGcm(_keyBytes, value) { return value; },
  openAesGcm(_keyBytes, value) { return value; },
};
const snapshot = {
  meta: { schema: "manifold.snapshot.v1", installationId: "flat-memory-gate", revision: "flat-memory-gate", contentHash: "sha256:flat-memory-gate", builtAt: new Date().toISOString(), signature: "", signingKeyId: "test" },
  profiles: { "gateway.test": { id: "public_app", mode: "public_app", policyRevision: null, defaultRouteSet: null } },
  keys: { [keyHash]: { id: "flat-memory-key", profileId: "public_app", scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null } },
  routes: { "public_app:chat:release-gate-model": { routeId: "flat-memory-route", revision: "flat-memory-route", mode: "ordered", timeoutMs: 600_000, capturePolicyId: "none", targets: [{ offeringId: "flat-memory-offering", credentialId: "flat-memory-credential", dekId: "flat-memory-dek", credentialCiphertext: "", wrappedDek: "", weight: 1, priority: 0, baseUrl: "https://provider.example", region: null, allowedHosts: ["provider.example"], authInject: { headers: { authorization: "Bearer ${secret}" } } }] } },
  offerings: { "flat-memory-offering": { providerModelId: "provider-release-gate-model" } },
};
function providerStream(totalBytes) {
  const chunk = new Uint8Array(chunkBytes);
  let remaining = totalBytes;
  return new ReadableStream({ pull(controller) { if (remaining === 0) return controller.close(); const size = Math.min(chunk.byteLength, remaining); remaining -= size; controller.enqueue(size === chunk.byteLength ? chunk : chunk.subarray(0, size)); } });
}
async function consume(body) {
  if (!body) throw new Error("gateway returned no body");
  const reader = body.getReader(); let received = 0;
  try { while (true) { const next = await reader.read(); if (next.done) return received; received += next.value.byteLength; } } finally { reader.releaseLock(); }
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
emit({ event: "ready", pid: process.pid, gatewayCoreArtifact: "packages/gateway-core/dist/index.js" });
for await (const chunk of process.stdin) {
  if (chunk.toString().trim() !== "start") continue;
  // This test-only knob proves the parent observes the gateway process rather than its client.
  const retained = forceGrowth ? Buffer.alloc(forceGrowth, 1) : undefined;
  const response = await handleRequest({ installationId: "flat-memory-gate", snapshot, crypto, clock: { now: () => new Date() }, ingest: { async emit() {} }, fetcher: { async fetch() { return new Response(providerStream(bytes), { status: 200, headers: { "content-type": "application/octet-stream" } }); } }, pepper, resolveSecret: async () => "fixture-provider-secret" }, new Request("https://gateway.test/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "release-gate-model", messages: [{ role: "user", content: "stream" }] }) }));
  const received = await consume(response.body);
  // Keep the forced allocation alive until after measurement/reporting.
  if (retained) retained[0] = retained[0];
  emit({ event: "complete", status: response.status, bytes: received });
  process.exit(response.status === 200 && received === bytes ? 0 : 1);
}
