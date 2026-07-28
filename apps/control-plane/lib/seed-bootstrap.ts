import type { Sql } from "@/lib/db";

/**
 * Bootstrap has no workspace principal until it commits. Serialize every request against one
 * database-bootstrap lock on the privileged connection so the one-workspace decision, catalog
 * rows, and tenant rows form one atomic decision. PostgreSQL releases this transaction-level
 * advisory lock on commit or rollback.
 */
export async function withSeedBootstrapLock<T>(
  sql: Sql,
  operation: (tx: Sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('manifold:bootstrap'))`;
    return operation(tx as unknown as Sql);
  }) as Promise<T>;
}
