/**
 * Verify that every durable logical table and named index introduced by a committed
 * migration has a Drizzle declaration. CI runs drizzle-kit generate against an
 * OS-temporary output directory, so the checked-out migrations stay read-only.
 *
 * Physical partition children are owned by the partition migration, rather than by
 * Drizzle's logical-table model, and are enumerated here explicitly. Adding any
 * other migration table or named index without its schema declaration fails CI.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = process.env.MANIFOLD_MIGRATIONS_DIR ?? join(root, "packages", "database", "migrations");
const schemaPath = process.env.MANIFOLD_SCHEMA_PATH ?? join(root, "packages", "database", "src", "schema.ts");
const manifestPath = process.env.MANIFOLD_SCHEMA_FRESHNESS_MANIFEST
  ?? join(root, "packages", "database", "migrations", "meta", "schema-freshness.json");
const databaseDir = join(root, "packages", "database");
const execFileAsync = promisify(execFile);

// These are PostgreSQL partition children, not independently queryable logical
// tables. Keep this allowlist narrow so an application table can never disappear
// from schema.ts unnoticed.
const physicalPartitionChildren = new Set([
  "usage_aggregate_hourly",
  "usage_aggregate_daily",
  "usage_aggregate_monthly",
  "observation_event_default",
  "observation_default",
  "trace_summary_default",
  "policy_decision_default",
  "usage_record_default",
  "cost_ledger_default",
  "audit_event_default",
  "budget_reservation_default",
]);

const schema = await readFile(schemaPath, "utf8");
const schemaTables = new Set(
  [...schema.matchAll(/\bpgTable\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
);
const schemaIndexes = new Set(
  [...schema.matchAll(/\b(?:uniqueIndex|index)\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
);

const files = (await readdir(migrationsDir))
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

/** Stable semantic source form: formatting and standalone comments do not affect a digest. */
function canonical(source, comment = "--") {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(comment))
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

function digest(source, comment) {
  return createHash("sha256").update(canonical(source, comment)).digest("hex");
}

/**
 * Drizzle's loader follows .js specifiers literally. Stage the schema and its
 * column helper in an OS temporary directory with a .ts specifier, then generate
 * there. The generated SQL and snapshot are compared, never written to git.
 */
async function drizzleGeneratedDigest(sourceSchemaPath) {
  const temp = await mkdtemp(join(tmpdir(), "manifold-drizzle-freshness-"));
  const stagedSchema = join(temp, "schema.ts");
  const stagedColumns = join(temp, "columns.ts");
  const output = join(temp, "generated");
  try {
    const source = await readFile(sourceSchemaPath, "utf8");
    await writeFile(stagedSchema, source.replaceAll('"./columns.js"', '"./columns.ts"'));
    await cp(join(databaseDir, "src", "columns.ts"), stagedColumns);
    await execFileAsync("npx", ["drizzle-kit", "generate", "--config", "drizzle.config.ts"], {
      cwd: databaseDir,
      env: { ...process.env, DRIZZLE_SCHEMA: stagedSchema, DRIZZLE_OUT: output },
      maxBuffer: 8 * 1024 * 1024,
    });
    const outputFiles = await readdir(output);
    const sqlFile = outputFiles.find((file) => /^\d{4}_.+\.sql$/.test(file));
    assert.ok(sqlFile, "drizzle-kit did not produce generated SQL");
    const snapshot = JSON.parse(await readFile(join(output, "meta", "0000_snapshot.json"), "utf8"));
    // Generation UUID and journal clock/tag are deliberately non-semantic.
    delete snapshot.id;
    delete snapshot.prevId;
    const sql = await readFile(join(output, sqlFile), "utf8");
    return createHash("sha256")
      .update(canonical(sql, "--"))
      .update("\n-- snapshot --\n")
      .update(JSON.stringify(snapshot))
      .digest("hex");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const migrationSources = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(join(migrationsDir, file), "utf8")])),
);
const semanticManifest = {
  version: 1,
  schemaSha256: digest(schema, "//"),
  drizzleGeneratedSha256: await drizzleGeneratedDigest(schemaPath),
  migrations: Object.fromEntries(files.map((file) => [file, digest(migrationSources.get(file), "--")])),
};

if (process.argv.includes("--print-manifest")) {
  console.log(JSON.stringify(semanticManifest, null, 2));
  process.exit(0);
}

const committedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.deepEqual(
  semanticManifest,
  committedManifest,
  "database schema canonical DDL fingerprint differs; add the intended migration/schema change and regenerate packages/database/migrations/meta/schema-freshness.json",
);

const missingTables = [];
const missingIndexes = [];
const missingColumns = [];
const missingConstraints = [];

function schemaTableSegment(table) {
  const start = schema.search(new RegExp(`pgTable\\(\\s*[\"']${table}[\"']`));
  if (start < 0) return "";
  const next = schema.indexOf("\nexport const ", start + 1);
  return schema.slice(start, next < 0 ? undefined : next);
}

function assertMigrationColumn(table, column, migration) {
  const segment = schemaTableSegment(table);
  const isWorkspaceHelper = column === "workspace_id" && /\bwsId\(\)/.test(segment);
  if (!isWorkspaceHelper && !new RegExp(`\\(\\s*[\"']${column}[\"']`).test(segment)) {
    missingColumns.push(`${table}.${column} (${migration})`);
  }
}

function assertMigrationConstraint(table, constraint, migration) {
  const segment = schemaTableSegment(table);
  if (!segment.includes(`\"${constraint}\"`)) {
    missingConstraints.push(`${table}.${constraint} (${migration})`);
  }
}

for (const file of files) {
  const migration = migrationSources.get(file);
  // Historical base DDL predates a machine-readable Drizzle snapshot. Starting
  // with the storage/control-plane completion series, each additive migration is
  // checked structurally as well as by object name.
  const enforceShape = Number.parseInt(file.slice(0, 4), 10) >= 29;

  for (const match of migration.matchAll(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gim)) {
    const table = match[1];
    if (!physicalPartitionChildren.has(table) && !schemaTables.has(table)) {
      missingTables.push(`${table} (${file})`);
    }

    if (enforceShape) {
      const statement = migration.slice(match.index, migration.indexOf(";--> statement-breakpoint", match.index));
      for (const columnMatch of statement.matchAll(/^\s+\"([a-z_][a-z0-9_]*)\"\s+(?:text|integer|bigint|boolean|jsonb|timestamp|numeric|double precision|date|bytea|citext)\b/gim)) {
        assertMigrationColumn(table, columnMatch[1], file);
      }
      for (const constraintMatch of statement.matchAll(/CONSTRAINT\s+\"([a-z_][a-z0-9_]*)\"/gi)) {
        const constraint = constraintMatch[1];
        if (!migration.includes(`RENAME CONSTRAINT \"${constraint}\"`)) {
          assertMigrationConstraint(table, constraint, file);
        }
      }
    }
  }

  if (enforceShape) {
    for (const alterMatch of migration.matchAll(/ALTER\s+TABLE\s+\"([a-z_][a-z0-9_]*)\"\s+([\s\S]*?);--> statement-breakpoint/gim)) {
      const [, table, alteration] = alterMatch;
      for (const columnMatch of alteration.matchAll(/ADD\s+COLUMN\s+\"([a-z_][a-z0-9_]*)\"/gi)) {
        assertMigrationColumn(table, columnMatch[1], file);
      }
      for (const constraintMatch of alteration.matchAll(/ADD\s+CONSTRAINT\s+\"([a-z_][a-z0-9_]*)\"/gi)) {
        const constraint = constraintMatch[1];
        if (!migration.includes(`RENAME CONSTRAINT \"${constraint}\"`)) {
          assertMigrationConstraint(table, constraint, file);
        }
      }
    }
  }

  for (const match of migration.matchAll(/^CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?\s+ON\b/gim)) {
    const index = match[1];
    if (!schemaIndexes.has(index)) missingIndexes.push(`${index} (${file})`);
  }
}

assert.deepEqual(
  missingTables,
  [],
  `Drizzle schema is missing migration-defined table(s): ${missingTables.join(", ")}`,
);
assert.deepEqual(
  missingColumns,
  [],
  `Drizzle schema is missing migration-defined column(s): ${missingColumns.join(", ")}`,
);
assert.deepEqual(
  missingConstraints,
  [],
  `Drizzle schema is missing migration-defined constraint(s): ${missingConstraints.join(", ")}`,
);
assert.deepEqual(
  missingIndexes,
  [],
  `Drizzle schema is missing migration-defined index(es): ${missingIndexes.join(", ")}`,
);

console.log(
  `Database schema freshness passed: ${schemaTables.size} logical tables and ${schemaIndexes.size} named indexes cover ${files.length} migrations.`,
);
