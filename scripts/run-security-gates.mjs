import { spawnSync } from "node:child_process";

const suites = [
  ["@manifold/crypto", ["test/crypto-attacks.test.ts"]],
  ["@manifold/config", ["test/signing-attacks.test.ts", "test/policy-e2e-pg.test.ts"]],
  ["@manifold/gateway-core", ["test/ssrf-attacks.test.ts", "test/enforce-hardening.test.ts", "test/policy-parity.test.ts"]],
  ["@manifold/gateway", ["test/credentials.test.ts", "test/egress-redirect.test.ts", "test/enforcement.test.ts", "test/pinned-egress.test.ts"]],
  ["@manifold/budget", ["test/budget-attacks.test.ts", "test/rls-money.test.ts"]],
];

for (const [workspace, tests] of suites) {
  const result = spawnSync("pnpm", ["--filter", workspace, "exec", "tsx", "--tsconfig", "tsconfig.json", "--test", ...tests], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
