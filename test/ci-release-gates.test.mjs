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

test("CI protects master while scheduled alias health remains separate from the callable promotion gate", async () => {
  const ci = await read(".github/workflows/ci.yml");
  const live = await read(".github/workflows/live-acceptance.yml");
  assert.match(ci, /push:\n\s+branches: \[master\]/);
  assert.doesNotMatch(ci, /branches: \[main\]/);
  assert.match(live, /workflow_dispatch:/);
  assert.match(live, /schedule:/);
  assert.match(live, /workflow_call:/);
  assert.match(live, /control_plane_candidate_url/);
  assert.match(live, /gateway_candidate_url/);
  assert.match(live, /MANIFOLD_LIVE_SOURCE_REVISION: \$\{\{ github\.sha \}\}/);
  assert.match(live, /MANIFOLD_LIVE_ACCEPTANCE_MODE/);
  assert.match(live, /Run public health acceptance/);
  assert.match(live, /Verify candidate readiness and provenance[\s\S]*?MANIFOLD_LIVE_DIAGNOSTICS_TOKEN: \$\{\{ secrets\.MANIFOLD_LIVE_DIAGNOSTICS_TOKEN \}\}/);
  assert.match(live, /Verify candidate readiness and provenance[\s\S]*?MANIFOLD_LIVE_CONTROL_PLANE_TOKEN: \$\{\{ secrets\.MANIFOLD_LIVE_CONTROL_PLANE_TOKEN \}\}/);
  const candidateJob = live.slice(live.indexOf("  immutable-candidate-health:"), live.indexOf("  production-alias-promotion-gate:"));
  assert.doesNotMatch(candidateJob.slice(0, candidateJob.indexOf("      - name: Verify candidate readiness and provenance")), /MANIFOLD_LIVE_DIAGNOSTICS_TOKEN|MANIFOLD_LIVE_CONTROL_PLANE_TOKEN/);
  const promotion = live.slice(live.indexOf("  production-alias-promotion-gate:"));
  assert.match(promotion, /needs: immutable-candidate-health/);
  assert.match(live, /scheduled-public-health:[\s\S]*?github\.event_name != 'workflow_call'/);
  assert.match(live, /node scripts\/run-live-acceptance\.mjs/);
  assert.match(ci, /node --test test\/ci-release-gates\.test\.mjs test\/live-acceptance\.test\.mjs/);
});

test("security/storage gate builds gateway-core before the local flat-memory release check", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const job = workflow.slice(workflow.indexOf("  security-storage-gates:"));
  assert.ok(job.includes("pnpm --filter @manifold/gateway-core run build"), "gateway-core build is required in the security/storage job");
  assert.ok(job.indexOf("pnpm --filter @manifold/gateway-core run build") < job.indexOf("pnpm run load:flat-memory"), "gateway-core build must precede the flat-memory gate");
});

test("production promotion is master-only, requires successful CI for its exact revision, and pins its deploy CLI", async () => {
  const workflow = await read(".github/workflows/production-promotion.yml");
  const live = await read(".github/workflows/live-acceptance.yml");
  const packageManifest = JSON.parse(await read("package.json"));
  const lockfile = await read("pnpm-lock.yaml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /verify-master-ci:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/master'/);
  assert.match(workflow, /needs: verify-master-ci/);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA&branch=master&event=push&status=completed/);
  assert.match(workflow, /--arg sha "\$GITHUB_SHA"/);
  assert.match(workflow, /\.head_sha == \$sha/);
  assert.match(workflow, /\.head_branch == "master"/);
  assert.match(workflow, /\.event == "push"/);
  assert.match(workflow, /\.conclusion == "success"/);
  assert.equal(packageManifest.devDependencies.vercel, "58.0.0");
  assert.match(lockfile, /^\s{2}vercel@58\.0\.0:/m);
  assert.doesNotMatch(workflow, /(?:npx|vercel)@latest/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm exec vercel deploy/);
  assert.match(workflow, /pnpm exec vercel alias set/);
  assert.match(workflow, /deploy-immutable-candidates:/);
  assert.match(workflow, /--prod --skip-domain/);
  assert.match(workflow, /control_plane_candidate_url: \$\{\{ steps\.control-plane\.outputs\.candidate_url \}\}/);
  assert.match(workflow, /gateway_candidate_url: \$\{\{ steps\.gateway\.outputs\.candidate_url \}\}/);
  assert.match(workflow, /immutable-candidate-diagnostics:[\s\S]*?needs: deploy-immutable-candidates/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/live-acceptance\.yml/);
  assert.match(workflow, /control_plane_candidate_url: \$\{\{ needs\.deploy-immutable-candidates\.outputs\.control_plane_candidate_url \}\}/);
  assert.match(workflow, /gateway_deployment_id: \$\{\{ needs\.deploy-immutable-candidates\.outputs\.gateway_deployment_id \}\}/);
  const promotion = workflow.slice(workflow.indexOf("  promote-production-aliases:"));
  assert.match(promotion, /needs: \[verify-master-ci, deploy-immutable-candidates, immutable-candidate-diagnostics\]/);
  assert.ok(workflow.indexOf("pnpm exec vercel alias set") > workflow.indexOf("  immutable-candidate-diagnostics:"), "aliases must be declared after the diagnostics dependency");
  assert.match(workflow, /VERCEL_TOKEN: \$\{\{ secrets\.MANIFOLD_VERCEL_TOKEN \}\}/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("jobs:")), /MANIFOLD_VERCEL_TOKEN/);
  assert.match(live, /MANIFOLD_LIVE_SOURCE_REVISION: \$\{\{ github\.sha \}\}/);
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
