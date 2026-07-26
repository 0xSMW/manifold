import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startPg, type PgHarness } from "./pg-harness.ts";

const dockerAvailable = (() => {
  try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const pgTest = (name: string, fn: () => Promise<void>) => test(name, { skip: dockerAvailable ? false : "Docker is unavailable; real-Postgres coverage skipped" }, fn);

let pg: PgHarness;
before(async () => {
  if (!dockerAvailable) return;
  pg = await startPg({ namePrefix: "mf-human-auth", poolSize: 12 });
  pg.psql(`INSERT INTO workspace (id,slug,name,region) VALUES ('ws_auth','auth','Auth','local');
    INSERT INTO member (id,workspace_id,email,role) VALUES ('mem_owner','ws_auth','owner@example.test','owner');`);
}, { timeout: 180_000 });
after(async () => { await pg?.stop(); });

async function asApp<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}
const hash = (hex: string) => `decode('${hex}', 'hex')`;
const argon = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";

function auditHash(payload: Record<string, unknown>): Buffer {
  const stable = (value: unknown): string => {
    if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(stable(payload)).digest();
}

pgTest("0032 is registered fresh, hides global auth tables, and exposes only definer seams", async () => {
  const tables = await pg.sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('auth_user','password_credential','auth_email_token','auth_rate_limit_bucket') ORDER BY table_name`;
  assert.deepEqual(tables.map((row) => row.table_name), ["auth_email_token", "auth_rate_limit_bucket", "auth_user", "password_credential"]);
  await assert.rejects(() => asApp((sql) => sql.unsafe("SELECT * FROM auth_user")), /permission denied/i);
  await assert.rejects(() => asApp((sql) => sql.unsafe("SELECT * FROM auth_email_token")), /permission denied/i);
  await assert.rejects(() => asApp((sql) => sql.unsafe("SELECT auth_append_human_audit('ws_auth','system','x','forged','x','x')")), /permission denied/i);
  await asApp(async (sql) => assert.equal((await sql`SELECT * FROM auth_initial_activation_status()`).length, 1));
});

pgTest("initial activation is exact-owner, single-use, and creates the accepted identity", async () => {
  await assert.rejects(() => asApp((sql) => sql.unsafe(`SELECT * FROM auth_prepare_initial_activation('wrong@example.test','usr_owner','tok_activation',${hash("01")},now()+interval '1 hour')`)), /not the enabled owner/);
  await asApp(async (sql) => {
    const prepared = await sql.unsafe<{ member_id: string }[]>(`SELECT * FROM auth_prepare_initial_activation('owner@example.test','usr_owner','tok_activation',${hash("01")},now()+interval '1 hour')`);
    assert.equal(prepared[0]?.member_id, "mem_owner");
    const activated = await sql.unsafe<{ user_id: string; session_version: number }[]>(`SELECT * FROM auth_complete_activation(${hash("01")},' Owner ','${argon}')`);
    assert.deepEqual(activated.map((row) => row.user_id), ["usr_owner"]);
    assert.equal(activated[0]?.session_version, 1);
    assert.equal((await sql.unsafe(`SELECT * FROM auth_complete_activation(${hash("01")},'Owner','${argon}')`)).length, 0);
  });
  const state = await pg.sql<{ verified: boolean; accepted: boolean }[]>`SELECT u.email_verified_at IS NOT NULL AS verified, m.accepted_at IS NOT NULL AS accepted FROM auth_user u JOIN member m ON m.user_id=u.id WHERE u.id='usr_owner'`;
  assert.deepEqual([...state], [{ verified: true, accepted: true }]);
});

pgTest("password reset is atomic one-use and revokes sessions through session_version", async () => {
  await pg.sql`INSERT INTO auth_user (id,email,email_verified_at) VALUES ('usr_owner','owner@example.test',now()) ON CONFLICT (id) DO NOTHING`;
  await pg.sql`INSERT INTO password_credential (user_id,password_hash) VALUES ('usr_owner',${argon}) ON CONFLICT (user_id) DO NOTHING`;
  await pg.sql`UPDATE member SET user_id='usr_owner', accepted_at=now() WHERE id='mem_owner'`;
  await pg.sql`INSERT INTO console_session (id,workspace_id,member_id,keyed_hash,scopes,expires_at,user_id,csrf_hash,session_version) VALUES ('ses_reset','ws_auth','mem_owner',decode('10','hex'),'{}',now()+interval '1 hour','usr_owner',decode('11','hex'),1)`;
  await asApp(async (sql) => {
    const issued = await sql.unsafe<{ email: string }[]>(`SELECT * FROM auth_issue_password_reset('owner@example.test','tok_reset',${hash("02")},now()+interval '1 hour')`);
    assert.equal(issued[0]?.email, "owner@example.test");
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => asApp(async (sql) => {
    const rows = await sql.unsafe<{ auth_complete_password_reset: boolean }[]>(`SELECT auth_complete_password_reset(${hash("02")},'${argon}')`);
    return rows[0]?.auth_complete_password_reset;
  })));
  assert.equal(results.filter(Boolean).length, 1);
  const state = await pg.sql<{ session_version: number; revoked: boolean }[]>`SELECT u.session_version, s.revoked_at IS NOT NULL AS revoked FROM auth_user u JOIN console_session s ON s.user_id=u.id WHERE u.id='usr_owner'`;
  assert.equal(state.length, 1); assert.equal(state[0]?.session_version, 2); assert.equal(state[0]?.revoked, true);
});

pgTest("invitation acceptance is one-use under concurrency and binds the membership", async () => {
  await pg.sql`INSERT INTO member (id,workspace_id,email,role,invited_at,accepted_at) VALUES ('mem_invited','ws_auth','invitee@example.test','editor',now(),NULL)`;
  await pg.sql`INSERT INTO workspace_invitation (id,workspace_id,member_id,email,role,keyed_hash,expires_at) VALUES ('inv_1','ws_auth','mem_invited','invitee@example.test','editor',decode('03','hex'),now()+interval '1 hour')`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => asApp(async (sql) => await sql.unsafe<{ user_id: string }[]>(`SELECT * FROM auth_accept_workspace_invitation(${hash("03")},'usr_invited_${i}','Invitee','${argon}')`))));
  assert.equal(results.filter((rows) => rows.length === 1).length, 1);
  const state = await pg.sql<{ accepted: boolean; user_id: string }[]>`SELECT accepted_at IS NOT NULL AS accepted, user_id FROM member WHERE id='mem_invited'`;
  assert.equal(state[0]?.accepted, true); assert.ok(state[0]?.user_id?.startsWith("usr_invited_"));
});

pgTest("token and console lookups carry human status, CSRF, and version fields", async () => {
  await pg.sql`INSERT INTO service_account (id,workspace_id,name,disabled_at) VALUES ('svc_disabled','ws_auth','Disabled',now())`;
  await pg.sql`INSERT INTO api_token (id,workspace_id,display_prefix,keyed_hash,scopes,created_by,kind,user_id) VALUES ('tok_personal','ws_auth','p',decode('04','hex'),'{}','mem_owner','personal','usr_owner')`;
  await pg.sql`INSERT INTO api_token (id,workspace_id,display_prefix,keyed_hash,scopes,created_by,kind,service_account_id) VALUES ('tok_service','ws_auth','s',decode('05','hex'),'{}','mem_owner','service','svc_disabled')`;
  await pg.sql`INSERT INTO api_token (id,workspace_id,display_prefix,keyed_hash,scopes,created_by) VALUES ('tok_legacy','ws_auth','l',decode('06','hex'),'{}','mem_owner')`;
  await asApp(async (sql) => {
    const personal = await sql.unsafe<{ token_kind: string; token_user_id: string; member_disabled_at: Date | null }[]>(`SELECT * FROM auth_lookup_token(${hash("04")})`);
    assert.equal(personal[0]?.token_kind, "personal"); assert.equal(personal[0]?.token_user_id, "usr_owner"); assert.equal(personal[0]?.member_disabled_at, null);
    const service = await sql.unsafe<{ token_kind: string; service_account_disabled_at: Date | null }[]>(`SELECT * FROM auth_lookup_token(${hash("05")})`);
    assert.equal(service[0]?.token_kind, "service"); assert.ok(service[0]?.service_account_disabled_at);
    assert.equal((await sql.unsafe<{ token_kind: string }[]>(`SELECT * FROM auth_lookup_token(${hash("06")})`))[0]?.token_kind, "legacy");
    const session = await sql.unsafe<{ user_session_version: number; session_version: number; csrf_hash: Buffer; member_accepted_at: Date }[]>(`SELECT * FROM auth_lookup_console_session(${hash("10")})`);
    assert.equal(session[0]?.user_session_version, 2); assert.equal(session[0]?.session_version, 1); assert.deepEqual(session[0]?.csrf_hash, Buffer.from("11", "hex")); assert.ok(session[0]?.member_accepted_at);
    await pg.sql`UPDATE member SET role='editor' WHERE id='mem_owner'`;
    const demoted = await sql.unsafe<{ member_role: string; member_accepted_at: Date | null }[]>(`SELECT * FROM auth_lookup_token(${hash("04")})`);
    assert.equal(demoted[0]?.member_role, "editor"); assert.ok(demoted[0]?.member_accepted_at);
  });
});

pgTest("rate-limit charging has an atomic ceiling", async () => {
  const values = await Promise.all(Array.from({ length: 20 }, () => asApp(async (sql) => {
    const rows = await sql.unsafe<{ auth_charge_rate_limit: number | null }[]>(`SELECT auth_charge_rate_limit('login',decode('aa','hex'),date_trunc('hour',now()),date_trunc('hour',now())+interval '1 hour',3)`);
    return rows[0]?.auth_charge_rate_limit;
  })));
  assert.deepEqual(values.filter((value): value is number => value !== null).sort((a, b) => a - b), [1, 2, 3]);
});

pgTest("human lifecycle mutations append sealed non-secret audit events", async () => {
  const rows = await pg.sql<{ id: string; workspace_id: string; actor_kind: string; actor_id: string | null; action: string; target_kind: string; target_id: string; detail: unknown; created_at: string; chain_sequence: string; prev_chain_hash: Buffer | null; chain_hash: Buffer }[]>`
    SELECT id, workspace_id, actor_kind, actor_id, action, target_kind, target_id, detail, created_at,
      chain_sequence::text AS chain_sequence, prev_chain_hash, chain_hash
    FROM audit_event WHERE workspace_id='ws_auth' AND chain_version=1
    ORDER BY chain_sequence`;
  assert.deepEqual(rows.filter((row) => ["auth.activation.complete", "auth.password_reset.complete", "workspace_invitation.accept"].includes(row.action)).map((row) => row.action), ["auth.activation.complete", "auth.password_reset.complete", "workspace_invitation.accept"]);
  let previous: Buffer | null = null;
  for (const row of rows) {
    if (["auth.activation.complete", "auth.password_reset.complete", "workspace_invitation.accept"].includes(row.action)) assert.equal(row.detail, null);
    assert.deepEqual(row.prev_chain_hash, previous);
    const expected = auditHash({
      id: row.id, workspaceId: row.workspace_id, actorKind: row.actor_kind, actorId: row.actor_id,
      action: row.action, targetKind: row.target_kind, targetId: row.target_id,
      beforeHash: null, afterHash: null, requestRef: null, detail: null,
      createdAt: new Date(row.created_at).toISOString(), chainSequence: row.chain_sequence,
      prevChainHash: previous?.toString("hex") ?? null,
    });
    assert.deepEqual(row.chain_hash, expected);
    previous = row.chain_hash;
  }
});
