import assert from "node:assert/strict";
import test from "node:test";
import {
  executionFailureAuditDetail,
  gatewayResponseAuditDetail,
  parseSyntheticAuditDetail,
} from "../lib/synthetic-test-audit.ts";

const identity = { installationId: "inst-1", profileId: "profile-1", endpointKind: "chat" as const, configRevisionId: "revision-1", appliedConfigRevisionId: "revision-1" };

test("synthetic execution failures persist a discriminated, secret-safe attempt", () => {
  const detail = executionFailureAuditDetail(identity, "SYNTHETIC_NETWORK");
  assert.deepEqual(detail, {
    ...identity,
    kind: "execution_failure",
    failureCode: "SYNTHETIC_NETWORK",
    retryable: true,
  });
  assert.equal("hostname" in detail, false);
  assert.equal("message" in detail, false);
  assert.equal("token" in detail, false);
});

test("diagnostics normalizes the newest failure attempt instead of retaining a prior success", () => {
  const earlierSuccess = gatewayResponseAuditDetail(identity, {
    gatewayStatus: 200,
    traceId: "trace-previous",
    responseTruncated: false,
  });
  const newestFailure = executionFailureAuditDetail(identity, "SYNTHETIC_TIMEOUT");
  assert.equal(parseSyntheticAuditDetail(earlierSuccess)?.kind, "gateway_response");
  assert.deepEqual(parseSyntheticAuditDetail(newestFailure), newestFailure);
});

test("legacy response audit records normalize without exposing their stored hostname", () => {
  const detail = parseSyntheticAuditDetail({
    installationId: "inst-1",
    profileId: "profile-1",
    hostname: "legacy.gateway.example.test",
    endpointKind: "chat",
    gatewayStatus: 503,
    traceId: null,
    responseTruncated: false,
  });
  assert.deepEqual(detail, {
    ...identity,
    configRevisionId: null,
    appliedConfigRevisionId: null,
    kind: "gateway_response",
    gatewayStatus: 503,
    traceId: null,
    responseTruncated: false,
  });
});
