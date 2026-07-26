// Seeded parity proof for SPEC §21.5. The simulator and the gateway authorizer
// must remain observationally identical for every policy/input pair generated here.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelEntitlement,
  PolicyInput,
  PolicyRevision,
  PolicySubject,
  RequestConstraint,
} from "@manifold/gateway-policy";
import type { SnapshotKey } from "@manifold/ports";
import * as simulatorModule from "../../../apps/control-plane/lib/policies/simulate.ts";
import { evaluateGatewayPolicy } from "../src/enforce.ts";

const simulatePolicy = (
  "simulatePolicy" in simulatorModule
    ? simulatorModule.simulatePolicy
    : (simulatorModule.default as typeof simulatorModule).simulatePolicy
);

const DEFAULT_SEED = 0x21_5a_11;
const seed = parseSeed(process.env.POLICY_PARITY_SEED, DEFAULT_SEED);
const caseCount = parseCaseCount(process.env.POLICY_PARITY_CASES, 600);
const MODELS = ["claude", "gpt", "mistral"] as const;
const PARAMS = ["max_tokens", "temperature", "top_p", "seed", "n"] as const;
const FACETS = ["keyScope", "team", "costCenter", "app"] as const;

function parseSeed(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("POLICY_PARITY_SEED must be an unsigned 32-bit integer");
  }
  return value;
}

function parseCaseCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 20_000) {
    throw new Error("POLICY_PARITY_CASES must be an integer from 1 through 20000");
  }
  return value;
}

/** Small deterministic PRNG; the failure message prints everything needed to replay. */
function random(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function chance(next: () => number, probability: number): boolean {
  return next() < probability;
}

function subject(next: () => number): PolicySubject {
  const out: PolicySubject = {};
  for (const facet of FACETS) {
    if (chance(next, 0.65)) out[facet] = `${facet}-${Math.floor(next() * 4)}`;
  }
  return out;
}

function keyFor(subjectValue: PolicySubject): SnapshotKey {
  return {
    id: "key",
    profileId: "profile",
    scopes: subjectValue.keyScope ? [subjectValue.keyScope] : [],
    allowedAppIds: subjectValue.app ? [subjectValue.app] : [],
    team: subjectValue.team,
    costCenter: subjectValue.costCenter,
    budgetAccountId: null,
    expiresAt: null,
  };
}

function revision(next: () => number): PolicyRevision {
  const modelEntitlements: ModelEntitlement[] = Array.from({ length: Math.floor(next() * 8) }, () => {
    const subjectKind = pick(next, ["all", "key_scope", "team", "cost_center", "app"] as const);
    return {
      subjectKind,
      subjectRef: subjectKind === "all" ? null : `${({
        key_scope: "keyScope",
        team: "team",
        cost_center: "costCenter",
        app: "app",
      } as const)[subjectKind]}-${Math.floor(next() * 4)}`,
      canonicalModelId: chance(next, 0.35) ? null : pick(next, MODELS),
      effect: chance(next, 0.38) ? "deny" : "allow",
    };
  });

  const requestConstraints: RequestConstraint[] = Array.from({ length: Math.floor(next() * 7) }, () => {
    const first = Math.floor(next() * 20) - 8;
    const second = Math.floor(next() * 20) - 8;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    const kind = Math.floor(next() * 3);
    return {
      param: pick(next, PARAMS),
      minValue: kind === 0 ? null : min,
      maxValue: kind === 1 ? null : max,
      onViolation: chance(next, 0.5) ? "clamp" : "reject",
    };
  });
  return { modelEntitlements, requestConstraints };
}

function input(next: () => number): PolicyInput {
  const params: Record<string, number> = {};
  for (const param of PARAMS) {
    if (chance(next, 0.7)) {
      // Includes negatives, fractional values, and regular ceilings around generated bounds.
      params[param] = Math.floor(next() * 33) / (chance(next, 0.35) ? 10 : 1) - 12;
    }
  }
  return { subject: subject(next), canonicalModelId: pick(next, MODELS), params };
}

function repro(caseIndex: number, policy: PolicyRevision, request: PolicyInput): string {
  return [
    `seed=${seed}`, `case=${caseIndex}`, `cases=${caseCount}`,
    `replay: POLICY_PARITY_SEED=${seed} POLICY_PARITY_CASES=${caseIndex + 1} npm test -w @manifold/gateway-core -- policy-parity.test.ts`,
    `policy=${JSON.stringify(policy)}`,
    `input=${JSON.stringify(request)}`,
  ].join("\n");
}

test(`SPEC §21.5 simulator/runtime policy parity (seed=${seed}, cases=${caseCount})`, () => {
  const next = random(seed);
  for (let caseIndex = 0; caseIndex < caseCount; caseIndex += 1) {
    const policy = revision(next);
    const request = input(next);
    const simulator = simulatePolicy(request, policy);
    const runtime = evaluateGatewayPolicy(policy, request.canonicalModelId, request.params, keyFor(request.subject));
    assert.deepEqual(runtime, simulator, repro(caseIndex, policy, request));
  }
});

test("SPEC §21.5 boundary cases keep identical reason codes and clamp values", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [{ subjectKind: "all", subjectRef: null, canonicalModelId: null, effect: "allow" }],
    requestConstraints: [
      { param: "max_tokens", minValue: 1, maxValue: 8, onViolation: "clamp" },
      { param: "temperature", minValue: 0, maxValue: 1, onViolation: "reject" },
    ],
  };
  const cases: PolicyInput[] = [
    { subject: {}, canonicalModelId: "claude", params: { max_tokens: 1, temperature: 0 } },
    { subject: {}, canonicalModelId: "claude", params: { max_tokens: 8, temperature: 1 } },
    { subject: {}, canonicalModelId: "claude", params: { max_tokens: 0 } },
    { subject: {}, canonicalModelId: "claude", params: { max_tokens: 9 } },
    { subject: {}, canonicalModelId: "claude", params: { temperature: -0.01 } },
    { subject: {}, canonicalModelId: "claude", params: { temperature: 1.01 } },
  ];
  for (const request of cases) {
    assert.deepEqual(
      evaluateGatewayPolicy(policy, request.canonicalModelId, request.params, keyFor(request.subject)),
      simulatePolicy(request, policy),
      JSON.stringify(request),
    );
  }
});

test("gateway multi-facet deny wins before constraint rejection", () => {
  const policy: PolicyRevision = {
    modelEntitlements: [
      { subjectKind: "key_scope", subjectRef: "allowed", canonicalModelId: "claude", effect: "allow" },
      { subjectKind: "key_scope", subjectRef: "blocked", canonicalModelId: "claude", effect: "deny" },
    ],
    requestConstraints: [{ param: "max_tokens", minValue: null, maxValue: 1, onViolation: "reject" }],
  };
  const key = { ...keyFor({}), scopes: ["allowed", "blocked"] };
  assert.deepEqual(evaluateGatewayPolicy(policy, "claude", { max_tokens: 2 }, key), {
    outcome: "deny",
    reasonCodes: ["POLICY_MODEL_DENIED"],
  });
});
