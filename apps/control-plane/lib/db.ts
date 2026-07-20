// DB handle + per-request workspace-scoped transaction (SPEC §15.2).
//
// getDb() (from @manifold/database, the sole owner of drizzle/postgres per §4.2) is memoized
// so the serverless invocation reuses one pooled connection (max:1, §2.4). withWorkspace()
// opens a transaction and sets `manifold.workspace_id` via `SET LOCAL` (set_config(..., true))
// so RLS (§6.16) scopes every statement; handlers ALSO filter by workspace_id explicitly
// (defense in depth, §15.2 layer 1).
import { getDb, type Database } from "@manifold/database";

let cached: Database | null = null;

export function db(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const handle = getDb(url);
  // drizzle-orm/postgres-js registers IDENTITY serializers for json (oid 114) and jsonb
  // (oid 3802) on the postgres client — it expects the caller to hand it pre-stringified
  // strings. Our raw-SQL handlers (and @manifold/config's apply/revision writes) pass JS
  // objects/arrays via `sql.json(...)`, which the identity serializer would forward straight
  // to the wire encoder (Buffer.byteLength) and crash on ("Received an instance of Array").
  // Restore JSON.stringify so `sql.json(obj|array)` encodes correctly. Safe here because we
  // never use drizzle's query builder (which would then double-encode).
  const serializers = (handle.$client as unknown as {
    options: { serializers: Record<number, (x: unknown) => string> };
  }).options.serializers;
  serializers[114] = (x: unknown) => JSON.stringify(x);
  serializers[3802] = (x: unknown) => JSON.stringify(x);
  cached = handle;
  return cached;
}

/** The postgres-js tagged-template client the config package also uses (Database["$client"]). */
export type Sql = Database["$client"];

/** The raw connection, for cross-tenant lookups that precede workspace resolution (auth). */
export function rawSql(): Sql {
  return db().$client;
}

/**
 * Run `fn` inside a transaction with `manifold.workspace_id` set for the tenant. All reads
 * and writes in the txn are RLS-scoped to that workspace; `fn` should still pass workspaceId
 * into its predicates.
 */
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = db().$client;
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}
