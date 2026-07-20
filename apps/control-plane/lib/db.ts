// DB handle + per-request workspace-scoped transaction (SPEC §15.2).
//
// getDb() (from @manifold/database, the sole owner of drizzle/postgres per §4.2) is memoized
// so the serverless invocation reuses one pooled connection (max:1, §2.4). withWorkspace()
// opens a transaction and sets `manifold.workspace_id` via `SET LOCAL` (set_config(..., true))
// so RLS (§6.16) scopes every statement; handlers ALSO filter by workspace_id explicitly
// (defense in depth, §15.2 layer 1).
import { getDb, type Database } from "@manifold/database";
import { ManifoldError } from "@/lib/http";

let cached: Database | null = null;
let cachedAdmin: Database | null = null;

/**
 * drizzle-orm/postgres-js registers IDENTITY serializers for json (oid 114) and jsonb (oid 3802)
 * on the postgres client — it expects the caller to hand it pre-stringified strings. Our raw-SQL
 * handlers (and @manifold/config's apply/revision writes) pass JS objects/arrays via `sql.json(...)`,
 * which the identity serializer would forward straight to the wire encoder (Buffer.byteLength) and
 * crash on ("Received an instance of Array"). Restore JSON.stringify so `sql.json(obj|array)`
 * encodes correctly. Safe here because we never use drizzle's query builder (which would then
 * double-encode).
 */
function patchJsonSerializers(handle: Database): Database {
  const serializers = (handle.$client as unknown as {
    options: { serializers: Record<number, (x: unknown) => string> };
  }).options.serializers;
  serializers[114] = (x: unknown) => JSON.stringify(x);
  serializers[3802] = (x: unknown) => JSON.stringify(x);
  return handle;
}

export function db(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  cached = patchJsonSerializers(getDb(url));
  return cached;
}

/**
 * Privileged connection for the ONE operation the app role must NOT be able to do: writing the
 * global/reference catalog tables (canonical_model, provider_model_offering, provider_price_revision).
 * Migration 0002 REVOKEs those writes from `manifold_app` precisely so a compromised app cannot forge
 * pricing (§6.4); its comment specifies that catalog ingestion/seeding runs "as the migration owner
 * (postgres), never as the tenant-facing app role". The bootstrap seed helper is exactly that path, so
 * it opens this separately-configured connection (MANIFOLD_SEED_DB_URL) for reference-data inserts only.
 * Returns null when unset — the app's normal request path never uses this.
 */
export function adminDb(): Database | null {
  if (cachedAdmin) return cachedAdmin;
  const url = process.env.MANIFOLD_SEED_DB_URL;
  if (!url) return null;
  cachedAdmin = patchJsonSerializers(getDb(url));
  return cachedAdmin;
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

/**
 * Assert `installationId` exists AND belongs to `workspaceId`, else throw 404 NOT_FOUND. The
 * config plan and apply routes share this ownership gate verbatim (same SQL, same 404), so it
 * lives here to stay a single source of truth (§15.2 tenant isolation).
 */
export async function requireInstallation(
  workspaceId: string,
  installationId: string,
): Promise<void> {
  const rows = await withWorkspace(workspaceId, (sql) =>
    sql<{ id: string }[]>`
      SELECT id FROM gateway_installation
      WHERE id = ${installationId} AND workspace_id = ${workspaceId} LIMIT 1`,
  );
  if (!rows[0]) {
    throw new ManifoldError({
      status: 404,
      code: "NOT_FOUND",
      message: "installation not found",
      reasonCodes: [],
    });
  }
}
