#!/usr/bin/env node
// Remote clients cannot infer gateway RSS from their own process. This probe only passes when the
// deployment exposes a separate, authenticated observation endpoint with gateway-process samples.
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const required = (env, name) => { if (!env[name]) throw new Error(`missing required environment: ${name}`); return env[name]; };
export async function consumeStream(body) { if (!body) throw new Error("target returned no response body"); const reader = body.getReader(); let bytes = 0; try { while (true) { const next = await reader.read(); if (next.done) return bytes; bytes += next.value.byteLength; } } finally { reader.releaseLock(); } }
export async function runFlatMemoryGate(env = process.env) {
  const url = required(env, "MANIFOLD_FLAT_MEMORY_TARGET_URL");
  const probeUrl = required(env, "MANIFOLD_GATEWAY_MEMORY_PROBE_URL");
  const virtualKey = required(env, "MANIFOLD_VIRTUAL_KEY");
  if (env.MANIFOLD_GATEWAY_MEMORY_CONTRACT !== "v1") throw new Error("missing reliable gateway memory-observation contract: set MANIFOLD_GATEWAY_MEMORY_CONTRACT=v1");
  const expectedBytes = Number(env.MANIFOLD_FLAT_MEMORY_BYTES ?? GIB), maxRssDelta = Number(env.MANIFOLD_FLAT_MEMORY_MAX_RSS_DELTA_BYTES ?? 128 * MIB);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !Number.isSafeInteger(maxRssDelta) || maxRssDelta < 0) throw new Error("invalid flat-memory limits");
  const headers = { authorization: `Bearer ${virtualKey}` };
  const response = await fetch(url, { headers }); if (!response.ok) throw new Error(`target returned HTTP ${response.status}`);
  const bytes = await consumeStream(response.body); if (bytes !== expectedBytes) throw new Error(`expected ${expectedBytes} bytes, received ${bytes}`);
  const probe = await fetch(probeUrl, { headers }); if (!probe.ok) throw new Error(`gateway memory probe returned HTTP ${probe.status}`);
  const observation = await probe.json(); const baselineRss = Number(observation.baselineRssBytes), peakRss = Number(observation.peakRssBytes);
  if (!Number.isFinite(baselineRss) || !Number.isFinite(peakRss) || peakRss < baselineRss) throw new Error("gateway memory probe returned invalid RSS observation");
  if (observation.bytes !== undefined && Number(observation.bytes) !== bytes) throw new Error("gateway memory probe byte count does not match streamed response");
  const rssDelta = peakRss - baselineRss; if (rssDelta > maxRssDelta) throw new Error(`gateway RSS delta ${rssDelta} exceeds ${maxRssDelta}`);
  return { ok: true, bytes, baselineRss, peakRss, rssDelta, maxRssDelta };
}
if (import.meta.url === `file://${process.argv[1]}`) runFlatMemoryGate().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`flat-memory release gate failed: ${error.message}\n`); process.exitCode = 1; });
