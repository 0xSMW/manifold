// Adversarial regression tests for the deny-first policy evaluator (SPEC §11, §14, §0.2).
// Each case is a REAL run of `evaluate` — the exact pure function the gateway authorizer and
// the Policies simulator both call (SPEC §21.5 parity). These pin the two invariants an
// attacker probes: (a) an explicit deny can never be out-voted by an allow, and (b) a param
// silently sneaking past a hard ceiling is impossible (it is clamped or the request is denied).
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evaluate.ts";
import type {
  ModelEntitlement,
  PolicyInput,
  PolicyRevision,
  RequestConstraint,
} from "../src/types.ts";

const CLAUDE = "claude-3-5-sonnet";

// --- entitlement builders -------------------------------------------------------------------
const allowTeam = (team: string, model: string | null = CLAUDE): ModelEntitlement => ({
  subjectKind: "team",
  subjectRef: team,
  canonicalModelId: model,
  effect: "allow",
});
const denyTeam = (team: string, model: string | null = CLAUDE): ModelEntitlement => ({
  subjectKind: "team",
  subjectRef: team,
  canonicalModelId: model,
  effect: "deny",
});
const constraint = (
  param: string,
  bounds: { max?: number; min?: number },
  onViolation: "clamp" | "reject",
): RequestConstraint => ({
  param,
  maxValue: bounds.max ?? null,
  minValue: bounds.min ?? null,
  onViolation,
});

const baseInput = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  subject: { team: "platform" },
  canonicalModelId: CLAUDE,
  params: {},
  ...overrides,
});

// ============================================================================================
// Rule 1 — model entitlement (deny-first)
// ============================================================================================

test("explicit deny beats a matching allow for the same subject→model", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [allowTeam("platform"), denyTeam("platform")],
    requestConstraints: [],
  };
  const d = evaluate(baseInput(), policy);
  assert.equal(d.outcome, "deny", "an allow must never override a matching explicit deny");
  assert.deepEqual(d.reasonCodes, ["POLICY_MODEL_DENIED"]);
});

test("deny wins regardless of entitlement order (deny listed first)", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [denyTeam("platform"), allowTeam("platform")],
    requestConstraints: [],
  };
  assert.equal(evaluate(baseInput(), policy).outcome, "deny");
});

test("missing entitlement ⇒ deny-by-default (no grant reaches this subject)", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [allowTeam("finance")], // different team
    requestConstraints: [],
  };
  const d = evaluate(baseInput(), policy);
  assert.equal(d.outcome, "deny");
  assert.deepEqual(d.reasonCodes, ["POLICY_MODEL_DENIED"]);
});

test("an allow with no matching deny ⇒ allow", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [allowTeam("platform")],
    requestConstraints: [],
  };
  const d = evaluate(baseInput(), policy);
  assert.equal(d.outcome, "allow");
  assert.deepEqual(d.reasonCodes, []);
});

test("empty policy ⇒ deny-by-default", () => {
  const policy: PolicyRevision = { modelEntitlements: [], requestConstraints: [] };
  const d = evaluate(baseInput(), policy);
  assert.equal(d.outcome, "deny");
  assert.deepEqual(d.reasonCodes, ["POLICY_MODEL_DENIED"]);
});

test("subject_kind 'all' grants any subject; a scoped deny still overrides it", () => {
  const allowAll: ModelEntitlement = {
    subjectKind: "all",
    subjectRef: null,
    canonicalModelId: CLAUDE,
    effect: "allow",
  };
  const allowed: PolicyRevision = { modelEntitlements: [allowAll], requestConstraints: [] };
  assert.equal(evaluate(baseInput(), allowed).outcome, "allow");

  const overridden: PolicyRevision = {
    modelEntitlements: [allowAll, denyTeam("platform")],
    requestConstraints: [],
  };
  assert.equal(evaluate(baseInput(), overridden).outcome, "deny");
});

test("an allow scoped to a different model does not grant this model ⇒ deny", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [allowTeam("platform", "gpt-4o")],
    requestConstraints: [],
  };
  assert.equal(evaluate(baseInput(), policy).outcome, "deny");
});

// ============================================================================================
// Rule 2 — request constraints (clamp vs reject)
// ============================================================================================

const allowedPolicy = (constraints: RequestConstraint[]): PolicyRevision => ({
  modelEntitlements: [allowTeam("platform")],
  requestConstraints: constraints,
});

test("param exactly at the boundary is NOT clamped ⇒ allow", () => {
  const policy = allowedPolicy([constraint("max_tokens", { max: 4096 }, "clamp")]);
  const d = evaluate(baseInput({ params: { max_tokens: 4096 } }), policy);
  assert.equal(d.outcome, "allow", "a value equal to the max is in range");
  assert.deepEqual(d.reasonCodes, []);
  assert.equal(d.clamps, undefined);
});

test("param one over the max ⇒ clamped to the bound (records the clamped value)", () => {
  const policy = allowedPolicy([constraint("max_tokens", { max: 4096 }, "clamp")]);
  const d = evaluate(baseInput({ params: { max_tokens: 4097 } }), policy);
  assert.equal(d.outcome, "clamp");
  assert.deepEqual(d.reasonCodes, ["POLICY_PARAM_CLAMPED"]);
  assert.deepEqual(d.clamps, { max_tokens: 4096 });
});

test("param under the min ⇒ clamped up to the min bound", () => {
  const policy = allowedPolicy([constraint("top_p", { min: 0.1 }, "clamp")]);
  const d = evaluate(baseInput({ params: { top_p: 0.0 } }), policy);
  assert.equal(d.outcome, "clamp");
  assert.deepEqual(d.clamps, { top_p: 0.1 });
});

test("reject-mode param over the ceiling ⇒ rejected (deny), value NOT silently clamped", () => {
  const policy = allowedPolicy([constraint("max_tokens", { max: 4096 }, "reject")]);
  const d = evaluate(baseInput({ params: { max_tokens: 4097 } }), policy);
  assert.equal(d.outcome, "deny");
  assert.deepEqual(d.reasonCodes, ["POLICY_PARAM_REJECTED"]);
  assert.equal(d.clamps, undefined, "a reject must not leak a clamped value");
});

test("reject-mode param exactly at the boundary is fine ⇒ allow", () => {
  const policy = allowedPolicy([constraint("max_tokens", { max: 4096 }, "reject")]);
  assert.equal(evaluate(baseInput({ params: { max_tokens: 4096 } }), policy).outcome, "allow");
});

test("a constraint whose param is absent from the request is inert ⇒ allow", () => {
  const policy = allowedPolicy([constraint("max_tokens", { max: 4096 }, "reject")]);
  assert.equal(evaluate(baseInput({ params: { temperature: 0.7 } }), policy).outcome, "allow");
});

// ============================================================================================
// Multiple constraints + rule interaction (deny-first across the whole verdict)
// ============================================================================================

test("multiple clamp constraints ⇒ every out-of-range param clamped", () => {
  const policy = allowedPolicy([
    constraint("max_tokens", { max: 4096 }, "clamp"),
    constraint("temperature", { max: 1.0 }, "clamp"),
    constraint("top_p", { min: 0.1 }, "clamp"),
  ]);
  const d = evaluate(
    baseInput({ params: { max_tokens: 9000, temperature: 2.0, top_p: 0.05 } }),
    policy,
  );
  assert.equal(d.outcome, "clamp");
  assert.deepEqual(d.reasonCodes, ["POLICY_PARAM_CLAMPED"]);
  assert.deepEqual(d.clamps, { max_tokens: 4096, temperature: 1.0, top_p: 0.1 });
});

test("mixed clamp + reject over multiple constraints ⇒ deny wins (deny-first)", () => {
  const policy = allowedPolicy([
    constraint("max_tokens", { max: 4096 }, "clamp"),
    constraint("temperature", { max: 1.0 }, "reject"),
  ]);
  const d = evaluate(baseInput({ params: { max_tokens: 9000, temperature: 2.0 } }), policy);
  assert.equal(d.outcome, "deny", "any reject denies the whole request");
  assert.ok(d.reasonCodes.includes("POLICY_PARAM_REJECTED"));
});

test("model deny short-circuits before constraints ever run", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [denyTeam("platform")],
    requestConstraints: [constraint("max_tokens", { max: 4096 }, "clamp")],
  };
  const d = evaluate(baseInput({ params: { max_tokens: 9000 } }), policy);
  assert.equal(d.outcome, "deny");
  assert.deepEqual(d.reasonCodes, ["POLICY_MODEL_DENIED"], "a denied model is never clamped");
});
