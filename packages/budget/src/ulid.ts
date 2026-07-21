// packages/budget/src/ulid.ts — the reservation's ULID vocabulary, sourced from the shared leaf.
//
// Budget owns no id encoder of its own any more: `ulid`/`ulidTimeMs`/`ulidCreatedAt` come from
// `@manifold/ids` so the id shape budget mints and decodes is byte-for-byte the SAME one the pure
// gateway-core mints for the trace-id (which becomes the reservation `request_id`). The reservation
// transaction derives `budget_reservation.created_at` deterministically from that ULID's timestamp
// (SPEC §6.7 B1, §16.3) — NOT from now() — so a retried invocation of the same request maps to the
// same monthly partition and the `(budget_account_id, request_id, created_at)` unique preserves
// exact single-reserve idempotency across a partition boundary. Re-exported here so `@manifold/budget`
// keeps its existing public surface (`export { ulid, ulidCreatedAt, ulidTimeMs }`).
export { ulid, ulidCreatedAt, ulidTimeMs } from "@manifold/ids";
