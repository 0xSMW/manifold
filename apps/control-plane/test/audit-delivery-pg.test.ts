// Durable audit-delivery queue invariants. Run with Node's TS stripper; this starts a throwaway
// Postgres and applies the real numbered migrations, including 0015.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;
type Sql = ReturnType<typeof postgres>;

async function asApp<T>(workspaceId: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

before(async () => {
  pg = await startPg({ namePrefix: "mf-audit-delivery", poolSize: 8 });
  pg.psql(`INSERT INTO workspace (id, slug, name, region) VALUES
    ('ws_delivery_a','delivery-a','Delivery A','local'), ('ws_delivery_b','delivery-b','Delivery B','local');
    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
    ('dek_delivery_a','ws_delivery_a',decode(repeat('11',32),'hex'),'test','active'),
    ('dek_delivery_b','ws_delivery_b',decode(repeat('22',32),'hex'),'test','active');
    INSERT INTO audit_destination (id, workspace_id, kind, label, encrypted_endpoint, encrypted_secret, dek_id) VALUES
    ('dst_delivery_a','ws_delivery_a','webhook','A',decode('01','hex'),decode('02','hex'),'dek_delivery_a'),
    ('dst_delivery_b','ws_delivery_b','siem','B',decode('03','hex'),decode('04','hex'),'dek_delivery_b');`);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

async function event(workspaceId: string, id: string) {
  await asApp(workspaceId, (sql) => sql`INSERT INTO audit_event (id, workspace_id, actor_kind, action, created_at)
    VALUES (${id}, ${workspaceId}, 'system', 'delivery.test', now())`);
}

test("audit event enqueue is durable, destination-scoped, and tenant-isolated", async () => {
  await event("ws_delivery_a", "aud_delivery_enqueue");
  await asApp("ws_delivery_a", async (sql) => {
    const rows = await sql<{ destination_id: string; audit_event_id: string; status: string }[]>`SELECT destination_id, audit_event_id, status FROM audit_delivery_job WHERE audit_event_id='aud_delivery_enqueue'`;
    assert.deepEqual(Array.from(rows), [{ destination_id: "dst_delivery_a", audit_event_id: "aud_delivery_enqueue", status: "pending" }]);
  });
  await asApp("ws_delivery_b", async (sql) => assert.equal((await sql`SELECT id FROM audit_delivery_job`).length, 0));
});

test("claim, success checkpoint, retry backoff, and terminal failure retain attempts", async () => {
  await event("ws_delivery_a", "aud_delivery_outcomes");
  await asApp("ws_delivery_a", async (sql) => {
    const [job] = await sql<{ id: string }[]>`SELECT id FROM audit_delivery_job WHERE audit_event_id='aud_delivery_outcomes'`;
    const [claimed] = await sql<{ attempt_count: number; status: string }[]>`UPDATE audit_delivery_job SET status='processing', attempt_count=attempt_count+1, lease_until=now()+interval '60 seconds', last_attempt_at=now() WHERE id=${job!.id} AND status='pending' RETURNING attempt_count,status`;
    assert.deepEqual(claimed, { attempt_count: 1, status: "processing" });
    await sql`INSERT INTO audit_delivery_attempt (id,workspace_id,job_id,attempt_number,outcome,status_code) VALUES ('ada_success','ws_delivery_a',${job!.id},1,'delivered',202)`;
    await sql`UPDATE audit_delivery_job SET status='delivered', delivered_at=now(), lease_until=NULL WHERE id=${job!.id}`;
    const [done] = await sql<{ status: string; delivered_at: string | null }[]>`SELECT status, delivered_at FROM audit_delivery_job WHERE id=${job!.id}`;
    assert.equal(done!.status, "delivered"); assert.ok(done!.delivered_at);

    await event("ws_delivery_a", "aud_delivery_retry");
    const [retry] = await sql<{ id: string }[]>`SELECT id FROM audit_delivery_job WHERE audit_event_id='aud_delivery_retry'`;
    await sql`UPDATE audit_delivery_job SET status='processing',attempt_count=1,lease_until=now()+interval '60 seconds' WHERE id=${retry!.id}`;
    await sql`INSERT INTO audit_delivery_attempt (id,workspace_id,job_id,attempt_number,outcome,error_code) VALUES ('ada_retry','ws_delivery_a',${retry!.id},1,'retry','EGRESS_TIMEOUT')`;
    await sql`UPDATE audit_delivery_job SET status='pending',lease_until=NULL,last_error_code='EGRESS_TIMEOUT',run_after=now()+interval '5 seconds' WHERE id=${retry!.id}`;
    const [pending] = await sql<{ status: string; last_error_code: string; due: boolean }[]>`SELECT status,last_error_code,run_after > now() AS due FROM audit_delivery_job WHERE id=${retry!.id}`;
    assert.deepEqual(pending, { status: "pending", last_error_code: "EGRESS_TIMEOUT", due: true });
    await sql`UPDATE audit_delivery_job SET status='dead',attempt_count=8,last_error_code='HTTP_400' WHERE id=${retry!.id}`;
    await sql`INSERT INTO audit_delivery_attempt (id,workspace_id,job_id,attempt_number,outcome,status_code,error_code) VALUES ('ada_dead','ws_delivery_a',${retry!.id},8,'dead',400,'HTTP_400')`;
    assert.equal((await sql`SELECT id FROM audit_delivery_attempt WHERE job_id=${retry!.id}`).length, 2, "attempt history is retained");
  });
});

test("expired leases become claimable without crossing tenant boundaries", async () => {
  await event("ws_delivery_a", "aud_delivery_lease");
  await asApp("ws_delivery_a", async (sql) => {
    await sql`UPDATE audit_delivery_job SET status='processing',attempt_count=1,lease_until=now()-interval '1 second' WHERE audit_event_id='aud_delivery_lease'`;
    await sql`UPDATE audit_delivery_job SET status='pending',lease_until=NULL WHERE workspace_id='ws_delivery_a' AND status='processing' AND lease_until < now()`;
    const [row] = await sql<{ status: string; lease_until: string | null }[]>`SELECT status,lease_until FROM audit_delivery_job WHERE audit_event_id='aud_delivery_lease'`;
    assert.deepEqual(row, { status: "pending", lease_until: null });
  });
  const unseen = await pg.sql.begin(async (sql) => { await sql.unsafe("SET LOCAL ROLE manifold_app"); return sql`SELECT id FROM audit_delivery_job`; });
  assert.equal(unseen.length, 0, "unset workspace GUC fails closed");
});

test("bounded scheduler discovery returns only due workspace IDs through its narrow definer seam", async () => {
  await event("ws_delivery_a", "aud_delivery_cron_due");
  await event("ws_delivery_b", "aud_delivery_cron_later");
  await asApp("ws_delivery_b", (sql) => sql`UPDATE audit_delivery_job SET run_after=now()+interval '1 hour' WHERE audit_event_id='aud_delivery_cron_later'`);
  const rows = await pg.sql.begin(async (sql) => { await sql.unsafe("SET LOCAL ROLE manifold_app"); return sql<{ workspace_id: string }[]>`SELECT workspace_id FROM audit_delivery_due_workspaces(1)`; });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.workspace_id, "ws_delivery_a");
});
