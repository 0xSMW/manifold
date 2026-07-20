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
 * Open a Drizzle database handle bound to the full §6 schema.
 *
 * `max: 1` per SPEC §2.4 / §4.2: serverless functions use a single connection per
 * invocation against the pooler. Callers set `SET LOCAL manifold.workspace_id` at the
 * start of every request transaction to satisfy RLS (§6.16, §15.2).
 */
export function getDb(url: string, options?: postgres.Options<{}>) {
  const client = postgres(url, { max: 1, ...options });
  return drizzle(client, { schema });
}
