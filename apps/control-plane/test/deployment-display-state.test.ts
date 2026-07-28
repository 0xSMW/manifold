import assert from "node:assert/strict";
import test from "node:test";
import {
  configOperationDisplayState,
  diagnosticResultLabel,
  diagnosticResultState,
  installationDisplayLabel,
  installationDisplayState,
} from "../components/deployments/deployment-display-state.ts";

test("an installation without a successful heartbeat remains pending", () => {
  const state = installationDisplayState("active", null);
  assert.equal(state, "pending");
  assert.equal(installationDisplayLabel(state), "Pending");
});

test("an installation becomes active only after a returned heartbeat timestamp", () => {
  const state = installationDisplayState("active", "2026-07-28T00:00:00.000Z", {
    heartbeatAgeSeconds: 0,
    freshnessThresholdSeconds: 600,
    state: "connected",
  });
  assert.equal(state, "active");
  assert.equal(installationDisplayLabel(state), "Active");
});

test("a stale heartbeat remains pending using the readiness freshness evidence", () => {
  assert.equal(
    installationDisplayState("active", "2026-07-28T00:00:00.000Z", {
      heartbeatAgeSeconds: 601,
      freshnessThresholdSeconds: 600,
      state: "stale",
    }),
    "pending",
  );
});

test("a disabled installation remains disabled even if it has heartbeat history", () => {
  assert.equal(
    installationDisplayState("disabled", "2026-07-28T00:00:00.000Z"),
    "disabled",
  );
});

test("synthetic diagnostics classify the persisted gateway status from the real wire payload", () => {
  const success = {
    id: "audit-success",
    createdAt: "2026-07-28T00:00:00.000Z",
    detail: { kind: "gateway_response", installationId: "inst-1", profileId: "profile-1", endpointKind: "chat", configRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", gatewayStatus: 200, traceId: "trace-1", responseTruncated: false },
  } as const;
  const failureResult = {
    ...success,
    id: "audit-failure",
    detail: { ...success.detail, gatewayStatus: 503, traceId: null },
  } as const;
  const current = { activeConfigRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", freshnessThresholdSeconds: 600, now: Date.parse(success.createdAt) };
  assert.equal(diagnosticResultState(false, success, current), "unavailable");
  assert.equal(diagnosticResultState(true, success, current), "success");
  const failure = diagnosticResultState(true, failureResult, current);
  assert.equal(failure, "failure");
  assert.equal(diagnosticResultLabel(failure), "Failed");
});

test("a successful synthetic result becomes stale when its provenance or age no longer matches", () => {
  const result = {
    id: "audit-success",
    createdAt: "2026-07-28T00:00:00.000Z",
    detail: { kind: "gateway_response", installationId: "inst-1", profileId: "profile-1", endpointKind: "chat", configRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", gatewayStatus: 200, traceId: null, responseTruncated: false },
  } as const;
  assert.equal(diagnosticResultState(true, result, { activeConfigRevisionId: "revision-2", appliedConfigRevisionId: "revision-2", freshnessThresholdSeconds: 600, now: Date.parse(result.createdAt) }), "stale");
  assert.equal(diagnosticResultState(true, result, { activeConfigRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", freshnessThresholdSeconds: 600, now: Date.parse(result.createdAt) + 601_000 }), "stale");
});

test("config operation status uses durable publication and reconciliation state", () => {
  assert.equal(configOperationDisplayState("accepted", "pending"), "pending");
  assert.equal(configOperationDisplayState("accepted", "published"), "success");
  assert.equal(configOperationDisplayState("accepted", "reconciliation_required"), "failure");
});
