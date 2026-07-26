import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function runFreshness(overrides = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/check-database-schema-freshness.mjs"], {
      cwd: root,
      env: { ...process.env, ...overrides },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("migration freshness CI gate fingerprints canonical schema and migration DDL", async () => {
  const source = await readFile(join(root, "scripts", "check-database-schema-freshness.mjs"), "utf8");
  assert.match(source, /schemaTables/);
  assert.match(source, /schemaIndexes/);
  assert.match(source, /CREATE\\s\+TABLE/);
  assert.match(source, /CREATE\\s\+\(\?:UNIQUE/);
  assert.match(source, /schemaSha256/);
  assert.match(source, /drizzleGeneratedSha256/);
  assert.match(source, /drizzle-kit", "generate/);
  assert.match(source, /migrationSources/);
});

test("migration freshness fails when a migration-defined Drizzle column is omitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manifold-schema-freshness-"));
  const schemaPath = join(directory, "schema.ts");
  try {
    const schema = await readFile(join(root, "packages", "database", "src", "schema.ts"), "utf8");
    const driftedSchema = schema.replaceAll('"cursor_row_id"', '"cursor_row_id_omitted"');
    assert.doesNotMatch(driftedSchema, /text\("cursor_row_id"/);
    await writeFile(schemaPath, driftedSchema);
    const result = await runFreshness({ MANIFOLD_SCHEMA_PATH: schemaPath });
    assert.notEqual(result, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical DDL fingerprint rejects type, nullability, default, FK, policy, grant, trigger, and index drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manifold-ddl-freshness-"));
  const schemaPath = join(directory, "schema.ts");
  const migrationsPath = join(directory, "migrations");
  try {
    const schema = await readFile(join(root, "packages", "database", "src", "schema.ts"), "utf8");
    const driftedSchema = schema
      .replace('integer("chunk_number").notNull()', 'text("chunk_number").notNull()')
      .replace('text("state").notNull().default("exporting")', 'text("state").default("pending")');
    await writeFile(schemaPath, driftedSchema);
    await cp(join(root, "packages", "database", "migrations"), migrationsPath, { recursive: true });

    const chunk = join(migrationsPath, "0031_storage_resumable_multipart.sql");
    const scheduler = join(migrationsPath, "0029_storage_scheduler.sql");
    const partitions = join(migrationsPath, "0001_partitions.sql");
    await writeFile(chunk, (await readFile(chunk, "utf8"))
      .replace("ON DELETE CASCADE", "ON DELETE RESTRICT")
      .replace("current_setting('manifold.workspace_id', true)", "current_setting('wrong.workspace_id', true)")
      .replace("TO manifold_app", "TO wrong_role"));
    await writeFile(scheduler, (await readFile(scheduler, "utf8"))
      .replace("WHERE \"kind\" = 'storage.compact'", "WHERE \"kind\" = 'storage.wrong'"));
    await writeFile(partitions, (await readFile(partitions, "utf8"))
      .replace("CREATE TRIGGER", "CREATE TRIGGER drifted_"));

    const result = await runFreshness({
      MANIFOLD_SCHEMA_PATH: schemaPath,
      MANIFOLD_MIGRATIONS_DIR: migrationsPath,
    });
    assert.notEqual(result, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
