import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { deliverInvitation, decryptInvitationToken, encryptInvitationToken } from "../lib/invitation-delivery.ts";
import { invitationDeliveryIdempotencyKey } from "../lib/auth-email.ts";
import { hashAuthToken } from "../lib/auth-secret.ts";
import postgres from "postgres";

const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; } })();
const pgTest = (name: string, fn: () => Promise<void>) => test(name, { skip: docker ? false : "Docker is unavailable" }, fn);
let pg: PgHarness;
before(async () => { if (!docker) return; process.env.MANIFOLD_INVITATION_DELIVERY_KEY = Buffer.alloc(32, 9).toString("base64"); pg = await startPg({ namePrefix: "mf-invite-outbox", poolSize: 8 }); process.env.DATABASE_URL = pg.url; process.env.RESEND_API_KEY = "test"; process.env.RESEND_FROM_EMAIL = "noreply@example.test"; process.env.MANIFOLD_AUTH_ORIGIN = "https://console.example.test"; await pg.sql`INSERT INTO workspace (id,slug,name,region) VALUES ('ws_invite_outbox','invite-outbox','Invite outbox','local')`; }, { timeout: 180_000 });
after(async () => { await pg?.stop(); });

async function asApp<T>(workspaceId: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

async function seed(id: string, token: string) {
  const encrypted = encryptInvitationToken(token);
  await pg.sql`INSERT INTO member (id,workspace_id,email,role,invited_at,accepted_at) VALUES (${`mem_${id}`},'ws_invite_outbox',${`${id}@example.test`},'viewer',now(),NULL)`;
  await pg.sql`INSERT INTO workspace_invitation (id,workspace_id,member_id,email,role,keyed_hash,expires_at) VALUES (${id},'ws_invite_outbox',${`mem_${id}`},${`${id}@example.test`},'viewer',digest(${id},'sha256'),now()+interval '1 hour')`;
  await pg.sql`INSERT INTO workspace_invitation_delivery (invitation_id,workspace_id,state,token_digest,token_ciphertext,token_iv,token_tag) VALUES (${id},'ws_invite_outbox','pending',${hashAuthToken(token)},${encrypted.tokenCiphertext},${encrypted.tokenIv},${encrypted.tokenTag})`;
}

async function dispatch(id: string, provider: (key: string) => Promise<void>, crashAfterProvider = false) {
  const row = (await pg.sql<{ state: "pending" | "sent" | "failed"; generation: string; token_digest: Buffer; token_ciphertext: Buffer; token_iv: Buffer; token_tag: Buffer }[]>`SELECT state,generation,token_digest,token_ciphertext,token_iv,token_tag FROM workspace_invitation_delivery WHERE invitation_id=${id} FOR UPDATE`)[0]!;
  if (row.state === "failed") return "failed";
  if (row.state === "sent") return "sent";
  const token = decryptInvitationToken({ tokenCiphertext: row.token_ciphertext, tokenIv: row.token_iv, tokenTag: row.token_tag });
  try { await provider(invitationDeliveryIdempotencyKey(id, token)); } catch { await pg.sql`UPDATE workspace_invitation_delivery SET state='failed',failed_at=now() WHERE invitation_id=${id} AND generation=${row.generation} AND token_digest=${row.token_digest}`; return "failed"; }
  if (crashAfterProvider) return "crashed";
  await pg.sql`UPDATE workspace_invitation_delivery SET state='sent',sent_at=now(),failed_at=NULL WHERE invitation_id=${id} AND generation=${row.generation} AND token_digest=${row.token_digest}`;
  return "sent";
}

pgTest("outbox survives commit-before-dispatch and reclaims the same capability once", async () => {
  await seed("inv_crash_before", "token-before");
  const keys: string[] = [];
  assert.equal((await pg.sql`SELECT state FROM workspace_invitation_delivery WHERE invitation_id='inv_crash_before'`)[0]?.state, "pending");
  assert.equal(await dispatch("inv_crash_before", async (key) => { keys.push(key); }), "sent");
  assert.equal(keys.length, 1); assert.equal((await pg.sql`SELECT state FROM workspace_invitation_delivery WHERE invitation_id='inv_crash_before'`)[0]?.state, "sent");
});

pgTest("provider-accepted crash reuses its identical provider idempotency key before settling", async () => {
  await seed("inv_crash_after", "token-after");
  const keys: string[] = [];
  assert.equal(await dispatch("inv_crash_after", async (key) => { keys.push(key); }, true), "crashed");
  assert.equal(await dispatch("inv_crash_after", async (key) => { keys.push(key); }), "sent");
  assert.deepEqual(keys, [keys[0], keys[0]]); assert.equal((await pg.sql`SELECT state FROM workspace_invitation_delivery WHERE invitation_id='inv_crash_after'`)[0]?.state, "sent");
});

pgTest("provider failure is durable, truthful on replay, and stores no plaintext capability", async () => {
  const token = "token-provider-failure"; await seed("inv_provider_failed", token);
  assert.equal(await dispatch("inv_provider_failed", async () => { throw new Error("provider unavailable"); }), "failed");
  assert.equal(await dispatch("inv_provider_failed", async () => { throw new Error("must not be retried by same key"); }), "failed");
  const [row] = await pg.sql<{ state: string; token_ciphertext: Buffer }[]>`SELECT state,token_ciphertext FROM workspace_invitation_delivery WHERE invitation_id='inv_provider_failed'`;
  assert.equal(row!.state, "failed"); assert.equal(row!.token_ciphertext.includes(Buffer.from(token)), false);
});

pgTest("outbox RLS uses the canonical manifold workspace GUC", async () => {
  await seed("inv_rls", "token-rls");
  await asApp("ws_invite_outbox", async (sql) => {
    const rows = await sql`SELECT invitation_id FROM workspace_invitation_delivery WHERE invitation_id='inv_rls'`;
    assert.equal(rows.length, 1);
    await sql`UPDATE workspace_invitation_delivery SET updated_at=now() WHERE invitation_id='inv_rls'`;
  });
  await asApp("ws_other", async (sql) => {
    const rows = await sql`SELECT invitation_id FROM workspace_invitation_delivery WHERE invitation_id='inv_rls'`;
    assert.equal(rows.length, 0);
    const changed = await sql`UPDATE workspace_invitation_delivery SET updated_at=now() WHERE invitation_id='inv_rls' RETURNING invitation_id`;
    assert.equal(changed.length, 0);
  });
});

async function rotate(id: string, token: string) {
  const encrypted = encryptInvitationToken(token);
  await pg.sql`UPDATE workspace_invitation_delivery
    SET generation=generation+1,state='pending',token_digest=${hashAuthToken(token)},token_ciphertext=${encrypted.tokenCiphertext},token_iv=${encrypted.tokenIv},token_tag=${encrypted.tokenTag},sent_at=NULL,failed_at=NULL,updated_at=now()
    WHERE invitation_id=${id}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

pgTest("a stale provider completion or failure cannot settle a rotated invitation generation", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await seed("inv_generation_success", "token-generation-old");
    const providerStarted = deferred<void>();
    const providerResult = deferred<Response>();
    globalThis.fetch = (async () => { providerStarted.resolve(); return providerResult.promise; }) as typeof fetch;
    const oldSuccess = deliverInvitation("ws_invite_outbox", "inv_generation_success");
    await providerStarted.promise;
    await rotate("inv_generation_success", "token-generation-new");
    providerResult.resolve(new Response("{}", { status: 200 }));
    assert.equal(await oldSuccess, "superseded");
    const [afterSuccess] = await pg.sql<{ generation: string; state: string; token_digest: Buffer }[]>`SELECT generation,state,token_digest FROM workspace_invitation_delivery WHERE invitation_id='inv_generation_success'`;
    assert.deepEqual({ generation: afterSuccess!.generation, state: afterSuccess!.state, digest: afterSuccess!.token_digest.toString("hex") }, { generation: "2", state: "pending", digest: hashAuthToken("token-generation-new").toString("hex") });

    await seed("inv_generation_failure", "token-generation-failure-old");
    const failedProviderStarted = deferred<void>();
    const failedProviderResult = deferred<Response>();
    globalThis.fetch = (async () => { failedProviderStarted.resolve(); return failedProviderResult.promise; }) as typeof fetch;
    const oldFailure = deliverInvitation("ws_invite_outbox", "inv_generation_failure");
    await failedProviderStarted.promise;
    await rotate("inv_generation_failure", "token-generation-failure-new");
    failedProviderResult.resolve(new Response("provider unavailable", { status: 503 }));
    assert.equal(await oldFailure, "superseded");
    const [afterFailure] = await pg.sql<{ generation: string; state: string; token_digest: Buffer }[]>`SELECT generation,state,token_digest FROM workspace_invitation_delivery WHERE invitation_id='inv_generation_failure'`;
    assert.deepEqual({ generation: afterFailure!.generation, state: afterFailure!.state, digest: afterFailure!.token_digest.toString("hex") }, { generation: "2", state: "pending", digest: hashAuthToken("token-generation-failure-new").toString("hex") });

    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    assert.equal(await deliverInvitation("ws_invite_outbox", "inv_generation_success"), "sent");
    assert.equal((await pg.sql`SELECT state FROM workspace_invitation_delivery WHERE invitation_id='inv_generation_success'`)[0]?.state, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
