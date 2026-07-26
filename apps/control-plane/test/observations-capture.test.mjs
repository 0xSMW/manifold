import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadDetailModule() {
  const filename = new URL("../app/api/v1/observations/_detail.ts", import.meta.url);
  const source = readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: filename.pathname,
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "Buffer", output)(
    () => {
      throw new Error("unexpected test dependency");
    },
    module,
    module.exports,
    Buffer,
  );
  return module.exports;
}

const detail = loadDetailModule();

test("capture payload requires both caller scope and an explicitly bounded policy", () => {
  const capture = { request: { prompt: "secret" }, response: { answer: "ok" }, bytes: 42, redacted: true, truncated: false };
  const allowedPolicy = detail.capturePolicyView({
    routePolicy: { name: "redacted-1k", mode: "redacted", maxBytes: 1_024 },
    appPolicy: null,
    routeRevisionId: "rev_1",
    appSlug: null,
    dataHandlingMode: "redacted",
    policyName: "handling",
  });
  assert.equal(detail.captureView(capture, allowedPolicy, false).payload, null);
  assert.equal(detail.captureView(capture, allowedPolicy, true).visibility, "visible");

  const unboundedPolicy = detail.capturePolicyView({
    routePolicy: { name: "missing-cap", mode: "full" },
    appPolicy: null,
    routeRevisionId: "rev_1",
    appSlug: null,
    dataHandlingMode: "full",
    policyName: "handling",
  });
  assert.equal(detail.captureView(capture, unboundedPolicy, true).payload, null);
  assert.equal(
    detail.captureView(capture, unboundedPolicy, true).visibility,
    "policy_disallows_payload",
  );
});

test("capture reader preserves truthful full/redacted metadata and never renders truncated markers", () => {
  const policy = detail.capturePolicyView({ routePolicy: { mode: "full", maxBytes: 1_024 }, appPolicy: null, routeRevisionId: "rev", appSlug: null, dataHandlingMode: "full", policyName: null });
  const full = detail.captureView({ request: { prompt: "ok" }, response: { answer: "ok" }, bytes: 42, redacted: false, truncated: false }, policy, true);
  assert.equal(full.metadata.redacted, false);
  assert.equal(full.visibility, "visible");
  const redacted = detail.captureView({ request: { prompt: "[REDACTED]" }, bytes: 24, redacted: true, truncated: false }, policy, true);
  assert.equal(redacted.metadata.redacted, true);
  const truncated = detail.captureView({ bytes: 0, redacted: false, truncated: true }, policy, true);
  assert.equal(truncated.metadata.truncated, true);
  assert.equal(truncated.payload, null);
  assert.equal(truncated.visibility, "bounded_out");
});

test("capture response refuses a stored payload larger than the effective byte cap", () => {
  const policy = detail.capturePolicyView({
    routePolicy: { mode: "full", max_bytes: 16 },
    appPolicy: null,
    routeRevisionId: "rev_1",
    appSlug: null,
    dataHandlingMode: "full",
    policyName: null,
  });
  const view = detail.captureView(
    { request: { prompt: "this is longer than sixteen bytes" } },
    policy,
    true,
  );
  assert.equal(view.payload, null);
  assert.equal(view.visibility, "bounded_out");
  assert.equal(view.metadata.response_bound_exceeded, true);
});
