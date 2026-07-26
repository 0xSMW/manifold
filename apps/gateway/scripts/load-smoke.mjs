#!/usr/bin/env node

/**
 * Small, dependency-free load/soak probe for a deployed gateway.  Its output is
 * deliberately one JSON object so it can be retained as a deployment artifact.
 */

import { readFileSync } from "node:fs";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_BODY_BYTES = 1_048_576;

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function numberOption(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid ${name}`);
  return Math.floor(parsed);
}

function cleanPath(endpoint) {
  if (!endpoint) return "/health";
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function percentile(values, percent) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)];
}

async function drainCapped(body, maxBytes = MAX_RESPONSE_BYTES) {
  if (!body) return { bytes: 0, capped: false };
  const reader = body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("load probe response cap");
        return { bytes: maxBytes, capped: true };
      }
    }
    return { bytes, capped: false };
  } finally {
    reader.releaseLock();
  }
}

function errorKind(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "transport";
}

/** Runs a bounded request pool. Exported for local conformance tests. */
export async function runLoad(options) {
  const baseUrl = new URL(options.url);
  const endpoint = cleanPath(options.endpoint);
  const url = new URL(endpoint, baseUrl);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const requests = Math.max(1, Math.floor(options.requests ?? 20));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
  const expectedStatuses = new Set(options.expectedStatuses ?? [200]);
  const durationMs = options.durationMs ? Math.max(1, Math.floor(options.durationMs)) : undefined;
  const body = options.body;
  const virtualKey = options.virtualKey;
  const vercelBypassSecret = options.vercelBypassSecret;
  if (body && Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("body fixture exceeds 1 MiB");

  const startedAt = performance.now();
  const stopAt = durationMs ? startedAt + durationMs : undefined;
  const latencies = [];
  const statusCounts = {};
  const errorCounts = {};
  let completed = 0;
  let responseBytes = 0;
  let cappedResponses = 0;
  let next = 0;

  const takeWork = () => {
    if (stopAt && performance.now() >= stopAt) return false;
    if (!stopAt && next >= requests) return false;
    next += 1;
    return true;
  };
  const worker = async () => {
    while (takeWork()) {
      const began = performance.now();
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(virtualKey ? { authorization: `Bearer ${virtualKey}` } : {}),
            ...(vercelBypassSecret ? { "x-vercel-protection-bypass": vercelBypassSecret } : {}),
          },
          body,
          signal,
        });
        const drained = await drainCapped(response.body);
        responseBytes += drained.bytes;
        cappedResponses += Number(drained.capped);
        statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      } catch (error) {
        const kind = errorKind(error);
        errorCounts[kind] = (errorCounts[kind] ?? 0) + 1;
      } finally {
        latencies.push(performance.now() - began);
        completed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - startedAt;
  const unexpectedStatuses = Object.keys(statusCounts)
    .map(Number)
    .filter((status) => !expectedStatuses.has(status))
    .reduce((count, status) => count + statusCounts[status], 0);
  const transportErrors = Object.values(errorCounts).reduce((sum, count) => sum + count, 0);

  return {
    ok: unexpectedStatuses === 0 && transportErrors === 0,
    endpoint,
    requested: durationMs ? null : requests,
    completed,
    concurrency,
    durationMs: Math.round(elapsedMs),
    throughputPerSecond: elapsedMs === 0 ? 0 : Number((completed / (elapsedMs / 1_000)).toFixed(3)),
    expectedStatuses: [...expectedStatuses].sort((a, b) => a - b),
    statusCounts,
    errorCounts,
    unexpectedStatuses,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    responseBytes,
    cappedResponses,
  };
}

export function parseOptions(args, env = process.env) {
  const url = flagValue(args, "--url") ?? env.MANIFOLD_GATEWAY_URL;
  if (!url) throw new Error("--url or MANIFOLD_GATEWAY_URL is required");
  const bodyFile = flagValue(args, "--body-file") ?? env.MANIFOLD_LOAD_BODY_FILE;
  const body = bodyFile ? Buffer.from(readFileSync(bodyFile)).toString("utf8") : undefined;
  const expected = flagValue(args, "--expect-status") ?? env.MANIFOLD_EXPECT_STATUS ?? "200";
  const expectedStatuses = expected.split(",").map((value) => numberOption(value.trim(), 200, "expected status"));
  return {
    url,
    endpoint: flagValue(args, "--endpoint") ?? env.MANIFOLD_LOAD_ENDPOINT ?? "/health",
    // This is intentionally parsed for interface compatibility and deliberately never emitted.
    virtualKey: flagValue(args, "--virtual-key") ?? env.MANIFOLD_VIRTUAL_KEY,
    // Vercel Preview protection only. It is intentionally omitted from all output.
    vercelBypassSecret: flagValue(args, "--vercel-bypass-secret") ?? env.VERCEL_AUTOMATION_BYPASS_SECRET,
    body,
    concurrency: numberOption(flagValue(args, "--concurrency") ?? env.MANIFOLD_LOAD_CONCURRENCY, 1, "concurrency"),
    requests: numberOption(flagValue(args, "--requests") ?? env.MANIFOLD_LOAD_REQUESTS, 20, "requests"),
    timeoutMs: numberOption(flagValue(args, "--timeout-ms") ?? env.MANIFOLD_LOAD_TIMEOUT_MS, 10_000, "timeout-ms"),
    durationMs: flagValue(args, "--duration-s") ?? env.MANIFOLD_LOAD_DURATION_S
      ? numberOption(flagValue(args, "--duration-s") ?? env.MANIFOLD_LOAD_DURATION_S, 1, "duration-s") * 1_000
      : undefined,
    expectedStatuses,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const summary = await runLoad(options);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    // Do not render arbitrary exception messages: paths, query strings, and credentials are not artifacts.
    process.stdout.write(`${JSON.stringify({ ok: false, error: "invalid_load_configuration" })}\n`);
    process.exitCode = 1;
  }
}
