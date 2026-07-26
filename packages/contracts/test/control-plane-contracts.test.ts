import assert from "node:assert/strict";
import test from "node:test";
import {
  AppsResponse,
  CliAuthorizationPollRequest,
  CliAuthorizationPollResponse,
  CliAuthorizationStartRequest,
  ContextResponse,
  HealthResponse,
  SessionLoginResponse,
  TeamsResponse,
  ControlPlaneEndpointContracts,
  KeyContracts,
  ProviderContracts,
  RouteContracts,
  SettingsContracts,
  ProfileContracts,
  ObservationContracts,
  UsageContracts,
  ObservationIngestContracts,
  ActiveSnapshotWireBytes,
  ConfigContracts,
  InstallationContracts,
  InternalContracts,
  StorageContracts,
  PolicyEndpointContracts,
  BudgetEndpointContracts,
  AuditEndpointContracts,
  SettingsEndpointContracts,
} from "../src/index.ts";

test("health golden contract is exact", () => {
  const golden = { status: "ok", schema: "manifold.v1", time: "2026-07-25T00:00:00.000Z", checks: { db: "ok", snapshot_store: "skipped" }, ingest_lag_seconds: null, storage_tier: null };
  assert.deepEqual(HealthResponse.parse(golden), golden);
  assert.equal(HealthResponse.safeParse({ ...golden, debug: true }).success, false);
});

test("session family response rejects accidental fields", () => {
  const golden = { member: { id: "mem_1", email: "operator@example.test", name: null, role: "owner" }, role: "owner", expiresAt: "2026-07-25T08:00:00.000Z" };
  assert.deepEqual(SessionLoginResponse.parse(golden), golden);
  assert.equal(SessionLoginResponse.safeParse({ ...golden, sourceToken: "never" }).success, false);
});

test("cli authorization request and response contracts reject unknown fields", () => {
  const start = { workspaceSlug: "acme", clientId: "manifold-cli", scopes: ["config:read"] };
  assert.deepEqual(CliAuthorizationStartRequest.parse(start), start);
  assert.equal(CliAuthorizationStartRequest.safeParse({ ...start, elevated: true }).success, false);
  assert.equal(CliAuthorizationPollRequest.safeParse({ deviceCode: "mfd_abcdefghijklmnopqrstuvwxyzABCDEF12", extra: true }).success, false);
  const approved = { status: "approved", accessToken: "mf_tok_secret", tokenType: "Bearer", scopes: ["config:read"] };
  assert.deepEqual(CliAuthorizationPollResponse.parse(approved), approved);
  assert.equal(CliAuthorizationPollResponse.safeParse({ status: "expired", interval: 5 }).success, false);
});

test("list and context family goldens preserve camelCase wire shapes", () => {
  const teams = { data: [{ id: "team_1", slug: "platform", name: "Platform", costCenterId: null, createdAt: "2026-07-25T00:00:00.000Z" }], nextCursor: null };
  assert.deepEqual(TeamsResponse.parse(teams), teams);
  assert.equal(TeamsResponse.safeParse({ ...teams, next_cursor: null }).success, false);
  const apps = { data: [{ id: "app_1", slug: "console", name: "Console", status: "active", defaultCapturePolicy: { mode: "full" }, createdAt: "2026-07-25T00:00:00.000Z", actions: [] }], nextCursor: null };
  assert.deepEqual(AppsResponse.parse(apps), apps);
  const context = { workspace: null, installations: [], apps: [], teams: [], costCenters: [], profileAvailability: [] };
  assert.deepEqual(ContextResponse.parse(context), context);
  assert.equal(ContextResponse.safeParse({ ...context, profile_availability: [] }).success, false);
});

test("every remaining endpoint family has a strict success-envelope golden", () => {
  for (const [family, contracts] of Object.entries(ControlPlaneEndpointContracts)) {
    if (["profiles", "observations", "usage"].includes(family)) continue; // exact goldens are below.
    const response = contracts.response;
    assert.ok(response, `${family} must expose a response contract`);
    const golden = family === "internal" ? { ok: true } : { data: { family } };
    assert.deepEqual(response.parse(golden), golden, family);
    assert.equal(response.safeParse({ ...golden, unexpected: true }).success, false, family);
  }
});

test("observability contracts reject unknown query/body fields and preserve the JSONL line", () => {
  const observation = {
    id: "obs_1", trace_id: "tr_1", installation_id: "ins_1", profile_mode: "public",
    route: { id: null, public_name: null, endpoint_kind: null },
    model: { offering_id: null, canonical_model_id: null, canonical_slug: null, provider_model_id: null },
    provider: null, app: { id: null, slug: null }, action: { id: null, slug: null }, team_id: null,
    cost_center: { id: null, slug: null }, key: { id: null, display_prefix: null }, status: "ok", http_status: 200,
    usage: { input_tokens: "1", output_tokens: "2", cache_read_tokens: "0", reasoning_tokens: "0", cache_write_tokens: "0", audio_input_tokens: "0", audio_output_tokens: "0" },
    cost: { amount_microusd: "3", fidelity: "exact" }, latency_ms: 12, ttfb_ms: 4, attempts: 1, failovers: 0, reason_codes: [], compacted: false,
    occurred_at: "2026-07-25T00:00:00.000Z", created_at: "2026-07-25T00:00:01.000Z",
  };
  assert.deepEqual(ObservationContracts.jsonlLine.parse(observation), observation);
  assert.equal(ObservationContracts.jsonlLine.safeParse({ ...observation, extra: true }).success, false);
  assert.equal(ObservationContracts.listQuery.safeParse({ range: "24h", unknown: "no" }).success, false);
  assert.equal(ObservationContracts.annotation.safeParse({ tags: ["good"], extra: true }).success, false);
  assert.equal(ObservationContracts.feedback.safeParse({ score: 2 }).success, false);
  assert.equal(UsageContracts.query.safeParse({ grain: "hourly", unrecognized: "x" }).success, false);
  const usage = { data: [], next_cursor: null, compaction_boundary_note: null };
  assert.deepEqual(UsageContracts.response.parse(usage), usage);
});

test("installation observation ingest is bounded, strict, and pins accepted/error envelopes", () => {
  const event = {
    traceId: "trace_1", kind: "terminal", seq: 2, occurredAt: "2026-07-25T00:00:00.000Z", profileId: "profile_1",
    keyId: null, routeId: "route_1", offeringId: "offering_1", status: 200, reasonCodes: ["PROVIDER_TIMEOUT"],
    usage: { inputTokens: 100, outputTokens: 25 }, price: { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "2000000" },
  };
  const batch = { events: [event] };
  assert.deepEqual(ObservationIngestContracts.batch.parse(batch), batch);
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [{ ...event, workspaceId: "forged" }] }).success, false);
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: Array.from({ length: 101 }, () => event) }).success, false);
  assert.deepEqual(ObservationIngestContracts.accepted.parse({ accepted: 1, projected: 1 }), { accepted: 1, projected: 1 });
  assert.equal(ObservationIngestContracts.accepted.safeParse({ accepted: 1, projected: 1, extra: true }).success, false);
  const error = { error: { code: "VALIDATION", message: "invalid", reason_codes: ["OBSERVATION_INGEST_INVALID"], request_id: "req_1", schema: "manifold.v1", retryable: false } };
  assert.deepEqual(ObservationIngestContracts.error.parse(error), error);
});

test("representative mutation requests reject unknown request fields", () => {
  assert.equal(ProviderContracts.create.safeParse({ provider: "openai", secret: "secret", unknown: true }).success, false);
  assert.equal(RouteContracts.test.safeParse({ profileId: "prf_1", unknown: true }).success, false);
  assert.equal(KeyContracts.rotate.safeParse({ graceSeconds: 60, unknown: true }).success, false);
  assert.equal(SettingsContracts.workspace.safeParse({ name: "Acme", unknown: true }).success, false);
});

test("governance request contracts reject mutation fields outside their route schema", () => {
  assert.equal(PolicyEndpointContracts.create.safeParse({ name: "Policy", activeRevisionId: "rev_1" }).success, false);
  assert.equal(PolicyEndpointContracts.approve.safeParse({ revisionId: "rev_1", role: "owner" }).success, false);
  assert.equal(BudgetEndpointContracts.allocate.safeParse({ childId: "bud_child", reservedAllowance: "10", limitAmount: "100" }).success, false);
  assert.equal(AuditEndpointContracts.destinationCreate.safeParse({ kind: "webhook", label: "SIEM", endpoint: "https://audit.example.test", secret: null, enabled: true }).success, false);
  assert.equal(SettingsEndpointContracts.tokenMint.safeParse({ scopes: ["config:read"], plaintext: "injected" }).success, false);
});

test("audit timeline remains a discriminated strict union and token plaintext is copy-once", () => {
  const policyDecision = { kind: "policy_decision", id: "pd_1", outcome: "allow", reasonCodes: [], target: null, links: { requestId: "req_1", traceId: null, policyRevisionId: null, subject: null, model: null }, createdAt: "2026-07-25T00:00:00.000Z" };
  const list = { data: [policyDecision], nextCursor: null, capabilities: { chainVerification: "available", destinations: "available", compaction: "not_applicable" } };
  assert.deepEqual(AuditEndpointContracts.list.parse(list), list);
  assert.equal(AuditEndpointContracts.list.safeParse({ ...list, data: [{ ...policyDecision, actor: "invented" }] }).success, false);
  const token = { data: { id: "tok_1", displayPrefix: "mf_tok_abc", scopes: ["config:read"], expiresAt: null, plaintext: "mf_tok_secret" } };
  assert.deepEqual(SettingsEndpointContracts.tokenMintResponse.parse(token), token);
  assert.equal(SettingsEndpointContracts.tokenList.safeParse({ data: [{ ...token.data, createdByMemberId: null, revokedAt: null, lastUsedAt: null, createdAt: "2026-07-25T00:00:00.000Z" }], nextCursor: null }).success, false);
});

test("settings contracts reject unknown, duplicate-shaped, and bodyless mutation fields", () => {
  assert.equal(SettingsEndpointContracts.pageQuery.safeParse({ limit: "101" }).success, false);
  assert.equal(SettingsEndpointContracts.pageQuery.safeParse({ limit: "10", unexpected: "x" }).success, false);
  assert.equal(SettingsEndpointContracts.memberUpdate.safeParse({}).success, false);
  assert.equal(SettingsEndpointContracts.memberUpdate.safeParse({ disabled: true, plaintext: "injected" }).success, false);
  assert.equal(SettingsEndpointContracts.teamUpdate.safeParse({}).success, false);
  assert.equal(SettingsEndpointContracts.costCenterUpdate.safeParse({ name: "Finance", extra: true }).success, false);
  assert.equal(SettingsEndpointContracts.appUpdate.safeParse({ defaultCapturePolicy: {}, secret: "injected" }).success, false);
  assert.equal(SettingsEndpointContracts.actionUpdate.safeParse({}).success, false);
  assert.deepEqual(SettingsEndpointContracts.teamArchived.parse({ data: { id: "team_1", archived: true } }), { data: { id: "team_1", archived: true } });
  assert.equal(SettingsEndpointContracts.teamArchived.safeParse({ data: { id: "team_1", archived: true, plaintext: "secret" } }).success, false);
});

test("settings CLI review list schema matches its human-review projection", () => {
  const response = { data: [{ id: "cla_1", userCode: "ABCDE-12345", status: "pending", requestedScopes: ["config:read"], client: { id: "cli_1", name: "Manifold CLI" }, verificationOrigin: "https://console.example.test", intervalSeconds: 5, expiresAt: "2026-07-25T00:00:00.000Z", createdAt: "2026-07-25T00:00:00.000Z", approvedAt: null, deniedAt: null, canReview: true }], nextCursor: null };
  assert.deepEqual(SettingsEndpointContracts.cliList.parse(response), response);
  assert.equal(SettingsEndpointContracts.cliList.safeParse({ ...response, data: [{ ...response.data[0], plaintext: "copy-once-secret" }] }).success, false);
});

test("profile family has exact list, detail, and disable response contracts", () => {
  const list = { data: [], nextCursor: null, trustedHostInvariant: "host ownership" };
  assert.deepEqual(ProfileContracts.list.parse(list), list);
  assert.equal(ProfileContracts.list.safeParse({ ...list, next_cursor: null }).success, false);
  const disabled = { id: "prf_1", status: "disabled", disabledAt: "2026-07-25T00:00:00.000Z", unpublishedChanges: 1 };
  assert.deepEqual(ProfileContracts.disableResponse.parse(disabled), disabled);
  assert.equal(ProfileContracts.disableResponse.safeParse({ ...disabled, extra: true }).success, false);
});

test("config, storage, and worker contracts reject unknown fields", () => {
  assert.equal(ConfigContracts.apply.safeParse({ installationId: "inst_1", planHash: "hash", extra: true }).success, false);
  assert.equal(ConfigContracts.rollback.safeParse({ installationId: "inst_1", revisionId: "rev_1", baseConfigHash: "hash", extra: true }).success, false);
  assert.deepEqual(ConfigContracts.activeQuery.parse({ installationId: "inst_1" }), { installationId: "inst_1" });
  assert.equal(ConfigContracts.activeQuery.safeParse({ installationId: "inst_1", extra: true }).success, false);
  assert.equal(StorageContracts.thresholds.safeParse({ warnPct: 70, highPct: 80, critPct: 90, extra: true }).success, false);
  assert.equal(StorageContracts.thresholds.safeParse({ warnPct: 90, highPct: 80, critPct: 70 }).success, false);
  assert.equal(InternalContracts.auditDelivery.safeParse({ workspaceId: "ws_1", limit: 10, extra: true }).success, false);
  assert.equal(InternalContracts.emptyQuery.safeParse({ extra: true }).success, false);
});

test("observation capture envelopes are closed and byte-bounded", () => {
  const event = {
    traceId: "trace_capture_contract", kind: "terminal", seq: 1, occurredAt: "2026-07-25T00:00:00.000Z",
    profileId: "profile_1", keyId: null, routeId: "route_1", offeringId: "offering_1", status: 200,
    reasonCodes: [], capture: { mode: "full", bytes: 29, request: { prompt: "hello" }, response: { answer: "ok" } },
  };
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [event] }).success, true);
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [{ ...event, capture: { ...event.capture, leaked: true } }] }).success, false);
  assert.equal(ObservationIngestContracts.batch.safeParse({ events: [{ ...event, capture: { bytes: 4096, request: { text: "x".repeat(4097) } } }] }).success, false);
});

test("active snapshot contract preserves the emitted JSON byte sequence", () => {
  const wire = '{"meta":{"signature":"sig"},"routes":{}}';
  assert.equal(ActiveSnapshotWireBytes.parse(wire), wire);
  assert.equal(ActiveSnapshotWireBytes.safeParse('{ "meta": {} }').success, false);
});

test("operations contracts pin strict query and success goldens", () => {
  const history = { installationId: "inst_1", revisions: [], operations: [] };
  assert.deepEqual(ConfigContracts.historyResponse.parse(history), history);
  assert.equal(ConfigContracts.historyQuery.safeParse({ installationId: "inst_1", extra: "x" }).success, false);
  const installations = { data: [], nextCursor: null };
  assert.deepEqual(InstallationContracts.listResponse.parse(installations), installations);
  assert.equal(InstallationContracts.empty.safeParse({ supplied: true }).success, false);
  const keySweep = { workspaces: 1, expired: 2, published: 1, reconciled: 0, retried: 0 };
  assert.deepEqual(InternalContracts.keyGraceExpiryResponse.parse(keySweep), keySweep);
  assert.equal(InternalContracts.storageCompactionQuery.safeParse({ jobId: "job_1", workspaceId: "ws_1", rogue: "x" }).success, false);
});

test("internal recovery and target-health cron responses have exact counter projections", () => {
  const recovery = { config: { attempted: 2, completed: 1 }, keys: { attempted: 3, completed: 2 } };
  assert.deepEqual(InternalContracts.configPublicationRecoveryResponse.parse(recovery), recovery);
  assert.equal(InternalContracts.configPublicationRecoveryResponse.safeParse({ ...recovery, debug: true }).success, false);
  assert.equal(InternalContracts.configPublicationRecoveryResponse.safeParse({ config: { ...recovery.config, ignored: 1 }, keys: recovery.keys }).success, false);

  const targetHealth = { workspaces: 2, claimed: 4, rolledUp: 3, changed: 1, published: 1, noop: 2, retried: 1, dead: 0 };
  assert.deepEqual(InternalContracts.targetHealthCronResponse.parse(targetHealth), targetHealth);
  assert.equal(InternalContracts.targetHealthCronResponse.safeParse({ ...targetHealth, outstanding: 1 }).success, false);
  assert.equal(InternalContracts.targetHealthCronResponse.safeParse({ ...targetHealth, dead: -1 }).success, false);

  const cleanup = { replayRowsDeleted: 4, rateBucketsDeleted: 3 };
  assert.deepEqual(InternalContracts.mutationCleanupResponse.parse(cleanup), cleanup);
  assert.equal(InternalContracts.mutationCleanupResponse.safeParse({ ...cleanup, leaked: 1 }).success, false);
  assert.equal(InternalContracts.mutationCleanupResponse.safeParse({ ...cleanup, replayRowsDeleted: -1 }).success, false);
});
