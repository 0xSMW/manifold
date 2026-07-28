# Agent Guidelines

## Best Practices

- Deploy production candidates early; Vercel exposes root-directory, environment, and compiler drift that local gates miss.
- Verify release changes from a frozen clean install; hoisted or transitive local dependencies are false confidence.
- Run the exact command from the exact directory used by CI and Vercel before declaring a gate fixed.
- Keep deploy entrypoints inside TypeScript coverage; include `api/**/*.ts` and preserve required DOM libraries in child configs.
- Pin shared build tools at the workspace root when root scripts invoke them; package-local availability does not make them root dependencies.
- Assert config semantics in source-contract tests; avoid brittle lockfile ordering and full-text serialization matches.
- Read the failed step log before changing code; workflow summaries hide the actionable compiler or assertion error.
- Deploy independent services concurrently, validate candidate provenance and health, then move public aliases.
