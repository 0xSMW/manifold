// Real-Postgres invariants for the interleaved audit timeline.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type postgres from "postgres";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-audit-timeline" });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_timeline_a', 'timeline-a', 'Timeline A', 'local'),
      ('ws_timeline_b', 'timeline-b', 'Timeline B', 'local');
    INSERT INTO audit_event (id, workspace_id, actor_kind, actor_id, action, target_kind, target_id, detail, created_at) VALUES
      ('aud_z', 'ws_timeline_a', 'member', 'mem_a', 'route.publish', 'route', 'route_a', '{"outcome":"ok"}', '2026-07-25T10:00:00Z'),
      ('aud_a', 'ws_timeline_a', 'member', 'mem_a', 'route.publish', 'route', 'route_a', '{"outcome":"ok"}', '2026-07-25T10:00:00Z'),
      ('aud_other', 'ws_timeline_b', 'member', 'mem_b', 'route.publish', 'route', 'route_b', '{"outcome":"ok"}', '2026-07-25T11:00:00Z');
    INSERT INTO policy_decision (id, workspace_id, request_id, trace_id, outcome, reason_codes, policy_revision_id, created_at) VALUES
      ('pol_z', 'ws_timeline_a', 'req_z', 'trace_z', 'deny', '["POLICY_MODEL_DENIED"]', 'polrev_a', '2026-07-25T10:00:00Z'),
      ('pol_a', 'ws_timeline_a', 'req_a', NULL, 'allow', '[]', 'polrev_a', '2026-07-25T10:00:00Z'),
      ('pol_other', 'ws_timeline_b', 'req_other', 'trace_other', 'deny', '["POLICY_MODEL_DENIED"]', 'polrev_b', '2026-07-25T11:00:00Z');
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

function loadAuditRead(): typeof import("../lib/audit-read/index") {
  const filename = new URL("../lib/audit-read/index.ts", import.meta.url);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename.pathname,
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", "Buffer", output)(
    (specifier: string) => {
      if (specifier === "@/lib/http") return { ManifoldError: class ManifoldError extends Error {} };
      throw new Error(`unexpected audit-read dependency: ${specifier}`);
    }, module, module.exports, Buffer,
  );
  return module.exports as unknown as typeof import("../lib/audit-read/index");
}

const auditRead = loadAuditRead();

async function asApp<T>(workspaceId: string, fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return pg.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE manifold_app");
    await tx`SELECT set_config('manifold.workspace_id', ${workspaceId}, true)`;
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

function query(overrides: Partial<import("../lib/audit-read/index").AuditListQuery> = {}) {
  return {
    limit: 2, cursor: null, actor: null, actorKind: null, action: null, targetKind: null, targetId: null,
    hash: null, beforeHash: null, afterHash: null, outcome: null, from: null, to: null, profileId: null,
    ...overrides,
  };
}

test("interleaves source-tagged rows with stable equal-timestamp cursors and no duplicates", async () => {
  const first = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query()));
  assert.deepEqual(first.map((row) => `${row.kind}:${row.id}`), ["audit_event:aud_z", "audit_event:aud_a", "policy_decision:pol_z"]);
  const cursor = auditRead.encodeAuditCursor({ createdAt: first[1]!.created_at, kind: first[1]!.kind, id: first[1]!.id });
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const second = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query({ cursor: decoded as import("../lib/audit-read/index").AuditCursor })));
  const ids = [...first.slice(0, 2), ...second].map((row) => `${row.kind}:${row.id}`);
  assert.deepEqual(ids, ["audit_event:aud_z", "audit_event:aud_a", "policy_decision:pol_z", "policy_decision:pol_a"]);
  assert.equal(new Set(ids).size, ids.length, "a cursor boundary must not repeat equal-timestamp rows");
});

test("keeps timeline filters truthful per source and tenant", async () => {
  const isolated = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query({ limit: 20 })));
  assert.equal(isolated.some((row) => row.id.endsWith("other")), false, "RLS and explicit workspace predicate isolate tenants");
  const deny = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query({ outcome: "deny" })));
  assert.deepEqual(deny.map((row) => `${row.kind}:${row.id}`), ["policy_decision:pol_z"]);
  const target = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query({ targetKind: "policy_revision", targetId: "polrev_a" })));
  assert.deepEqual(target.map((row) => `${row.kind}:${row.id}`), ["policy_decision:pol_z", "policy_decision:pol_a"]);
  const action = await asApp("ws_timeline_a", (sql) => auditRead.selectAuditTimelineRows(sql as never, "ws_timeline_a", query({ action: "route.publish" })));
  assert.deepEqual(action.map((row) => row.kind), ["audit_event", "audit_event"]);
  const policy = auditRead.serializeAuditTimelineRow(deny[0]!);
  assert.deepEqual(policy, {
    kind: "policy_decision", id: "pol_z", outcome: "deny", reasonCodes: ["POLICY_MODEL_DENIED"],
    target: { kind: "policy_revision", id: "polrev_a" },
    links: { requestId: "req_z", traceId: "trace_z", policyRevisionId: "polrev_a", subject: null, model: null },
    createdAt: new Date("2026-07-25T10:00:00.000Z"),
  });
});
