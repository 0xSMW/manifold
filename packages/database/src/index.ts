// @manifold/database — the ONLY package that imports drizzle-orm / postgres (SPEC §4.2).
// Exports the full §6 schema and a connection helper.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export * from "./schema";
export * from "./columns";
export { schema };

export type Database = ReturnType<typeof getDb>;

/**
 * The raw `postgres` (postgres-js) client type. This package is the ONLY place the
 * `postgres` driver is imported (SPEC §4.2), so downstream packages that need the
 * strong-consistency transaction surface (e.g. the hard-budget reservation txn, §16.3)
 * take this type from here instead of importing the driver directly.
 */
export type Sql = ReturnType<typeof postgres>;

/**
 * The scoped client handed to a `sql.begin(async (tx) => …)` callback — the surface a
 * strong-consistency transaction (the §16.3 reservation txn) actually runs against.
 */
export type TransactionSql = postgres.TransactionSql<{}>;

/**
 * The postgres-js tagged-template surface `setWorkspaceGuc` runs against — satisfied by both
 * the base `Sql` client and a scoped `TransactionSql`, so a caller passes whichever it holds.
 */
export type WorkspaceScopedSql = Sql | TransactionSql;

/**
 * Set the RLS tenant GUC `manifold.workspace_id` for the CURRENT transaction (SPEC §6.16, §15.2).
 *
 * This is the ONE definition of that GUC write; @manifold/budget, @manifold/config, and the
 * control-plane all route through it instead of copy-pasting the statement (DRY §9). Behaviour is
 * exactly the previous inline form:
 *   - `set_config(..., true)` — the SET LOCAL semantics: the binding is transaction-scoped and
 *     reverts at COMMIT/ROLLBACK. The `true` third arg is load-bearing (a missing/`false` value
 *     would leak the tenant across the pooled connection — a tenancy bug).
 *   - The caller still owns BEGIN; this only sets the GUC. It MUST be issued inside the caller's
 *     `sql.begin(...)` and BEFORE any RLS-protected read/lock, so the row is visible to the lock
 *     (set-after-lock is a tenancy bug). RLS stays fail-closed: an unset GUC matches zero rows.
 *   - The GUC name `manifold.workspace_id` is unchanged.
 */
export async function setWorkspaceGuc(
  sql: WorkspaceScopedSql,
  workspaceId: string,
): Promise<void> {
  await sql`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
}

/**
 * Open a raw postgres-js client bound to the pooled connection string.
 *
 * `max: 1` by default per SPEC §2.4 / §4.2 (one connection per serverless invocation
 * against the pooler); callers that need genuine intra-process concurrency — the budget
 * reservation load/attack tests, a Compose worker — pass a larger `max`.
 */
export function getClient(url: string, options?: postgres.Options<{}>): Sql {
  return postgres(url, { max: 1, ...options });
}

/**
 * Open a Drizzle database handle bound to the full §6 schema.
 *
 * `max: 1` per SPEC §2.4 / §4.2: serverless functions use a single connection per
 * invocation against the pooler. Callers set `SET LOCAL manifold.workspace_id` at the
 * start of every request transaction to satisfy RLS (§6.16, §15.2).
 */
export function getDb(url: string, options?: postgres.Options<{}>) {
  return drizzle(getClient(url, options), { schema });
}
