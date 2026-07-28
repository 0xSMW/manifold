#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONTROL_PLANE_HEALTH_PATH = "/api/v1/health";
const MAX_CONTROL_PLANE_BODY_BYTES = 16 * 1024;
const MAX_GATEWAY_BODY_BYTES = 16 * 1024;
const MAX_OBSERVATION_BODY_BYTES = 64 * 1024;
const OBSERVATION_POLL_ATTEMPTS = 6;
const OBSERVATION_POLL_INTERVAL_MS = 1_000;
const ALLOWED_DIAGNOSTIC_ENDPOINTS = new Set(["/v1/responses", "/v1/chat/completions", "/v1/embeddings"]);

function error(message) {
  return new Error(`live acceptance: ${message}`);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw error(`${name} is required`);
  return value;
}

function httpsOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw error(`${name} must be a credential-free HTTPS origin`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw error(`${name} must be a credential-free HTTPS origin`);
  }
  return url;
}

function candidateOrigin(value, name) {
  const url = httpsOrigin(value, name);
  if (url.hostname === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    throw error(`${name} must be an immutable deployed HTTPS origin`);
  }
  return url;
}

function join(origin, path) {
  return new URL(path, origin).toString();
}

async function boundedText(response, maximumBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw error("control-plane response exceeds its size limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function request(fetchImpl, url, init) {
  const signal = AbortSignal.timeout(10_000);
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal });
  } catch (cause) {
    if (signal.aborted) throw error("request timed out");
    throw error("request failed");
  }
}

function hasNoStore(response) {
  return response.headers.get("cache-control")?.toLowerCase().split(",").some((directive) => directive.trim() === "no-store") ?? false;
}

async function boundedJson(response, maximumBytes, label) {
  try { return JSON.parse(await boundedText(response, maximumBytes)); } catch (cause) {
    if (cause?.message?.startsWith("live acceptance:")) throw cause;
    throw error(`${label} returned invalid JSON`);
  }
}

function readySnapshot(payload) {
  const snapshot = payload?.snapshot;
  if (payload?.ok !== true || !snapshot || typeof snapshot.revision !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(snapshot.revision)) {
    throw error("gateway /ready did not return an ok snapshot with a revision");
  }
  if (typeof snapshot.verifiedAt !== "string" || !Number.isFinite(Date.parse(snapshot.verifiedAt))) {
    throw error("gateway /ready snapshot verifiedAt is invalid");
  }
  if (!Number.isFinite(snapshot.ageMs) || snapshot.ageMs < 0) throw error("gateway /ready snapshot ageMs is invalid");
  return snapshot;
}

function sourceRevision(env, name) {
  const value = required(env, name).toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(value)) throw error(`${name} must be a Git source revision`);
  return value;
}

function responseProvenance(response, service) {
  const deploymentId = response.headers.get("x-manifold-deployment-id")?.trim() ?? "";
  const source = response.headers.get("x-manifold-source-revision")?.trim().toLowerCase() ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deploymentId)) throw error(`${service} did not return a valid x-manifold-deployment-id`);
  if (!/^[0-9a-f]{7,64}$/.test(source)) throw error(`${service} did not return a valid x-manifold-source-revision`);
  return { deploymentId, sourceRevision: source };
}

function verifyProvenance(response, service, expectedDeploymentId, expectedSourceRevision) {
  const actual = responseProvenance(response, service);
  if (actual.deploymentId !== expectedDeploymentId) throw error(`${service} deployment provenance did not match the immutable candidate`);
  if (actual.sourceRevision !== expectedSourceRevision) throw error(`${service} source provenance did not match the immutable candidate`);
  return actual;
}

async function publicHealth(fetchImpl, controlPlaneOrigin, gatewayOrigin, report, expected = null) {
  const controlPlane = await request(fetchImpl, join(controlPlaneOrigin, CONTROL_PLANE_HEALTH_PATH));
  if (controlPlane.status !== 200) throw error(`control-plane health returned HTTP ${controlPlane.status}`);
  const controlPlaneProvenance = expected ? verifyProvenance(controlPlane, "control-plane health", expected.controlPlaneDeploymentId, expected.sourceRevision) : null;
  const payload = await boundedJson(controlPlane, MAX_CONTROL_PLANE_BODY_BYTES, "control-plane health");
  if (payload?.checks?.db !== "ok") throw error("control-plane health did not report checks.db=ok");
  report(`control-plane health: HTTP ${controlPlane.status}; database ok${controlPlaneProvenance ? `; deployment=${controlPlaneProvenance.deploymentId}; source=${controlPlaneProvenance.sourceRevision}` : ""}`);

  for (const path of ["/health", "/ready"]) {
    const response = await request(fetchImpl, join(gatewayOrigin, path));
    if (response.status !== 200) throw error(`gateway ${path} returned HTTP ${response.status}`);
    if (!hasNoStore(response)) {
      await response.body?.cancel();
      throw error(`gateway ${path} must return cache-control: no-store`);
    }
    const gatewayPayload = await boundedJson(response, MAX_GATEWAY_BODY_BYTES, `gateway ${path}`);
    if (path === "/health") {
      if (gatewayPayload?.ok !== true) throw error("gateway /health did not return ok=true");
      report("gateway /health: HTTP 200; ok");
    } else {
      const gatewayProvenance = expected ? verifyProvenance(response, "gateway /ready", expected.gatewayDeploymentId, expected.sourceRevision) : null;
      const snapshot = readySnapshot(gatewayPayload);
      report(`gateway /ready: HTTP 200; snapshot revision=${snapshot.revision}; verifiedAt=${snapshot.verifiedAt}; ageMs=${snapshot.ageMs}${gatewayProvenance ? `; deployment=${gatewayProvenance.deploymentId}; source=${gatewayProvenance.sourceRevision}` : ""}`);
    }
  }
}

function diagnosticRequest(endpoint, model) {
  if (endpoint === "/v1/chat/completions") return { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 1, temperature: 0, stream: false };
  if (endpoint === "/v1/embeddings") return { model, input: "diagnostic" };
  return { model, input: "Reply with OK.", max_output_tokens: 1 };
}

function traceId(response) {
  const value = response.headers.get("x-trace-id")?.trim() ?? "";
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw error("gateway diagnostics response did not include a valid x-trace-id");
  return value;
}

async function observationProjection(fetchImpl, controlPlaneOrigin, controlPlaneToken, trace, report, sleepImpl) {
  const url = join(controlPlaneOrigin, `/api/v1/observations/${encodeURIComponent(trace)}`);
  let lastStatus = 0;
  for (let attempt = 0; attempt < OBSERVATION_POLL_ATTEMPTS; attempt += 1) {
    const response = await request(fetchImpl, url, { headers: { authorization: `Bearer ${controlPlaneToken}`, accept: "application/json" } });
    lastStatus = response.status;
    if (response.status === 200) {
      let payload;
      try { payload = JSON.parse(await boundedText(response, MAX_OBSERVATION_BODY_BYTES)); } catch (cause) {
        if (cause?.message?.startsWith("live acceptance:")) throw cause;
        throw error("control-plane observation returned invalid JSON");
      }
      if (payload?.trace_id !== trace) throw error("control-plane observation trace_id did not match gateway trace");
      if (payload.observation === null || payload.observation === undefined) throw error("control-plane observation was not projected");
      if (payload?.cost?.amount_microusd === null || payload?.cost?.amount_microusd === undefined) throw error("control-plane observation cost was not projected");
      report("control-plane observation projection: HTTP 200; observation and cost projected");
      return;
    }
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw error(`control-plane observation returned HTTP ${response.status}`);
    if (attempt + 1 < OBSERVATION_POLL_ATTEMPTS) await sleepImpl(OBSERVATION_POLL_INTERVAL_MS);
  }
  throw error(`control-plane observation did not project within the bounded interval (last HTTP ${lastStatus})`);
}

async function diagnostics(fetchImpl, controlPlaneOrigin, gatewayOrigin, env, report, sleepImpl) {
  const token = required(env, "MANIFOLD_LIVE_DIAGNOSTICS_TOKEN");
  const controlPlaneToken = required(env, "MANIFOLD_LIVE_CONTROL_PLANE_TOKEN");
  const model = required(env, "MANIFOLD_LIVE_DIAGNOSTICS_MODEL");
  const endpoint = (env.MANIFOLD_LIVE_DIAGNOSTICS_ENDPOINT ?? "/v1/responses").trim();
  if (!ALLOWED_DIAGNOSTIC_ENDPOINTS.has(endpoint)) throw error("MANIFOLD_LIVE_DIAGNOSTICS_ENDPOINT must be an allowed OpenAI-compatible path");
  const response = await request(fetchImpl, join(gatewayOrigin, endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(diagnosticRequest(endpoint, model)),
  });
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    throw error(`gateway diagnostics returned HTTP ${response.status}`);
  }
  const trace = traceId(response);
  await response.body?.cancel();
  report(`gateway diagnostics ${endpoint}: HTTP ${response.status}`);
  await observationProjection(fetchImpl, controlPlaneOrigin, controlPlaneToken, trace, report, sleepImpl);
}

export async function runLiveAcceptance({ env = process.env, fetchImpl = fetch, report = console.log, sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
  const mode = (env.MANIFOLD_LIVE_ACCEPTANCE_MODE ?? "health").trim();
  if (mode !== "health" && mode !== "diagnostics") throw error("MANIFOLD_LIVE_ACCEPTANCE_MODE must be health or diagnostics");
  const promotion = mode === "diagnostics" ? {
    controlPlaneDeploymentId: required(env, "MANIFOLD_LIVE_CONTROL_PLANE_DEPLOYMENT_ID"),
    gatewayDeploymentId: required(env, "MANIFOLD_LIVE_GATEWAY_DEPLOYMENT_ID"),
    sourceRevision: sourceRevision(env, "MANIFOLD_LIVE_SOURCE_REVISION"),
  } : null;
  if (promotion && (!/^[A-Za-z0-9_-]{1,128}$/.test(promotion.controlPlaneDeploymentId) || !/^[A-Za-z0-9_-]{1,128}$/.test(promotion.gatewayDeploymentId))) {
    throw error("immutable candidate deployment IDs must be safe identifiers");
  }
  const controlPlaneName = promotion ? "MANIFOLD_LIVE_CONTROL_PLANE_CANDIDATE_URL" : "MANIFOLD_LIVE_CONTROL_PLANE_URL";
  const gatewayName = promotion ? "MANIFOLD_LIVE_GATEWAY_CANDIDATE_URL" : "MANIFOLD_LIVE_GATEWAY_URL";
  const controlPlaneOrigin = (promotion ? candidateOrigin : httpsOrigin)(required(env, controlPlaneName), controlPlaneName);
  const gatewayOrigin = (promotion ? candidateOrigin : httpsOrigin)(required(env, gatewayName), gatewayName);
  await publicHealth(fetchImpl, controlPlaneOrigin, gatewayOrigin, report, promotion);
  if (mode === "diagnostics") await diagnostics(fetchImpl, controlPlaneOrigin, gatewayOrigin, env, report, sleepImpl);
  report(`live acceptance ${mode}: passed`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  runLiveAcceptance().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : "live acceptance: failed");
    process.exitCode = 1;
  });
}
