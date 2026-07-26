import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-mutation-cleanup" });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_cleanup_a','cleanup-a','Cleanup A','local'), ('ws_cleanup_b','cleanup-b','Cleanup B','local');
    INSERT INTO mutation_idempotency
      (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key, request_hash, lease_expires_at, expires_at)
    VALUES
      ('idem_cleanup_expired_a','ws_cleanup_a','api_token','a','POST','/a','expired-a','hash',now(),now()-interval '1 minute'),
      ('idem_cleanup_expired_b','ws_cleanup_b','api_token','b','POST','/b','expired-b','hash',now(),now()-interval '1 minute'),
      ('idem_cleanup_fresh_b','ws_cleanup_b','api_token','b','POST','/b','fresh-b','hash',now(),now()+interval '1 hour');
    INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
    VALUES
      ('ws_cleanup_a','api_token','a','POST /a',now()-interval '2 minutes',1,now()-interval '1 minute'),
      ('ws_cleanup_b','api_token','b','POST /b',now()-interval '2 minutes',1,now()-interval '1 minute'),
      ('ws_cleanup_b','api_token','b','POST /b',now(),1,now()+interval '1 hour');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

async function asApp<T>(workspaceId: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

test("scheduled cleanup reclaims expired rows after inactivity in bounded retry-safe batches", async () => {
  const first = await asApp("ws_cleanup_a", (sql) => sql<{ replay_rows_deleted: number; rate_buckets_deleted: number }[]>`
    SELECT * FROM cleanup_expired_mutation_guards(${1})`);
  assert.deepEqual(Array.from(first), [{ replay_rows_deleted: 1, rate_buckets_deleted: 1 }]);

  const second = await asApp("ws_cleanup_a", (sql) => sql<{ replay_rows_deleted: number; rate_buckets_deleted: number }[]>`
    SELECT * FROM cleanup_expired_mutation_guards(${1})`);
  assert.deepEqual(Array.from(second), [{ replay_rows_deleted: 1, rate_buckets_deleted: 1 }]);

  const retry = await asApp("ws_cleanup_a", (sql) => sql<{ replay_rows_deleted: number; rate_buckets_deleted: number }[]>`
    SELECT * FROM cleanup_expired_mutation_guards(${1})`);
  assert.deepEqual(Array.from(retry), [{ replay_rows_deleted: 0, rate_buckets_deleted: 0 }]);
});

test("cleanup removes only expired rows and retains tenant isolation for normal app queries", async () => {
  await asApp("ws_cleanup_b", async (sql) => {
    const journals = await sql<{ id: string }[]>`SELECT id FROM mutation_idempotency ORDER BY id`;
    assert.deepEqual(Array.from(journals), [{ id: "idem_cleanup_fresh_b" }]);
    const buckets = await sql<{ workspace_id: string }[]>`SELECT workspace_id FROM mutation_rate_limit_bucket`;
    assert.deepEqual(Array.from(buckets), [{ workspace_id: "ws_cleanup_b" }]);
    const crossTenantDelete = await sql`DELETE FROM mutation_idempotency WHERE workspace_id='ws_cleanup_a'`;
    assert.equal(crossTenantDelete.count, 0, "the app role cannot delete another tenant's journal");
  });
  const remaining = await pg.sql<{ journals: string; buckets: string }[]>`
    SELECT
      (SELECT count(*)::text FROM mutation_idempotency WHERE expires_at > now()) AS journals,
      (SELECT count(*)::text FROM mutation_rate_limit_bucket WHERE expires_at > now()) AS buckets`;
  assert.deepEqual(remaining[0], { journals: "1", buckets: "1" });
});
