import { spawnSync } from "node:child_process";

const suites = [
  ["packages/crypto/tsconfig.json", ["packages/crypto/test/crypto-attacks.test.ts"]],
  ["packages/config/tsconfig.json", ["packages/config/test/signing-attacks.test.ts", "packages/config/test/policy-e2e-pg.test.ts"]],
  ["packages/gateway-core/tsconfig.json", ["packages/gateway-core/test/ssrf-attacks.test.ts", "packages/gateway-core/test/enforce-hardening.test.ts", "packages/gateway-core/test/policy-parity.test.ts"]],
  ["apps/gateway/tsconfig.json", ["apps/gateway/test/credentials.test.ts", "apps/gateway/test/egress-redirect.test.ts", "apps/gateway/test/enforcement.test.ts", "apps/gateway/test/pinned-egress.test.ts"]],
  ["packages/budget/tsconfig.json", ["packages/budget/test/budget-attacks.test.ts", "packages/budget/test/rls-money.test.ts"]],
];

const build = spawnSync("pnpm", ["exec", "tsc", "-b", "packages/crypto", "packages/config", "packages/gateway-core", "packages/observability", "packages/budget"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

for (const [tsconfig, tests] of suites) {
  const result = spawnSync("pnpm", ["exec", "tsx", "--tsconfig", tsconfig, "--test", ...tests], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
