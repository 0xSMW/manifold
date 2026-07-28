import { test as base, expect, type Page, type Route } from "@playwright/test";

type Persona = "owner" | "viewer";

const now = "2026-07-24T08:00:00.000Z";
const profiles = [
  { id: "profile-public", installationId: "install-1", installationName: "Gateway one", hostname: "public.gateway.example.test", mode: "public_app", available: true },
  { id: "profile-enterprise", installationId: "install-1", installationName: "Gateway one", hostname: "enterprise.gateway.example.test", mode: "enterprise_egress", available: true },
];
const ownerScopes = [
  "audit:read", "budgets:read", "budgets:write", "config:read", "config:write",
  "deployments:read", "deployments:write", "keys:read", "keys:write",
  "observations:annotations:write", "observations:export", "observations:read",
  "policies:approve", "policies:read", "policies:write", "providers:read",
  "providers:write", "registry:read", "registry:write", "routes:read",
  "routes:write", "storage:read", "storage:write",
];

function observation(index = 0) {
  return { id: `observation-${index}`, trace_id: `trace-${String(index).padStart(4, "0")}`, profile_mode: "public_app", provider: "openai", status: "ok", route: { id: "route-1", public_name: "chat" }, model: { canonical_slug: "gpt-4.1-mini", provider_model_id: "gpt-4.1-mini" }, input_tokens: "12", output_tokens: "24", cost_microusd: "36", latency_ms: 123, occurred_at: now, failovers: 0, http_status: 200, cost: { amount_microusd: "36", fidelity: "catalog" }, reason_codes: [] };
}

function model(index: number) {
  const family = `family-${index % 3}`;
  const fidelity = index % 4 === 0 ? "provider_verified" : index % 4 === 1 ? "operator_override" : index % 4 === 2 ? "aggregator" : "unknown";
  return {
    id: `offering-${String(index).padStart(4, "0")}`,
    provider: index % 2 ? "openai" : "anthropic",
    providerModelId: `model-${String(index).padStart(4, "0")}`,
    endpointKinds: ["chat"],
    adapterRevision: "fixture",
    canonicalModel: { id: `canonical-${index}`, displayName: `Scale model ${String(index).padStart(4, "0")}`, slug: `scale-model-${String(index).padStart(4, "0")}`, family, modalityIn: [], modalityOut: [], openWeights: false, source: "fixture" },
    capabilities: { reasoning: "supported" },
    limits: { contextTokens: "128000", outputTokens: "8192" },
    region: null,
    routable: index % 2 === 0,
    activePrice: fidelity === "unknown" ? null : { id: `price-${index}`, fidelity, effectiveFrom: now, source: "fixture", currency: "USD", unit: "per_mtok", inputPerMtokMicrousd: "1000000", outputPerMtokMicrousd: "2000000" },
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function apiFixture(page: Page, persona: Persona) {
  let keyMinted = false;
  let routeCreated = false;
  let published = false;
  // The Playwright page fixture gets a new browser context for every test. Keep
  // the common API fixture at that context scope so page-level routes declared
  // by a test always take precedence, regardless of registration order.
  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace("/api/v1", "");
    const method = request.method();
    const member = { id: "member-1", email: `${persona}@example.test`, name: persona === "owner" ? "Olivia Owner" : "Vera Viewer", role: persona };
    const me = { member, role: persona, workspace: { id: "workspace-1", slug: "acme", name: "Acme", region: "us-east-1" }, scopes: persona === "owner" ? ownerScopes : ["observations:read"], availableIngressProfiles: profiles };
    if (path === "/auth/login" && method === "POST") return json(route, {});
    if (path === "/session/logout") return json(route, { ok: true });
    if (path === "/me") return json(route, me);
    if (path === "/health") return json(route, { status: "ok", ingest_lag_seconds: 0 });
    if (path === "/context") return json(route, { installations: [{ id: "install-1", name: "Gateway one", edition: "vercel", status: "active", profiles }], teams: [], costCenters: [], apps: [], budgets: [] });
    if (path === "/providers" && method === "GET") return json(route, { data: [{ id: "provider-1", provider: "openai", label: "Primary OpenAI", status: "valid", lastValidatedAt: now, createdAt: now }] });
    if (path === "/providers" && method === "POST") return json(route, { id: "provider-created", provider: "openai", label: "Production primary", status: "unvalidated", createdAt: now });
    if (path === "/models") {
      const all = Array.from({ length: url.searchParams.get("q") === "scale" ? 3_000 : 120 }, (_, index) => model(index));
      const family = url.searchParams.get("family");
      const priceFidelity = url.searchParams.get("priceFidelity");
      const filtered = all.filter((item) => (!family || item.canonicalModel.family === family) && (!priceFidelity || (priceFidelity === "unknown" ? item.activePrice === null : item.activePrice?.fidelity === priceFidelity)));
      const cursor = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 100);
      const page = url.searchParams.get("q") === "scale" && !family && !priceFidelity ? filtered : filtered.slice(cursor, cursor + limit);
      return json(route, { data: page, nextCursor: page.length && cursor + page.length < filtered.length ? String(cursor + page.length) : null });
    }
    if (path === "/routes" && method === "GET") return json(route, { data: routeCreated ? [{ id: "route-created", publicName: "support", endpointKind: "chat", activeRevisionId: "revision-1", createdAt: now }] : [] });
    if (path === "/routes" && method === "POST") { routeCreated = true; return json(route, { id: "route-created", revisionId: "revision-1", status: "staged" }); }
    if (path === "/keys" && method === "GET") return json(route, { data: keyMinted ? [{
      id: "key-1", displayPrefix: "mf_live_abc", profileId: "profile-public",
      profileMode: "public_app", scopes: ["chat:complete"], allowedAppIds: [],
      defaultAppId: null, defaultActionId: null,
      attribution: { teamId: null, costCenterId: null, budgetAccountId: null },
      rateLimit: null, expiresAt: null, lastUsedAt: null, revoked: false,
      expired: false, successorKeyId: null, successorActive: false,
      graceExpiresAt: null, rotating: false, createdAt: now,
    }] : [], nextCursor: null });
    if (path === "/keys" && method === "POST") { keyMinted = true; return json(route, { keyId: "key-1", displayPrefix: "mf_live_abc", plaintext: "mf_live_visible_once", published, scopes: ["chat:complete"] }); }
    if (path === "/budgets") return json(route, { data: [] });
    if (path === "/cost-centers") return json(route, { data: [] });
    if (path === "/usage") return json(route, { data: [{ bucket_start: now, dimension_value: "openai", dims: {}, requests: "10", input_tokens: "120", output_tokens: "240", cost_microusd: "360", errors: "0", failovers: "0", latency_ms_sum: "1230", latency_ms_p95: 123 }] });
    if (path === "/observations/summary") return json(route, { sample_count: "10", p50_ms: 123, p95_ms: 123 });
    if (path === "/observations" && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 180);
      return json(route, { data: Array.from({ length: limit }, (_, i) => observation(i)), next_cursor: null, ingest_lag_seconds: 0 });
    }
    if (path === "/observations/export" && method === "POST") return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: JSON.stringify(observation()) + "\n" });
    if (path.startsWith("/observations/") && path.split("/").length === 3 && method === "GET") {
      const trace = decodeURIComponent(path.split("/")[2]);
      return json(route, { trace_id: trace, detail_state: { state: "available", detail_compacted: false }, spans: [{ id: "span-1", kind: "gateway", occurred_at: now, duration_ms: 123, provider: { name: "openai" } }], usage: { input_tokens: 12, output_tokens: 24, fidelity: "reported" }, cost: { amount_microusd: "36", fidelity: "catalog" }, attempts: [], policy_decisions: [], capture: { state: "unavailable", note: "No capture stored" }, annotations: [], observation: { failovers: 0 }, audit: null });
    }
    if (path === "/config/plan") return json(route, { diff: routeCreated ? { routes: ["route-created"] } : {}, noop: !routeCreated });
    if (path === "/config/approvals") return json(route, { planHash: null, approvals: [] });
    if (path === "/config/history") return json(route, { installationId: "install-1", revisions: [], operations: [] });
    if (path === "/config/apply" && method === "POST") { published = true; return json(route, { revision: 1, status: "applied", gateway_confirmed: false }); }
    if (path === "/config/reconcile") return json(route, { status: "queued" });
    if (path === "/storage" && method === "GET") return json(route, { measuredAt: now, usedBytes: "1048576", ceilingBytes: "10485760", usedPct: 10, tier: "normal", pressure: { captureMode: "full", payloadSampleRate: 1, journalMode: "full", source: "persisted" }, thresholds: { warnPct: 70, highPct: 85, critPct: 95 }, tables: { observations: "524288", audit_event: "262144" }, indexesBytes: "131072", toastBytes: "0", growthBytesPerDay: "1024", forecastExhaustionAt: null, retention: { available: true, observationRetentionDays: 30, exportTarget: "disabled", exportConfigured: false, enabled: false, destructiveDeletion: "disabled", checkpoints: {} }, lastCompaction: null });
    if (path === "/policies" && method === "GET") return json(route, { data: [{ id: "policy-1", name: "Enterprise egress", activeRevisionId: "policy-revision-1", revisionCount: 1, createdAt: now, updatedAt: now }], nextCursor: null });
    if (path === "/policies/policy-1" && method === "GET") return json(route, { id: "policy-1", name: "Enterprise egress", activeRevisionId: "policy-revision-1", createdAt: now, updatedAt: now, revisions: [{ id: "policy-revision-1", contentHash: "policy-hash", createdBy: "member-1", createdAt: now, isActive: true, entitlements: [{ id: "entitlement-1", subjectKind: "all", subjectRef: null, canonicalModelId: "canonical-0", offeringId: null, effect: "allow", createdAt: now }], requestConstraints: [{ id: "constraint-1", param: "max_tokens", minValue: null, maxValue: 2048, onViolation: "clamp", createdAt: now }], dataHandlingConstraints: [], approvals: [] }] });
    if (path === "/policies/policy-1/simulate" && method === "POST") return json(route, { outcome: "clamp", reasonCodes: ["MAX_TOKENS"], clamps: { max_tokens: 2048 } });
    if (path === "/audit" && method === "GET") return json(route, { data: [], nextCursor: null });
    if (path === "/audit/destinations" && method === "GET") return json(route, { data: [] });
    if (path === "/audit/verify" && method === "GET") return json(route, { data: { verified: true, checked: 0, legacy: 0 } });
    if (path === "/deployments/install-1" && method === "GET") return json(route, { id: "install-1", name: "Gateway one", edition: "vercel", appliedConfigRevision: "revision-1", activeConfigRevision: "revision-1", lastSeenAt: now, status: "active", createdAt: now, trustedHostInvariant: "Requests are accepted only for published trusted hosts.", profiles: [{ id: "profile-public", installationId: "install-1", hostname: "public.gateway.example.test", mode: "public_app", networkExposure: "public", policyRevisionId: null, defaultRouteSet: {}, published: true, bindingStatus: "published", available: true, status: "active", trustedHostInvariant: "Exact host match", createdAt: now }] });
    if (path === "/deployments/install-1/readiness") return json(route, { installationId: "install-1", ready: true, checks: { connectivity: { ok: true, state: "connected", lastHeartbeatAt: now, heartbeatAgeSeconds: 0, freshnessThresholdSeconds: 300, reportingAvailable: true, limitation: "" }, snapshotFreshness: { ok: true, appliedRevision: "revision-1", activeRevision: "revision-1", state: "current" }, providers: { ok: true, state: "valid", configuredCredentialCount: 1, invalid: [], missingCredentialIds: [] }, snapshotServing: { available: true, activeRevision: "revision-1", contentHash: "config-hash", builtAt: now, storedAt: now, reportedServingActive: true }, clockSkew: { available: true, skewSeconds: 0, reason: "" }, installationAuthentication: { ok: true, method: "ed25519", state: "configured", verifier: "ed25519_request_signature" } } });
    if (path === "/deployments/install-1/diagnostics") return json(route, { installationId: "install-1", lastHeartbeat: { observedAt: now, appliedConfigRevision: "revision-1", installationStatus: "active", reportingAvailable: true, limitation: "" }, recentConfigOperations: [], syntheticTest: { available: false, lastResult: null, activeConfigRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", freshnessThresholdSeconds: 600, reason: "No synthetic test has run" } });
    if (path === "/settings/workspace") return json(route, { data: { id: "workspace-1", name: "Acme", slug: "acme", region: "us-east-1", storagePolicy: { ceilingBytes: "10485760", warnPct: 70, highPct: 85, critPct: 95 } } });
    if (path === "/settings/cli-auth") return json(route, { data: [{ id: "device-1", userCode: "ABCD-EFGH", status: "pending", requestedScopes: ["config:read"], client: { id: "manifold-cli", name: "Manifold CLI" }, verificationOrigin: "https://console.example.test/device", expiresAt: "2026-07-25T08:00:00.000Z", canReview: true }], nextCursor: null });
    if (["/settings/members", "/settings/teams", "/settings/cost-centers", "/settings/tokens", "/settings/apps", "/settings/alerts"].includes(path)) return json(route, { data: [], nextCursor: null });
    if (path === "/settings/danger-zone") return json(route, { data: { workspaceDeletion: { message: "Deletion requires a deliberate migration plan" }, dependencies: { members: 1, teams: 0, costCenters: 0, apps: 0, activeTokens: 0, observations: 0 } } });
    return json(route, { code: "NOT_IMPLEMENTED", message: `Unhandled fixture: ${method} ${path}` }, 404);
  });
}

export const test = base.extend<{ consolePage: Page; viewerPage: Page }>({
  consolePage: async ({ page }, use) => { await apiFixture(page, "owner"); page.setDefaultTimeout(12_000); await use(page); },
  viewerPage: async ({ page }, use) => { await apiFixture(page, "viewer"); page.setDefaultTimeout(12_000); await use(page); },
});

export { expect };
