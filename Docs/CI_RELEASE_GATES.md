# CI and release gates

Every pull request runs the root commands defined in `package.json`. The normal
`test-build` check covers type checking, build, package unit/contract tests, the
control-plane TS/MJS suite, boundary and workspace-query lint, migration
freshness/documentation, and Chromium desktop/mobile Playwright coverage. The
Playwright configuration includes accessibility assertions and visual baselines;
its report, traces, screenshots, and videos upload whenever that check fails.

`security-storage-gates` is a distinct required branch-protection check. It runs
security and cross-tenant negative suites plus the real-Postgres and deterministic
storage/release suites. Its workflow has no conditional bypass or
`continue-on-error`. Configure both `test-build` and `security-storage-gates` as
required status checks in the repository's branch-protection rule; GitHub branch
protection is the enforcement mechanism that prevents a merge while either gate is red.

CI uses Node 22, installs from the frozen pnpm lockfile, installs only Playwright
Chromium, and starts throwaway Postgres 16 containers from the test harnesses. It
does not read production credentials. `check:environment-isolation` rejects known
production secret variables and rejects a production deployment tier, so preview
and staging jobs must use fixtures, containers, or ephemeral test values.

Useful local entrypoints (Docker is required for real-Postgres suites):

- `pnpm run test:control-plane`
- `pnpm run test:security`
- `pnpm run test:pg`
- `pnpm run test:storage-release`
- `pnpm run test:playwright`
