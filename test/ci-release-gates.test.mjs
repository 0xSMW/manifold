import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function assertPnpmAvailableBeforeCache(workflow, expectedOccurrences, name) {
  const cachedNodeSetups = [...workflow.matchAll(/- uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: 22\n\s+cache: pnpm/g)];
  assert.equal(cachedNodeSetups.length, expectedOccurrences, `${name} must have the expected pnpm-cached Node 22 setups`);
  for (const setup of cachedNodeSetups) {
    const prefix = workflow.slice(0, setup.index);
    const pnpmSetupIndex = prefix.lastIndexOf("- uses: pnpm/action-setup@v4");
    assert.ok(pnpmSetupIndex >= 0, `${name} must install pnpm before setup-node cache resolution`);
    assert.match(prefix.slice(pnpmSetupIndex), /- uses: pnpm\/action-setup@v4\s*$/, `${name} must invoke pnpm setup immediately before setup-node cache resolution`);
  }
  assert.doesNotMatch(workflow, /pnpm\/action-setup@v4\n\s+with:\n\s+version:/, `${name} must use package.json packageManager as the sole pnpm version source`);
  assert.doesNotMatch(workflow, /corepack enable/, `${name} must not rely on post-cache Corepack activation`);
}

test("root command surface exposes every SPEC §21 release gate", async () => {
  const { scripts, packageManager, devDependencies } = JSON.parse(await read("package.json"));
  assert.match(packageManager, /^pnpm@10\.33\.3\+sha512\./, "packageManager must integrity-pin the exact CI pnpm release");
  assert.equal(devDependencies.typescript, "5.9.3", "root typecheck tooling must be pinned for a clean install");
  assert.equal(devDependencies.tsx, "4.23.1", "root source-test tooling must be pinned for a clean install");
  for (const name of [
    "typecheck", "build", "test:packages", "test:control-plane", "test:pg",
    "test:storage-release", "test:security", "test:playwright", "test:desktop",
    "test:mobile", "lint:boundaries", "lint:queries", "check:migrations",
    "check:environment-isolation",
  ]) assert.ok(scripts[name], `missing root script: ${name}`);
  assert.match(scripts.typecheck, /^tsc -b/);
  assert.match(scripts.typecheck, /--dir apps\/control-plane exec tsc --noEmit -p tsconfig\.json/);
  assert.match(scripts["test:control-plane"], /tsx --tsconfig tsconfig\.json --test/);
  assert.match(scripts["test:storage-release"], /^pnpm exec tsx --tsconfig packages\/storage\/tsconfig\.json --test packages\/storage\/test\//);
  assert.doesNotMatch(scripts["test:storage-release"], /--filter .* exec tsx/);
  assert.equal(scripts["test:playwright"], "pnpm --dir apps/control-plane exec playwright test", "the full browser gate must run every configured project in one invocation");
});

test("CI installs Node 22 and keeps security/storage gates independent", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const playwrightConfig = await read("apps/control-plane/playwright.config.ts");
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(workflow, /^\s*PLAYWRIGHT_BASE_URL:/m, "CI must let Playwright start and wait for its configured local server");
  assert.match(playwrightConfig, /webServer:\s*process\.env\.PLAYWRIGHT_BASE_URL\s*\?\s*undefined\s*:/);
  assert.match(playwrightConfig, /next dev --port \$\{port\}/);
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
  assertPnpmAvailableBeforeCache(workflow, 2, "CI");
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

test("security gate builds only its TypeScript dependency closure and invokes root-declared tsx", async () => {
  const security = await read("scripts/run-security-gates.mjs");
  const lockfile = await read("pnpm-lock.yaml");
  assert.match(security, /pnpm", \["exec", "tsc", "-b", "packages\/crypto", "packages\/config", "packages\/gateway-core", "packages\/observability", "packages\/budget"\]/);
  assert.match(security, /pnpm", \["exec", "tsx", "--tsconfig", tsconfig, "--test"/);
  assert.doesNotMatch(security, /--filter", workspace, "exec", "tsx"/);
  const rootImporter = lockfile.match(/^  \.:\n(?<body>(?: {4}.*\n| {6}.*\n| {8}.*\n)*)/m)?.groups?.body ?? "";
  assert.match(rootImporter, /      tsx:\n        specifier: 4\.23\.1\n        version: 4\.23\.1/);
  assert.match(rootImporter, /      typescript:\n        specifier: 5\.9\.3\n        version: 5\.9\.3/);
});

test("real Postgres gate builds the storage runtime export before running its suites", async () => {
  const realPg = await read("scripts/run-real-pg-gates.mjs");
  const build = realPg.indexOf('spawnSync("pnpm", ["exec", "tsc", "-b", "packages/storage"], { stdio: "inherit" })');
  const suites = realPg.indexOf("for (const [workspace, tests] of suites)");
  assert.ok(build >= 0, "real Postgres gate must build storage's TypeScript project reference closure");
  assert.ok(build < suites, "storage runtime dist must be built before any real Postgres suite runs");
  assert.match(realPg, /if \(storageBuild\.status !== 0\) process\.exit\(storageBuild\.status \?\? 1\);/);
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
  assertPnpmAvailableBeforeCache(workflow, 2, "production promotion");
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
  const gatewayDeployment = workflow.slice(
    workflow.indexOf("      - name: Deploy immutable gateway candidate without aliases"),
    workflow.indexOf("  immutable-candidate-diagnostics:"),
  );
  assert.match(gatewayDeployment, /runs from the repository root/);
  assert.match(gatewayDeployment, /Root Directory;[\s\S]*running from that app directory uploads an incomplete workspace/);
  assert.doesNotMatch(gatewayDeployment, /working-directory:\s*apps\/gateway/);
  assert.doesNotMatch(gatewayDeployment, /--cwd\s+apps\/gateway/);
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
