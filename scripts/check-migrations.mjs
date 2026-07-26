import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const migrations = join(new URL("..", import.meta.url).pathname, "packages/database/migrations");
const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
const sqlFiles = (await readdir(migrations)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const journalFiles = journal.entries.map(({ tag }) => `${tag}.sql`);
assert.deepEqual(journalFiles, sqlFiles, "migration journal must exactly match committed SQL migrations");
console.log(`Migration freshness passed for ${sqlFiles.length} migrations.`);
