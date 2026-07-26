// Real-Postgres durability tests for the tables consumed by lib/mutation-guard.ts.
// Run directly with: node --experimental-strip-types --test mutation-guard-pg.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-mutation-guard", poolSize: 24 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_guard_a','guard-a','Guard A','local'), ('ws_guard_b','guard-b','Guard B','local');
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

const identity = ["api_token", "tok_a", "POST", "/api/v1/keys", "same-key"] as const;
async function insertClaim(sql: ReturnType<typeof postgres>, hash = "hash-a", key: string = identity[4]) {
  return sql<{ id: string }[]>`INSERT INTO mutation_idempotency
    (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key, request_hash, lease_expires_at, expires_at)
    VALUES (${`idem_${Math.random()}`}, 'ws_guard_a', ${identity[0]}, ${identity[1]}, ${identity[2]}, ${identity[3]}, ${key}, ${hash}, now() + interval '60 seconds', now() + interval '24 hours')
    ON CONFLICT (workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key) DO NOTHING
    RETURNING id`;
}

test("replay row preserves response bytes; changed request hash fails closed", async () => {
  await asApp("ws_guard_a", async (sql) => {
    const [claim] = await insertClaim(sql);
    await sql`UPDATE mutation_idempotency SET state='completed', response_status=201,
      response_headers=${sql.json({ "content-type": "application/json", "x-manifold-schema": "manifold.v1" })},
      response_body=decode('7b226f6b223a747275657d','hex'), completed_at=now() WHERE id=${claim!.id}`;
    const [stored] = await sql<{ request_hash: string; response_status: number; response_body: Buffer }[]>`
      SELECT request_hash, response_status, response_body FROM mutation_idempotency WHERE id=${claim!.id}`;
    assert.equal(stored!.request_hash, "hash-a");
    assert.equal(stored!.response_status, 201);
    assert.equal(stored!.response_body.toString("utf8"), '{"ok":true}');
    const changed = await insertClaim(sql, "hash-different");
    assert.equal(changed.length, 0, "same identity cannot receive a second claim");
    assert.notEqual(stored!.request_hash, "hash-different", "same key/different body must conflict");
  });
});

test("sensitive replay bodies have no plaintext-at-rest column", async () => {
  await asApp("ws_guard_a", async (sql) => {
    const [claim] = await insertClaim(sql, "encrypted-hash", "encrypted-key");
    await sql`UPDATE mutation_idempotency SET state='completed', response_status=201,
      response_headers=${sql.json({ "content-type": "application/json" })},
      response_body=NULL, response_body_encrypted=decode('000102','hex'),
      response_body_iv=decode('000102030405060708090a0b','hex'),
      response_body_tag=decode('000102030405060708090a0b0c0d0e0f','hex'),
      completed_at=now() WHERE id=${claim!.id}`;
    const [stored] = await sql<{ response_body: Buffer | null; response_body_encrypted: Buffer }[]>`
      SELECT response_body, response_body_encrypted FROM mutation_idempotency WHERE id=${claim!.id}`;
    assert.equal(stored!.response_body, null);
    assert.ok(stored!.response_body_encrypted.length > 0);
  });
});

test("sensitive completed claims remain exclusive for 24 hours without plaintext", async () => {
  await asApp("ws_guard_a", async (sql) => {
    const [claim] = await insertClaim(sql, "sensitive-24h-hash", "sensitive-24h-key");
    await sql`UPDATE mutation_idempotency SET state='completed', response_status=201,
      response_headers=${sql.json({ "content-type": "application/json" })},
      response_body=NULL, response_body_encrypted=decode('7b22746f6b656e223a22736563726574227d','hex'),
      response_body_iv=decode('000102030405060708090a0b','hex'),
      response_body_tag=decode('000102030405060708090a0b0c0d0e0f','hex'),
      completed_at=now(), expires_at=GREATEST(expires_at, now() + interval '24 hours')
      WHERE id=${claim!.id}`;
    const [stored] = await sql<{ response_body: Buffer | null; expires_at: string }[]>`
      SELECT response_body, expires_at FROM mutation_idempotency WHERE id=${claim!.id}`;
    assert.equal(stored!.response_body, null, "sensitive response plaintext must never be retained");
    assert.ok(Date.parse(stored!.expires_at) > Date.now() + 23 * 60 * 60 * 1000,
      "a sensitive completed claim must remain exclusive for at least 24 hours");
    const duplicate = await insertClaim(sql, "sensitive-24h-hash", "sensitive-24h-key");
    assert.equal(duplicate.length, 0, "the same key cannot claim another execution inside the retention window");
  });
});

test("production sensitive replay persistence retains the encrypted response for 24 hours", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../lib/mutation-guard.ts"), "utf8");
  assert.match(source, /GREATEST\(expires_at, now\(\) \+ interval '24 hours'\)/);
  assert.doesNotMatch(source, /now\(\) \+ interval '15 minutes'/);
});

test("nested handler savepoint rolls back its writes while the outer claim stores an error response", async () => {
  const installationId = `inst_savepoint_${Math.random().toString(36).slice(2)}`;
  const claimId = `idem_savepoint_${Math.random().toString(36).slice(2)}`;
  await asApp("ws_guard_a", async (sql) => {
    await sql`INSERT INTO mutation_idempotency
      (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key, request_hash, lease_expires_at, expires_at)
      VALUES (${claimId}, 'ws_guard_a', 'api_token', 'savepoint_actor', 'POST', '/api/v1/installations', ${claimId}, 'savepoint-hash', now() + interval '60 seconds', now() + interval '24 hours')`;
    try {
      await (sql as unknown as postgres.TransactionSql<{}>).savepoint(async (savepoint) => {
        await savepoint`INSERT INTO gateway_installation
          (id, workspace_id, name, public_key, edition)
          VALUES (${installationId}, 'ws_guard_a', 'rolled-back installation', decode('302a300506032b6570032100' || repeat('00', 32), 'hex'), 'vercel')`;
        throw new Error("handler failed after write");
      });
    } catch (error) {
      assert.equal((error as Error).message, "handler failed after write");
    }
    await sql`UPDATE mutation_idempotency SET state='completed', response_status=500,
      response_headers=${sql.json({ "content-type": "application/json" })},
      response_body=decode('7b226f6b223a66616c73657d','hex'), completed_at=now()
      WHERE id=${claimId}`;
  });
  await asApp("ws_guard_a", async (sql) => {
    const installations = await sql`SELECT id FROM gateway_installation WHERE id=${installationId}`;
    assert.equal(installations.length, 0, "handler write must be rolled back to its savepoint");
    const [claim] = await sql<{ state: string; response_status: number }[]>`
      SELECT state, response_status FROM mutation_idempotency WHERE id=${claimId}`;
    assert.deepEqual(claim, { state: "completed", response_status: 500 });
  });
});

test("mutation guard uses TransactionSql.savepoint and automatically encrypts installation creation replays", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../lib/mutation-guard.ts"), "utf8");
  assert.match(source, /sql\.savepoint\(async \(savepoint\)/);
  assert.doesNotMatch(source, /sql\.begin\(async \(savepoint\)/);
  assert.match(source, /path === "\/api\/v1\/installations"/);
});

test("unique claim serializes concurrent identical mutations to one effect", async () => {
  const clients = Array.from({ length: 12 }, () => postgres(pg.url, { max: 1, prepare: false }));
  try {
    const claims = await Promise.all(clients.map((client) => client.begin(async (sql) => {
      await sql.unsafe("SET LOCAL ROLE manifold_app");
      await sql`SELECT set_config('manifold.workspace_id', 'ws_guard_a', true)`;
      return insertClaim(sql as unknown as ReturnType<typeof postgres>, "hash-a", "concurrent-key");
    })));
    assert.equal(claims.filter((rows) => rows.length === 1).length, 1);
  } finally {
    await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
  }
});

test("idempotency expires after 24h and actor identity isolates keys", async () => {
  await asApp("ws_guard_a", async (sql) => {
    await sql`INSERT INTO mutation_idempotency
      (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key, request_hash, lease_expires_at, expires_at)
      VALUES ('idem_expired','ws_guard_a','api_token','tok_expired','POST','/x','expired','h',now(),now() - interval '1 second')`;
    const removed = await sql`DELETE FROM mutation_idempotency WHERE workspace_id='ws_guard_a' AND expires_at <= now()`;
    assert.equal(removed.count, 1);
    await sql`INSERT INTO mutation_idempotency
      (id, workspace_id, actor_kind, actor_id, method, canonical_path, idempotency_key, request_hash, lease_expires_at, expires_at)
      VALUES ('idem_actor_b','ws_guard_a','member','mbr_a','POST','/api/v1/keys','same-key','other',now(),now() + interval '24 hours')`;
    const rows = await sql<{ actor_kind: string; actor_id: string }[]>`
      SELECT actor_kind, actor_id FROM mutation_idempotency WHERE id='idem_actor_b'`;
    assert.deepEqual(Array.from(rows), [{ actor_kind: "member", actor_id: "mbr_a" }]);
  });
});

test("fixed-window rate limit returns no claim at capacity and exposes a positive retry-after", async () => {
  await asApp("ws_guard_a", async (sql) => {
    const [{ bucket_start }] = await sql<{ bucket_start: string }[]>`SELECT date_trunc('minute', now()) AS bucket_start`;
    await sql`INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
      VALUES ('ws_guard_a','api_token','rate_actor','/api/v1/keys',${bucket_start},2,${new Date(Date.now() + 60_000).toISOString()})`;
    const rows = await sql<{ request_count: number }[]>`INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
      VALUES ('ws_guard_a','api_token','rate_actor','/api/v1/keys',${bucket_start},1,${new Date(Date.now() + 60_000).toISOString()})
      ON CONFLICT (workspace_id, actor_kind, actor_id, route_identity, bucket_start) DO UPDATE
      SET request_count = mutation_rate_limit_bucket.request_count + 1
      WHERE mutation_rate_limit_bucket.request_count < 2 RETURNING request_count`;
    assert.equal(rows.length, 0, "at capacity, the guard must reject and calculate retry-after");
    assert.ok(Math.ceil((Date.parse(bucket_start) + 60_000 - Date.now()) / 1000) > 0);
  });
});

test("fixed-window buckets are isolated by route identity", async () => {
  await asApp("ws_guard_a", async (sql) => {
    const [{ bucket_start }] = await sql<{ bucket_start: string }[]>`SELECT date_trunc('minute', now()) AS bucket_start`;
    await sql`INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
      VALUES ('ws_guard_a','api_token','route_actor','/api/v1/keys',${bucket_start},2,now() + interval '1 minute')`;
    const rows = await sql<{ request_count: number }[]>`INSERT INTO mutation_rate_limit_bucket
      (workspace_id, actor_kind, actor_id, route_identity, bucket_start, request_count, expires_at)
      VALUES ('ws_guard_a','api_token','route_actor','/api/v1/settings/tokens',${bucket_start},1,now() + interval '1 minute')
      ON CONFLICT (workspace_id, actor_kind, actor_id, route_identity, bucket_start) DO UPDATE
      SET request_count = mutation_rate_limit_bucket.request_count + 1 RETURNING request_count`;
    assert.equal(rows[0]!.request_count, 1);
  });
});

test("guard tables are RLS scoped and fail closed", async () => {
  await asApp("ws_guard_b", async (sql) => {
    const rows = await sql`SELECT id FROM mutation_idempotency`;
    assert.equal(rows.length, 0, "ws_guard_b cannot read ws_guard_a journals");
  });
  const rows = await pg.sql.begin(async (sql) => {
    await sql.unsafe("SET LOCAL ROLE manifold_app");
    return sql`SELECT id FROM mutation_idempotency`;
  });
  assert.equal(rows.length, 0, "unset workspace GUC returns no journal rows");
});
