import { defineConfig } from "drizzle-kit";

// Base DDL generation (SPEC §6). Drizzle does not emit PARTITION BY; the RANGE/LIST
// partitioning, RLS policies (§6.16), and immutability triggers (§6.15) are declared
// in migrations/0001_partitions.sql, applied after the generated base migration.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/manifold",
  },
  verbose: true,
  strict: true,
});
