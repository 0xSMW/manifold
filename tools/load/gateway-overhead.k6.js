import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { evaluateReleaseSummary, positiveInteger } from "./budget-contract.mjs";

const profile = __ENV.MANIFOLD_LOAD_PROFILE;
const baseUrl = __ENV.MANIFOLD_GATEWAY_URL;
const endpoint = __ENV.MANIFOLD_LOAD_ENDPOINT || "/v1/chat/completions";
const virtualKey = __ENV.MANIFOLD_VIRTUAL_KEY;
const baseline = Number(__ENV.MANIFOLD_PROVIDER_BASELINE_MS || 0);
const budget = profile === "enterprise_egress" ? Number(__ENV.MANIFOLD_ENTERPRISE_OVERHEAD_P99_MS || 23) : Number(__ENV.MANIFOLD_PUBLIC_OVERHEAD_P99_MS || 15);
const intendedCap = profile === "enterprise_egress" ? positiveInteger(__ENV.MANIFOLD_HARD_BUDGET_SUCCESS_CAP) : undefined;
const addedOverhead = new Trend("gateway_added_overhead_ms", true);
const dispatchedSuccesses = new Counter("dispatched_successes");
const budgetDenials = new Counter("budget_reserve_denials");
const contractFailures = new Rate("hard_budget_contract_failures");
const ingestLag = new Trend("ingest_lag_ms", true);

if (!baseUrl || !virtualKey || !["public_app", "enterprise_egress"].includes(profile)) fail("missing required environment: MANIFOLD_GATEWAY_URL, MANIFOLD_VIRTUAL_KEY, and MANIFOLD_LOAD_PROFILE (public_app|enterprise_egress)");

const thresholds = {
  gateway_added_overhead_ms: [`p(99)<=${budget}`],
  dispatched_successes: [profile === "enterprise_egress" ? `count==${intendedCap}` : "count>=1"],
  hard_budget_contract_failures: ["rate==0"],
  http_req_failed: ["rate<0.001"],
  ingest_lag_ms: ["p(99)<=5000"],
};
if (profile === "enterprise_egress") thresholds.budget_reserve_denials = ["count>=1"];
export const options = { vus: Number(__ENV.MANIFOLD_LOAD_VUS || 10), duration: __ENV.MANIFOLD_LOAD_DURATION || "30s", thresholds };

function isBudgetDenied(response) {
  if (response.status !== 402) return false;
  try { return JSON.parse(response.body).error?.code === "BUDGET_RESERVE_DENIED"; } catch { return false; }
}

export default function () {
  const body = __ENV.MANIFOLD_LOAD_BODY || JSON.stringify({ model: __ENV.MANIFOLD_LOAD_MODEL || "release-gate-model", messages: [{ role: "user", content: "release probe" }], max_tokens: 1 });
  const response = http.post(`${baseUrl}${endpoint}`, body, { headers: { "content-type": "application/json", authorization: `Bearer ${virtualKey}` }, timeout: __ENV.MANIFOLD_LOAD_TIMEOUT || "30s", responseCallback: profile === "enterprise_egress" ? http.expectedStatuses(200, 402) : undefined });
  const success = response.status === 200;
  const denied = profile === "enterprise_egress" && isBudgetDenied(response);
  check(response, { "successful dispatch or valid hard-budget denial": () => success || denied });
  contractFailures.add(profile === "enterprise_egress" && !success && !denied);
  if (success) {
    // Denials were rejected before provider dispatch; never fold their latency into gateway overhead.
    dispatchedSuccesses.add(1);
    addedOverhead.add(Math.max(0, response.timings.duration - baseline));
    const ingested = response.headers["X-Manifold-Ingested-At"] || response.headers["x-manifold-ingested-at"];
    if (ingested) ingestLag.add(Math.max(0, Date.now() - Date.parse(ingested)));
  }
  if (denied) budgetDenials.add(1);
  sleep(0.1);
}

export function handleSummary(data) {
  const successful = data.metrics.dispatched_successes?.values?.count || 0;
  const denied = data.metrics.budget_reserve_denials?.values?.count || 0;
  const failure = evaluateReleaseSummary({ profile, cap: intendedCap, successfulDispatches: successful, budgetDenials: denied });
  if (failure) throw new Error(failure);
  if (!data.metrics.ingest_lag_ms?.values?.count && __ENV.MANIFOLD_REQUIRE_INGEST_LAG === "1") throw new Error("ingest lag SLO cannot be evaluated: target did not expose X-Manifold-Ingested-At on a successful dispatch");
  return { stdout: `${JSON.stringify({ profile, budgetMs: budget, dispatchedSuccesses: successful, budgetReserveDenials: denied }, null, 2)}\n` };
}
