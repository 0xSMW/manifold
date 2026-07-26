import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { authenticateInstallation } from "../lib/installation-auth.ts";

let pg: PgHarness;
before(async () => {
  pg = await startPg({ namePrefix: "mf-installation-auth", poolSize: 8 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_install_a','install-a','Install A','local'), ('ws_install_b','install-b','Install B','local');
    INSERT INTO gateway_installation (id, workspace_id, name, public_key) VALUES
      ('inst_install_a','ws_install_a','Install A', decode('302a300506032b6570032100' || repeat('00', 32), 'hex')),
      ('inst_install_b','ws_install_b','Install B', decode('302a300506032b6570032100' || repeat('01', 32), 'hex'));
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_workload_a','ws_install_a','Workload A', '{"issuer":"https://issuer.example.com","jwksUrl":"https://issuer.example.com/keys","audience":"manifold-gateway","subject":"system:serviceaccount:gateway:prod"}'::jsonb);
  `);
}, { timeout: 180_000 });
after(async () => { await pg?.stop(); });

async function asApp<T>(workspaceId: string | null, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    if (workspaceId) await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

test("pre-workspace lookup is exact while direct installation reads remain RLS blocked", async () => {
  await asApp(null, async (sql) => {
    const direct = await sql`SELECT id FROM gateway_installation`;
    assert.equal(direct.length, 0);
    const rows = await sql<{ id: string; workspace_id: string; public_key: Buffer }[]>`SELECT * FROM auth_lookup_installation('inst_install_a')`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "inst_install_a");
    assert.equal(rows[0]?.workspace_id, "ws_install_a");
    assert.equal(rows[0]?.public_key.length, 44);
    assert.equal((await sql`SELECT * FROM auth_lookup_installation('missing')`).length, 0);
  });
});

test("workload identity is stored only on its installation and remains invisible cross-workspace", async () => {
  await asApp(null, async (sql) => {
    const rows = await sql<{ id: string; workspace_id: string; workload_identity: { issuer: string; jwksUrl: string; audience: string; subject: string } }[]>`SELECT * FROM auth_lookup_installation('inst_workload_a')`;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.workload_identity, {
      issuer: "https://issuer.example.com",
      jwksUrl: "https://issuer.example.com/keys",
      audience: "manifold-gateway",
      subject: "system:serviceaccount:gateway:prod",
    });
  });
  await asApp("ws_install_b", async (sql) => {
    assert.equal((await sql`SELECT id FROM gateway_installation WHERE id = 'inst_workload_a'`).length, 0);
  });
});

test("workload JWT replay is installation-scoped and token claims cannot select another workspace", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "test-rsa", alg: "RS256", use: "sig", key_ops: ["verify"] };
  const identity = { issuer: "https://issuer.example.com", jwksUrl: "https://issuer.example.com/keys?replay", audience: "manifold-gateway", subject: "system:serviceaccount:gateway:prod" };
  await pg.sql`UPDATE gateway_installation SET workload_identity = ${pg.sql.json(identity)}, public_key = NULL WHERE id = 'inst_workload_a'`;
  // The nonce row's created_at is database wall time, so keep the JWT clock aligned with the
  // running database. A fixed historical timestamp eventually makes expires_at precede
  // created_at and tests the table check instead of replay isolation.
  const now = new Date();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-rsa" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: identity.issuer, aud: identity.audience, sub: identity.subject, exp: Math.floor(now.getTime() / 1000) + 300, jti: "a-workload-replay-jti-with-entropy", workspace_id: "ws_install_b" })).toString("base64url");
  const input = `${header}.${claims}`;
  const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
  process.env.DATABASE_URL = pg.url;
  const request = () => new Request("https://control.example.com/api/v1/config/active?installationId=inst_workload_a", { headers: { authorization: `Bearer ${jwt}`, "x-manifold-installation-id": "inst_workload_a" } });
  const options = { path: "/api/v1/config/active", installationId: "inst_workload_a", now, workloadJwksFetcher: async () => ({ keys: [jwk] }) };
  assert.deepEqual(await authenticateInstallation(request(), options), { installationId: "inst_workload_a", workspaceId: "ws_install_a" });
  await assert.rejects(authenticateInstallation(request(), options), (error: unknown) => Array.isArray((error as { reasonCodes?: unknown }).reasonCodes) && (error as { reasonCodes: string[] }).reasonCodes.includes("AUTH_INSTALLATION_REPLAY"));
});

test("nonce claim is atomic, durable, and not cross-tenant readable", async () => {
  await asApp(null, async (sql) => {
    const first = await sql<{ claimed: boolean }[]>`SELECT auth_claim_installation_nonce('inst_install_a', decode('aa', 'hex'), now() + interval '10 minutes') AS claimed`;
    const replay = await sql<{ claimed: boolean }[]>`SELECT auth_claim_installation_nonce('inst_install_a', decode('aa', 'hex'), now() + interval '10 minutes') AS claimed`;
    assert.equal(first[0]?.claimed, true);
    assert.equal(replay[0]?.claimed, false);
  });
  await asApp("ws_install_b", async (sql) => {
    assert.equal((await sql`SELECT installation_id FROM installation_auth_nonce`).length, 0);
  });
});
