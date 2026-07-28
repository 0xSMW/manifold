import assert from "node:assert/strict";
import test from "node:test";
import { runLiveAcceptance } from "../scripts/run-live-acceptance.mjs";

const baseEnv = {
  MANIFOLD_LIVE_CONTROL_PLANE_URL: "https://control-plane.example",
  MANIFOLD_LIVE_GATEWAY_URL: "https://gateway.example",
};

const candidateEnv = {
  MANIFOLD_LIVE_ACCEPTANCE_MODE: "diagnostics",
  MANIFOLD_LIVE_CONTROL_PLANE_CANDIDATE_URL: "https://control-plane-candidate.example",
  MANIFOLD_LIVE_GATEWAY_CANDIDATE_URL: "https://gateway-candidate.example",
  MANIFOLD_LIVE_CONTROL_PLANE_DEPLOYMENT_ID: "dpl_control_1",
  MANIFOLD_LIVE_GATEWAY_DEPLOYMENT_ID: "dpl_gateway_1",
  MANIFOLD_LIVE_SOURCE_REVISION: "a1b2c3d4",
};

const provenanceHeaders = {
  "x-manifold-deployment-id": "dpl_control_1",
  "x-manifold-source-revision": "a1b2c3d4",
};

function response(status, body = "", headers = {}) {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

function gatewayHealth(path, headers = {}) {
  if (path.endsWith("/health")) return response(200, JSON.stringify({ ok: true }), { "cache-control": "no-store" });
  if (path.endsWith("/ready")) return response(200, JSON.stringify({ ok: true, snapshot: { revision: "revision_1", verifiedAt: "2026-07-28T00:00:00.000Z", ageMs: 0 } }), { "cache-control": "no-store", ...headers });
  return null;
}

test("health mode requires DB-backed control-plane health and ready gateway", async () => {
  const seen = [];
  const report = [];
  await runLiveAcceptance({
    env: baseEnv,
    report: (line) => report.push(line),
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }));
      return gatewayHealth(String(url));
    },
  });
  assert.deepEqual(seen, ["https://control-plane.example/api/v1/health", "https://gateway.example/health", "https://gateway.example/ready"]);
  assert.ok(report.includes("live acceptance health: passed"));
});

test("health mode fails when the control-plane database is not healthy", async () => {
  await assert.rejects(() => runLiveAcceptance({
    env: baseEnv,
    fetchImpl: async (url) => String(url).endsWith("/api/v1/health") ? response(200, JSON.stringify({ checks: { db: "unreachable" } })) : gatewayHealth(String(url)),
    report: () => {},
  }), /checks\.db=ok/);
});

test("diagnostics mode fails closed without its dedicated gateway token, control-plane token, and model", async () => {
  await assert.rejects(() => runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv },
    fetchImpl: async (url) => String(url).endsWith("/api/v1/health") ? response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders) : gatewayHealth(String(url), { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" }),
    report: () => {},
  }), /MANIFOLD_LIVE_DIAGNOSTICS_TOKEN is required/);

  await assert.rejects(() => runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token" },
    fetchImpl: async (url) => String(url).endsWith("/api/v1/health") ? response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders) : gatewayHealth(String(url), { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" }),
    report: () => {},
  }), /MANIFOLD_LIVE_CONTROL_PLANE_TOKEN is required/);
});

test("diagnostics mode sends bounded authenticated gateway and control-plane requests without reporting private data", async () => {
  const reports = [];
  const calls = [];
  const token = "live-diagnostic-token";
  const controlPlaneToken = "live-control-plane-token";
  const trace = "trace_live_1";
  await runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: token, MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: controlPlaneToken, MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model" },
    report: (line) => reports.push(line),
    fetchImpl: async (url, init = {}) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders);
      if (String(url).includes("/api/v1/observations/")) return response(200, JSON.stringify({ trace_id: trace, observation: { id: "obs_1" }, cost: { amount_microusd: "0" } }));
      if (String(url).endsWith("/v1/responses")) return new Response('{"provider_response":"must-not-be-reported"}', { status: 200, headers: { "x-trace-id": trace } });
      return gatewayHealth(String(url), { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" });
    },
  });
  const gatewayCall = calls.find(([url]) => url.endsWith("/v1/responses"));
  const observationCall = calls.find(([url]) => url.endsWith(`/api/v1/observations/${trace}`));
  assert.equal(gatewayCall[0], "https://gateway-candidate.example/v1/responses");
  assert.equal(gatewayCall[1].headers.authorization, `Bearer ${token}`);
  assert.match(gatewayCall[1].body, /max_output_tokens":1/);
  assert.equal(observationCall[1].headers.authorization, `Bearer ${controlPlaneToken}`);
  assert.doesNotMatch(reports.join("\n"), new RegExp(`${token}|${controlPlaneToken}|${trace}|must-not-be-reported`));
});

test("diagnostics mode rejects a successful gateway response without a trace header", async () => {
  await assert.rejects(() => runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token", MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: "control-plane-token", MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders);
      if (target.endsWith("/v1/responses")) return response(200);
      return gatewayHealth(target, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" });
    },
    report: () => {},
  }), /x-trace-id/);
});

test("diagnostics mode polls a delayed observation projection", async () => {
  let observationAttempts = 0;
  const sleeps = [];
  await runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token", MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: "control-plane-token", MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model" },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders);
      if (target.endsWith("/v1/responses")) return new Response("", { status: 200, headers: { "x-trace-id": "trace_delayed" } });
      if (target.includes("/api/v1/observations/")) {
        observationAttempts += 1;
        return observationAttempts < 3 ? response(404) : response(200, JSON.stringify({ trace_id: "trace_delayed", observation: { id: "obs_1" }, cost: { amount_microusd: "5" } }));
      }
      return gatewayHealth(target, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" });
    },
    report: () => {},
  });
  assert.equal(observationAttempts, 3);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("diagnostics mode rejects a projected observation without cost", async () => {
  await assert.rejects(() => runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token", MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: "control-plane-token", MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders);
      if (target.endsWith("/v1/responses")) return new Response("", { status: 200, headers: { "x-trace-id": "trace_missing_cost" } });
      if (target.includes("/api/v1/observations/")) return response(200, JSON.stringify({ trace_id: "trace_missing_cost", observation: { id: "obs_1" }, cost: { amount_microusd: null } }));
      return gatewayHealth(target, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" });
    },
    report: () => {},
  }), /cost was not projected/);
});

test("health mode rejects empty, malformed, or cacheable gateway health bodies", async () => {
  for (const gatewayResponse of [
    () => response(200, "{}", { "cache-control": "no-store" }),
    () => response(200, "not-json", { "cache-control": "no-store" }),
    () => response(200, JSON.stringify({ ok: true })),
  ]) {
    await assert.rejects(() => runLiveAcceptance({
      env: baseEnv,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }));
        if (target.endsWith("/health")) return gatewayResponse();
        return gatewayHealth(target);
      },
      report: () => {},
    }), /gateway \/health (did not return ok=true|returned invalid JSON|must return cache-control)/);
  }
});

test("health mode rejects malformed or incomplete gateway readiness", async () => {
  for (const readiness of [
    response(200, "{}", { "cache-control": "no-store" }),
    response(200, "not-json", { "cache-control": "no-store" }),
    response(200, JSON.stringify({ ok: true, snapshot: { revision: "", verifiedAt: "not-a-date", ageMs: -1 } }), { "cache-control": "no-store" }),
  ]) {
    await assert.rejects(() => runLiveAcceptance({
      env: baseEnv,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }));
        if (target.endsWith("/ready")) return readiness.clone();
        return gatewayHealth(target);
      },
      report: () => {},
    }), /gateway \/ready (did not return an ok snapshot|returned invalid JSON)/);
  }
});

test("candidate diagnostics reject absent, mismatched, and stale-alias service provenance", async () => {
  const diagnosticEnv = {
    ...baseEnv,
    ...candidateEnv,
    MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token",
    MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: "control-plane-token",
    MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model",
  };
  for (const [name, healthHeaders, readyHeaders, expected] of [
    ["absent", {}, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" }, /control-plane health did not return/],
    ["mismatch", { ...provenanceHeaders, "x-manifold-source-revision": "deadbeef" }, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" }, /control-plane health source provenance did not match/],
    ["stale alias", provenanceHeaders, { "x-manifold-deployment-id": "dpl_gateway_stale", "x-manifold-source-revision": "a1b2c3d4" }, /gateway \/ready deployment provenance did not match/],
  ]) {
    await assert.rejects(() => runLiveAcceptance({
      env: diagnosticEnv,
      fetchImpl: async (url) => {
        const target = String(url);
        if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), healthHeaders);
        return gatewayHealth(target, readyHeaders);
      },
      report: () => {},
    }), expected, name);
  }
});

test("candidate diagnostics reports responding-service provenance and the verified gateway snapshot revision", async () => {
  const reports = [];
  await runLiveAcceptance({
    env: { ...baseEnv, ...candidateEnv, MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: "gateway-token", MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: "control-plane-token", MANIFOLD_LIVE_DIAGNOSTICS_MODEL: "diagnostic-model" },
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/api/v1/health")) return response(200, JSON.stringify({ checks: { db: "ok" } }), provenanceHeaders);
      if (target.endsWith("/v1/responses")) return new Response("", { status: 200, headers: { "x-trace-id": "trace_provenance" } });
      if (target.includes("/api/v1/observations/")) return response(200, JSON.stringify({ trace_id: "trace_provenance", observation: { id: "obs_1" }, cost: { amount_microusd: "0" } }));
      return gatewayHealth(target, { "x-manifold-deployment-id": "dpl_gateway_1", "x-manifold-source-revision": "a1b2c3d4" });
    },
    report: (line) => reports.push(line),
  });
  assert.match(reports.join("\n"), /snapshot revision=revision_1; verifiedAt=2026-07-28T00:00:00\.000Z; ageMs=0; deployment=dpl_gateway_1; source=a1b2c3d4/);
});
