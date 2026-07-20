// packages/domain/src/index.ts — @manifold/domain public entrypoint.
//
// Pure domain types, value objects, and state machines (SPEC §4.3, §5). This package
// imports ONLY from @manifold/contracts — no platform imports, no drizzle, no react
// (SPEC §4.2).
export * from "./values/index.js";
export * from "./machines/index.js";
