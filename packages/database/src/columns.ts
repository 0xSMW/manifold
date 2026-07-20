// packages/database/src/columns.ts — shared column helpers (SPEC §6.1)
//
// Conventions (SPEC §6.1):
//  - IDs are ULIDs rendered as prefixed text (ws_…, key_…, obs_…), stored `text PRIMARY KEY`.
//  - Money is integer µ$ in BIGINT columns; token counts are BIGINT. Never numeric/float for money.
//  - Timestamps are `timestamptz`.
//  - Enums are `text` + CHECK (declared inline per table in schema.ts).
//  - `keyed_hash` / encrypted blobs are `bytea` (custom type).
import { bigint, customType, text, timestamp } from "drizzle-orm/pg-core";

/** `timestamptz` helper. */
export const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/** Integer money in micro-USD (µ$). BIGINT, never numeric/float (SPEC §6.1, §6.10). */
export const money = (name: string) => bigint(name, { mode: "bigint" });

/** Token counts. BIGINT. */
export const tokens = (name: string) => bigint(name, { mode: "bigint" });

/** Postgres `bytea` custom type (keyed hashes, wrapped DEKs, ciphertext). */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Case-insensitive text (`citext` extension, enabled in migration 0001). SPEC §6.2. */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

/** Prefixed-ULID primary key column (`text PRIMARY KEY`). */
export const id = (name = "id") => text(name).primaryKey();

/**
 * `id` column WITHOUT a primary-key constraint, for partitioned tables whose PK
 * must be composite `(id, created_at)` (B1). The PK is declared in the table's
 * extra-config callback via `primaryKey({ columns: [...] })`.
 */
export const partId = (name = "id") => text(name).notNull();
