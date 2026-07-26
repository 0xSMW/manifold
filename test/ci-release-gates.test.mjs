import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("root command surface exposes every SPEC §21 release gate", async () => {
  const { scripts } = JSON.parse(await read("package.json"));
  for (const name of [
    "typecheck", "build", "test:packages", "test:control-plane", "test:pg",
    "test:storage-release", "test:security", "test:playwright", "test:desktop",
    "test:mobile", "lint:boundaries", "lint:queries", "check:migrations",
    "check:environment-isolation",
  ]) assert.ok(scripts[name], `missing root script: ${name}`);
  assert.match(scripts.typecheck, /--dir apps\/control-plane exec tsc --noEmit -p tsconfig\.json/);
  assert.match(scripts["test:control-plane"], /tsx --tsconfig tsconfig\.json --test/);
  assert.match(scripts["test:playwright"], /test:desktop.*test:mobile/);
});

test("CI installs Node 22 and keeps security/storage gates independent", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /^\s+security-storage-gates:/m);
  assert.match(workflow, /name: security-storage-gates/);
  assert.doesNotMatch(workflow, /security-storage-gates:[\s\S]*?continue-on-error:\s*true/);
  for (const command of ["test:security", "test:pg", "test:storage-release", "load:flat-memory", "load:k6", "conformance:replay", "conformance:matrix:check", "test:playwright", "check:environment-isolation"]) {
    assert.match(workflow, new RegExp(`pnpm run ${command}`));
  }
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /Install k6 0\.58\.0/);
  assert.match(workflow, /pnpm --dir apps\/control-plane run lint:copy/);
  assert.match(workflow, /Upload Playwright artifacts[\s\S]*?if: failure\(\)/);
});

test("protected real-target gate preflights isolated configuration before external probes", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /^\s+real-target-release-gates:/m);
  assert.match(workflow, /environment:\n\s+name: release-load/);
  assert.match(workflow, /group: manifold-real-target-release-load/);
  assert.match(workflow, /MANIFOLD_PUBLIC_VIRTUAL_KEY: \$\{\{ secrets\.MANIFOLD_PUBLIC_VIRTUAL_KEY \}\}/);
  assert.match(workflow, /MANIFOLD_ENTERPRISE_VIRTUAL_KEY: \$\{\{ secrets\.MANIFOLD_ENTERPRISE_VIRTUAL_KEY \}\}/);
  assert.match(workflow, /MANIFOLD_GATEWAY_MEMORY_PROBE_URL/);
  assert.match(workflow, /MANIFOLD_GATEWAY_MEMORY_CONTRACT/);
  assert.match(workflow, /MANIFOLD_GATEWAY_MEMORY_PROBE_URL: \$\{\{ vars\.MANIFOLD_GATEWAY_MEMORY_PROBE_URL \}\}/);
  assert.match(workflow, /Verify isolated target configuration/);
  assert.match(workflow, /Probe isolated public gateway path[\s\S]*?MANIFOLD_LOAD_PROFILE: public_app/);
  assert.match(workflow, /Probe isolated enterprise gateway path and hard-budget cap[\s\S]*?MANIFOLD_LOAD_PROFILE: enterprise_egress/);
  assert.match(workflow, /pnpm run load:k6:external/);
  assert.match(workflow, /Probe isolated gateway streaming memory[\s\S]*?MANIFOLD_VIRTUAL_KEY: \$\{\{ secrets\.MANIFOLD_PUBLIC_VIRTUAL_KEY \}\}[\s\S]*?pnpm run load:flat-memory:external/);
  assert.doesNotMatch(workflow, /echo\s+\$MANIFOLD_(?:PUBLIC|ENTERPRISE)_VIRTUAL_KEY/);
});

test("security/storage gate builds gateway-core before the local flat-memory release check", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const job = workflow.slice(workflow.indexOf("  security-storage-gates:"), workflow.indexOf("  real-target-release-gates:"));
  assert.ok(job.includes("pnpm --filter @manifold/gateway-core run build"), "gateway-core build is required in the security/storage job");
  assert.ok(job.indexOf("pnpm --filter @manifold/gateway-core run build") < job.indexOf("pnpm run load:flat-memory"), "gateway-core build must precede the flat-memory gate");
});

test("gate helpers enforce boundaries, migration freshness, and preview-secret isolation", async () => {
  for (const script of ["lint-boundaries.mjs", "lint-workspace-queries.mjs", "check-migrations.mjs", "check-environment-isolation.mjs", "run-flat-memory-fixture.mjs", "run-k6-local-fixture.mjs"]) {
    await read(`scripts/${script}`);
  }
});

test("local k6 release fixture covers public and enterprise budget profiles", async () => {
  const fixture = await read("scripts/run-k6-local-fixture.mjs");
  assert.match(fixture, /MANIFOLD_LOAD_PROFILE: "public_app"/);
  assert.match(fixture, /MANIFOLD_LOAD_PROFILE: "enterprise_egress"/);
  assert.match(fixture, /MANIFOLD_HARD_BUDGET_SUCCESS_CAP/);
  assert.match(fixture, /BUDGET_RESERVE_DENIED/);
});
