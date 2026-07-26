// Real-Postgres audit-chain invariants. Run with Node's TypeScript stripper.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import type postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-audit-chain", poolSize: 32 });
  pg.psql(`INSERT INTO workspace (id, slug, name, region) VALUES
    ('ws_audit_a', 'audit-a', 'Audit A', 'local'),
    ('ws_audit_b', 'audit-b', 'Audit B', 'local');`);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

function loadAudit(): { audit: (sql: ReturnType<typeof postgres>, principal: unknown, draft: unknown) => Promise<void>; hashAuditChainPayload: (payload: unknown) => Buffer } {
  const filename = new URL("../lib/audit.ts", import.meta.url);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename.pathname,
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  let id = 0;
  new Function("require", "module", "exports", "Buffer", output)(
    (specifier: string) => {
      if (specifier === "@/lib/ids") return { genId: () => `aud_pg_${++id}` };
      if (specifier === "node:crypto") return { createHash };
      throw new Error(`unexpected audit dependency: ${specifier}`);
    }, module, module.exports, Buffer,
  );
  return module.exports as unknown as ReturnType<typeof loadAudit>;
}

const auditModule = loadAudit();
const principal = { workspaceId: "ws_audit_a", actorKind: "member", actorId: "mem_a" };

async function asApp<T>(workspaceId: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

async function verify(workspaceId: string) {
  return asApp(workspaceId, async (sql) => {
    const rows = await sql<any[]>`SELECT id, workspace_id, actor_kind, actor_id, action, target_kind, target_id,
      before_hash, after_hash, request_ref, detail, created_at,
      chain_sequence::text AS chain_sequence_text, prev_chain_hash, chain_hash
      FROM audit_event WHERE workspace_id=${workspaceId} AND chain_version=1 ORDER BY chain_sequence ASC`;
    let previous: Buffer | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (BigInt(row.chain_sequence_text) !== BigInt(index + 1)) return { verified: false, reason: "sequence_gap", id: row.id };
      const storedPrevious = row.prev_chain_hash ? Buffer.from(row.prev_chain_hash).toString("hex") : null;
      if (storedPrevious !== (previous?.toString("hex") ?? null)) return { verified: false, reason: "predecessor_mismatch", id: row.id };
      const expected = auditModule.hashAuditChainPayload({
        id: row.id, workspaceId: row.workspace_id, actorKind: row.actor_kind, actorId: row.actor_id,
        action: row.action, targetKind: row.target_kind, targetId: row.target_id,
        beforeHash: row.before_hash, afterHash: row.after_hash, requestRef: row.request_ref,
        detail: row.detail, createdAt: new Date(row.created_at).toISOString(),
        chainSequence: row.chain_sequence_text, prevChainHash: storedPrevious,
      });
      if (!expected.equals(Buffer.from(row.chain_hash))) return { verified: false, reason: "hash_mismatch", id: row.id };
      previous = Buffer.from(row.chain_hash);
    }
    return { verified: true, checked: rows.length };
  });
}

test("concurrent audit appends form one contiguous, verifiable workspace chain", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => asApp("ws_audit_a", (sql) => auditModule.audit(sql, principal, {
    action: "test.concurrent", targetKind: "test", targetId: String(i), detail: { index: i, nested: { stable: true } },
  }))));
  const rows = await asApp("ws_audit_a", (sql) => sql<{ chain_sequence_text: string; prev_chain_hash: Buffer | null; chain_hash: Buffer }[]>`
    SELECT chain_sequence::text AS chain_sequence_text, prev_chain_hash, chain_hash FROM audit_event
    WHERE workspace_id='ws_audit_a' AND chain_version=1 ORDER BY chain_sequence`);
  assert.deepEqual(rows.map((row) => row.chain_sequence_text), Array.from({ length: 20 }, (_, i) => String(i + 1)));
  assert.equal(rows[0]?.prev_chain_hash, null);
  for (let i = 1; i < rows.length; i += 1) assert.deepEqual(rows[i]?.prev_chain_hash, rows[i - 1]?.chain_hash);
  assert.deepEqual(await verify("ws_audit_a"), { verified: true, checked: 20 });
});

test("verification fails closed on chain hash tampering and sequence gaps", async () => {
  const second = await asApp("ws_audit_a", (sql) => sql<{ id: string }[]>`
    SELECT id FROM audit_event WHERE workspace_id='ws_audit_a' AND chain_sequence=2`);
  await pg.sql`ALTER TABLE audit_event DISABLE TRIGGER audit_event_immutable`;
  try {
    await pg.sql`UPDATE audit_event SET action='tampered' WHERE id=${second[0]!.id}`;
    assert.deepEqual(await verify("ws_audit_a"), { verified: false, reason: "hash_mismatch", id: second[0]!.id });
    await pg.sql`UPDATE audit_event SET action='test.concurrent' WHERE id=${second[0]!.id}`;
    await pg.sql`UPDATE audit_event SET chain_sequence=99 WHERE id=${second[0]!.id}`;
    const gap = await verify("ws_audit_a");
    assert.equal(gap.verified, false);
    assert.equal(gap.reason, "sequence_gap");
  } finally {
    await pg.sql`ALTER TABLE audit_event ENABLE TRIGGER audit_event_immutable`;
  }
});
