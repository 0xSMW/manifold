import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const journalPath = join(migrationsDir, "meta", "_journal.json");

test("every journaled migration documents a rollback or forward-fix path", async () => {
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const files = new Set(await readdir(migrationsDir));

  for (const entry of journal.entries) {
    const filename = `${entry.tag}.sql`;
    assert.ok(files.has(filename), `journaled migration is missing: ${filename}`);
    const source = await readFile(join(migrationsDir, filename), "utf8");
    assert.match(
      source,
      /^--\s+(?:rollback|forward-fix):\s+\S/m,
      `${filename} must document a rollback or forward-fix path`,
    );
  }
});
