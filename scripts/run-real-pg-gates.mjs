import { spawnSync } from "node:child_process";

const suites = [
  ["@manifold/database", ["test/isolation.test.ts"]],
  ["@manifold/budget", ["test/budget-attacks.test.ts", "test/rls-money.test.ts"]],
  ["@manifold/config", ["test/*-pg.test.ts"]],
  ["@manifold/storage", ["test/*-pg.test.ts"]],
  ["@manifold/gateway", ["test/*-pg.test.ts"]],
  ["@manifold/control-plane", ["test/*-pg.test.ts"]],
];

for (const [workspace, tests] of suites) {
  // Each test owns a real Postgres container. Serializing files keeps the release gate within
  // ordinary CI/Docker disk limits and prevents one exhausted fixture from crashing its peers.
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      workspace,
      "exec",
      "tsx",
      "--tsconfig",
      "tsconfig.json",
      "--test",
      "--test-concurrency=1",
      ...tests,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
