import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { withSeedBootstrapLock } from "../lib/seed-bootstrap.ts";
import type { Sql } from "../lib/db.ts";

let pg: PgHarness;

before(async () => { pg = await startPg({ namePrefix: "mf-seed-bootstrap", poolSize: 8 }); }, { timeout: 180_000 });
after(async () => { await pg?.stop(); });

test("same-slug bootstrap is serialized so a concurrent loser observes the committed workspace", async () => {
  const slug = `seed-lock-${Date.now()}`;
  let entered!: () => void;
  const enteredFirst = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const releaseFirst = new Promise<void>((resolve) => { release = resolve; });

  const first = withSeedBootstrapLock(pg.sql as unknown as Sql, async (sql) => {
    await sql`INSERT INTO workspace (id, slug, name, region) VALUES ('ws_seed_lock', ${slug}, 'locked', 'local')`;
    entered();
    await releaseFirst;
    return "created";
  });
  await enteredFirst;
  const second = withSeedBootstrapLock(pg.sql as unknown as Sql, async (sql) => {
    const rows = await sql<{ id: string }[]>`SELECT id FROM workspace WHERE slug = ${slug}`;
    return rows[0] ? "already_seeded" : "created";
  });
  release();
  assert.deepEqual(await Promise.all([first, second]), ["created", "already_seeded"]);
  const rows = await pg.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM workspace WHERE slug = ${slug}`;
  assert.equal(rows[0]?.count, "1");
});

test("an injected bootstrap failure rolls back both catalog and workspace rows", async () => {
  const suffix = Date.now().toString(36);
  const catalogId = `cm_seed_fail_${suffix}`;
  const workspaceId = `ws_seed_fail_${suffix}`;
  const slug = `seed-fail-${suffix}`;
  await assert.rejects(() => withSeedBootstrapLock(pg.sql as unknown as Sql, async (sql) => {
    await sql`INSERT INTO canonical_model (id, canonical_slug, family, display_name, catalog_revision)
      VALUES (${catalogId}, ${`seed-fail-${suffix}`}, 'gpt', 'Seed failure', 'seed')`;
    await sql`INSERT INTO workspace (id, slug, name, region)
      VALUES (${workspaceId}, ${slug}, 'Seed failure', 'local')`;
    throw new Error("injected bootstrap failure");
  }), /injected bootstrap failure/);
  const [catalog, workspaces] = await Promise.all([
    pg.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM canonical_model WHERE id = ${catalogId}`,
    pg.sql<{ count: string }[]>`SELECT count(*)::text AS count FROM workspace WHERE id = ${workspaceId}`,
  ]);
  assert.equal(catalog[0]?.count, "0", "catalog insert must roll back");
  assert.equal(workspaces[0]?.count, "0", "workspace insert must roll back");
});

test("different-slug bootstrap waits on the database lock and fails without creating a second workspace", async () => {
  const suffix = Date.now().toString(36);
  const firstSlug = `seed-first-${suffix}`;
  const secondSlug = `seed-second-${suffix}`;
  let entered!: () => void;
  const enteredFirst = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const releaseFirst = new Promise<void>((resolve) => { release = resolve; });

  const first = withSeedBootstrapLock(pg.sql as unknown as Sql, async (sql) => {
    await sql`INSERT INTO workspace (id, slug, name, region) VALUES (${`ws_seed_first_${suffix}`}, ${firstSlug}, 'first', 'local')`;
    entered();
    await releaseFirst;
    return "created";
  });
  await enteredFirst;
  const second = withSeedBootstrapLock(pg.sql as unknown as Sql, async (sql) => {
    const [existing] = await sql<{ slug: string }[]>`SELECT slug FROM workspace ORDER BY created_at, id LIMIT 1`;
    if (existing?.slug !== secondSlug) throw new Error("BOOTSTRAP_WORKSPACE_EXISTS");
    return "created";
  });
  release();
  assert.equal(await first, "created");
  await assert.rejects(second, /BOOTSTRAP_WORKSPACE_EXISTS/);
  const rows = await pg.sql<{ slug: string }[]>`SELECT slug FROM workspace WHERE slug = ${firstSlug} OR slug = ${secondSlug} ORDER BY slug`;
  assert.deepEqual(rows.map((row) => row.slug), [firstSlug]);
});
