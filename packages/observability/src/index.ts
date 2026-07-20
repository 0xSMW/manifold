// packages/observability/src/index.ts — @manifold/observability public entrypoint.
//
// Pure, deterministic observation reduction + projection (SPEC §8.3, §6.8, §6.9, §16.6,
// ADR-0011). Imports ONLY @manifold/contracts + @manifold/domain — no platform, no drizzle,
// no react (SPEC §4.2).
export * from "./events.js";
export * from "./observation.js";
export * from "./reduce.js";
export * from "./project.js";
