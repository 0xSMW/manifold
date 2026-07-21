// RLS-under-the-real-role regression coverage for the "live-money-wiring" review (SPEC §6.16,
// §8.3/§8.4, §16.3, ADR-0012). Three bugs, all masked by connecting as the SUPERUSER `postgres` role
// (BYPASSRLS) the way budget-e2e-pg.test.ts / observe-e2e-pg.test.ts do:
//
//   #1 buildContext (server.ts) wired ONLY JsonlIngestSink — ingestTrace (map->reduce->project->
//      budget.commit) was NEVER driven on the live path, so a reservation was reserved and never
//      committed and cost_ledger was never written by the running server.
//   #2 makeDbBudgetReserveFn (adapters.ts) SELECTed budget_account with NO tenant GUC set — under
//      FORCE RLS as the non-superuser `manifold_app` role (migration 0002, the actual production
//      connection) that SELECT matches ZERO rows, so EVERY hard-budget reserve denied closed.
//   #3 ingestTrace (observe.ts) INSERTed usage_record/cost_ledger with NO tenant GUC set — under RLS
//      the WITH CHECK rejects the row, the INSERT throws, and no cost_ledger row is ever written.
//
// This suite connects as `manifold_app` (created + granted by migration 0002, which the shared
// pg-harness always applies) — the SAME non-superuser, RLS-SUBJECT role the running gateway uses in
// production — so all three bugs are reproduced here exactly as they bite in prod, and the fixes are
// proven under the SAME role.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { Sql } from "@manifold/database";
import { reserve as budgetReserve, ulid } from "@manifold/budget";
import { computeCost, type TokenCounts } from "@manifold/domain";
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import { credentialAad, hmacKeyHash, packBase64, sealAesGcm, toHex, wrapDek } from "@manifold/crypto";
import type { Fetcher, Snapshot, SnapshotTarget } from "@manifold/ports";
import { makeDbBudgetReserveFn } from "../src/adapters.ts";
import { ingestTrace } from "../src/observe.ts";
import { buildContext } from "../src/server.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

const WORKSPACE = "ws_wire";
const BUDGET_ACCOUNT = "ba_wire";
const LIMIT_MICROUSD = 1_000_000n;
// APP_PW mirrors migration 0002's placeholder password verbatim (see 0002_app_role.sql) — the
// harness applies that migration unmodified, so this is the REAL production role + password shape.
const APP_PW = "CHANGEME_APP_PASSWORD";

let pg: PgHarness;
let appSql: Sql; // non-superuser, RLS-SUBJECT `manifold_app` connection — the production role.

before(async () => {
  pg = await startPg({ namePrefix: "mf-livewire-e2e" });

  // Minimal DB seed: just the workspace + a HARD budget_account. Everything else the gateway needs
  // (route/target/credential/key) lives in a HAND-BUILT snapshot file below — the gateway never
  // reads those from Postgres; only budget_account (reserve) and usage_record/cost_ledger (ingest)
  // are real DB tables here.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE}','ws-wire','Live Wiring E2E Workspace','local');
    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id) VALUES
      ('${BUDGET_ACCOUNT}','${WORKSPACE}','key','vk_wire','cost_microusd','total',${LIMIT_MICROUSD},'hard','pcr_wire');
  `);

  // The REAL production connection: non-superuser, RLS-SUBJECT `manifold_app` (migration 0002).
  const appUrl = pg.url.replace("postgres:postgres@", `manifold_app:${APP_PW}@`);
  appSql = postgres(appUrl, { max: 4, prepare: false, onnotice: () => {} }) as unknown as Sql;
}, { timeout: 180_000 });

after(async () => {
  if (appSql) { try { await (appSql as unknown as postgres.Sql).end({ timeout: 5 }); } catch { /* ignore */ } }
  if (pg) await pg.stop();
});

// ---------------------------------------------------------------------------
// BUG #2 — makeDbBudgetReserveFn must reserve successfully under the RLS-subject role.
// ---------------------------------------------------------------------------
test("(#2) hard-budget reserve UNDER CAP succeeds under the manifold_app RLS role (pre-fix: always denied — 0-row pre-read)", async () => {
  const reserveFn = makeDbBudgetReserveFn({ sql: appSql, workspaceId: WORKSPACE });
  const result = await reserveFn({
    budgetAccountId: BUDGET_ACCOUNT,
    requestId: "trace_wire_undercap",
    estMicroUsd: 100n,
  });
  assert.equal(
    result.ok,
    true,
    "an under-cap reserve must succeed under manifold_app — pre-fix the unscoped SELECT 0-rows and this always denies",
  );

  if (result.ok) {
    const rows = await pg.sql<{ id: string }[]>`
      SELECT id FROM budget_reservation WHERE id = ${result.reservationId}
    `;
    assert.equal(rows.length, 1, "a real budget_reservation row was created");
  }
});

test("(#2) hard-budget reserve OVER CAP still denies under the manifold_app RLS role (fail-closed preserved)", async () => {
  const reserveFn = makeDbBudgetReserveFn({ sql: appSql, workspaceId: WORKSPACE });
  const result = await reserveFn({
    budgetAccountId: BUDGET_ACCOUNT,
    requestId: "trace_wire_overcap",
    estMicroUsd: LIMIT_MICROUSD * 10n,
  });
  assert.equal(result.ok, false, "an over-cap reserve must still be denied");
  if (!result.ok) assert.equal(result.reason, "BUDGET_RESERVE_DENIED");
});

test("(#2) a workspaceId that does NOT own the budget_account is denied (cross-tenant defense-in-depth)", async () => {
  const reserveFn = makeDbBudgetReserveFn({ sql: appSql, workspaceId: "ws_someone_else" });
  const result = await reserveFn({
    budgetAccountId: BUDGET_ACCOUNT,
    requestId: "trace_wire_wrongws",
    estMicroUsd: 100n,
  });
  assert.equal(result.ok, false, "reserving with the WRONG configured workspace must be denied, never honored");
});

// ---------------------------------------------------------------------------
// BUG #3 — ingestTrace must write usage_record/cost_ledger and commit the reservation under RLS.
// ---------------------------------------------------------------------------
test("(#3) ingestTrace writes cost_ledger/usage_record and commits the reservation under the manifold_app RLS role (pre-fix: WITH CHECK throws, INSERT never happens)", async () => {
  // Set up the reservation via @manifold/budget.reserve DIRECTLY (not adapters.ts) — that function
  // already sets the GUC correctly on its own and is NOT one of the three bugs under test, so this
  // isolates bug #3 (observe.ts) from bug #2 (adapters.ts): this test must fail ONLY because of the
  // INSERT under observe.ts, never because of the pre-read in makeDbBudgetReserveFn.
  const traceId = ulid();
  const reserved = await budgetReserve(appSql, {
    budgetAccountId: BUDGET_ACCOUNT,
    requestId: traceId,
    estMicroUsd: 500n,
    workspaceId: WORKSPACE,
    windowStart: new Date(0),
  });
  assert.equal(reserved.ok, true, "setup: @manifold/budget.reserve (already correct) must succeed");
  if (!reserved.ok) return;
  const occurredAt = new Date().toISOString();
  const events = [
    {
      traceId, seq: 0, kind: "accepted" as const, occurredAt,
      profileId: "prof_wire", keyId: "vk_wire", routeId: "rt_wire", offeringId: "off_wire",
      status: null, reasonCodes: [], budgetAccountId: BUDGET_ACCOUNT,
    },
    {
      traceId, seq: 1, kind: "terminal" as const, occurredAt,
      profileId: "prof_wire", keyId: "vk_wire", routeId: "rt_wire", offeringId: "off_wire",
      status: 200, reasonCodes: [],
      usage: { inputTokens: 1000, outputTokens: 500 },
      price: { inputPerMtokMicroUsd: "3000000", outputPerMtokMicroUsd: "15000000" },
      priceRevisionId: "prc_wire",
      budgetAccountId: BUDGET_ACCOUNT,
      reservationId: reserved.reservationId,
    },
  ];

  // Pre-fix, this THROWS: the INSERT's WITH CHECK rejects every row under the unset GUC.
  const result = await ingestTrace({
    sql: appSql, events, workspaceId: WORKSPACE, producerId: "inst_wire",
  });

  const expectedTokens: TokenCounts = {
    inputTokens: 1000n, outputTokens: 500n, cacheReadTokens: 0n, reasoningTokens: 0n,
    cacheWriteTokens: 0n, audioInputTokens: 0n, audioOutputTokens: 0n,
  };
  const expectedCost = computeCost(expectedTokens, {
    inputPerMtokMicroUsd: 3_000_000n, outputPerMtokMicroUsd: 15_000_000n,
  });
  assert.equal(result.cost.amountMicroUsd, expectedCost, "ingestTrace computed the right cost");

  const ledger = await pg.sql<{ amount_microusd: string }[]>`
    SELECT amount_microusd FROM cost_ledger WHERE trace_id = ${traceId}
  `;
  assert.equal(ledger.length, 1, "cost_ledger row was written under the RLS-subject role");
  assert.equal(BigInt(ledger[0]!.amount_microusd), expectedCost);

  const usage = await pg.sql<{ input_tokens: string }[]>`
    SELECT input_tokens FROM usage_record WHERE trace_id = ${traceId}
  `;
  assert.equal(usage.length, 1, "usage_record row was written under the RLS-subject role");

  const resv = await pg.sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE id = ${reserved.reservationId}
  `;
  assert.equal(resv[0]!.status, "committed", "the reservation reconciled reserved -> committed");
});

// ---------------------------------------------------------------------------
// BUG #1 — buildContext must wire a REAL DB-backed ingest sink that drives ingestTrace on the
// live path, so a terminal carrying a reservationId reconciles WITHOUT any test manually calling
// ingestTrace. Uses a hand-built (unsigned dev) snapshot file + a fake upstream fetcher, but the
// REAL buildContext / real reserve+ingest wiring end to end.
// ---------------------------------------------------------------------------
test("(#1) buildContext wires a live DB ingest sink: a real request auto-commits its reservation and writes cost_ledger with NO manual ingestTrace call", async () => {
  const INSTALLATION = "inst_wire2";
  const HOST = "wire2.local";
  const PROFILE_ID = "prof_wire2";
  const BUDGET_ACCOUNT_2 = "ba_wire2";
  const OFFERING = "off_wire2";
  const CRED_ID = "cred_wire2";
  const VALID_KEY = "sk-wire2-key";
  const PEPPER = "wire2-pepper";

  pg.psql(`
    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id) VALUES
      ('${BUDGET_ACCOUNT_2}','${WORKSPACE}','key','vk_wire2','cost_microusd','total',${LIMIT_MICROUSD},'hard','pcr_wire2');
  `);

  const kek = randomBytes(32);
  const dek = randomBytes(32);
  const wrappedDek = packBase64(wrapDek(kek, dek));
  const credentialCiphertext = packBase64(
    sealAesGcm(dek, new TextEncoder().encode("PROVIDER-SECRET-WIRE"), credentialAad(CRED_ID)),
  );
  const pepperBytes = new TextEncoder().encode(PEPPER);
  const keyHashHex = toHex(hmacKeyHash(pepperBytes, new TextEncoder().encode(VALID_KEY)));

  const target: SnapshotTarget = {
    offeringId: OFFERING,
    credentialId: CRED_ID,
    dekId: "dek_wire2",
    credentialCiphertext,
    wrappedDek,
    weight: 1,
    priority: 0,
    baseUrl: "https://example.test",
    region: null,
    allowedHosts: ["example.test"],
    authInject: { headers: { "x-api-key": "${secret}" } },
  };

  const snapshot: Snapshot = {
    meta: {
      schema: "manifold.snapshot.v1", installationId: INSTALLATION, revision: "r1",
      contentHash: "sha256:test", builtAt: new Date().toISOString(), signature: "", signingKeyId: "d",
    },
    profiles: { [HOST]: { id: PROFILE_ID, mode: "public_app", policyRevision: null, defaultRouteSet: null } },
    keys: {
      [keyHashHex]: {
        id: "vk_wire2", profileId: PROFILE_ID, scopes: [], allowedAppIds: [],
        budgetAccountId: BUDGET_ACCOUNT_2, expiresAt: null,
      },
    },
    routes: {
      [`${PROFILE_ID}:/v1/messages`]: {
        routeId: "rt_wire2", revision: "r1", mode: "ordered", timeoutMs: 5000,
        capturePolicyId: "cap_none", targets: [target],
      },
    },
    budgets: { [BUDGET_ACCOUNT_2]: { id: BUDGET_ACCOUNT_2, enforcement: "hard", unit: "cost_microusd", window: "total", limit: String(LIMIT_MICROUSD) } },
    offerings: { [OFFERING]: { priceRevisionId: "prc_wire2", price: { inputPerMtokMicroUsd: "3000000", outputPerMtokMicroUsd: "15000000" } } },
  };

  const dir = mkdtempSync(join(tmpdir(), "mf-livewire-"));
  const snapshotPath = join(dir, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  const fetcher: Fetcher = {
    async fetch(_req: Request): Promise<Response> {
      const body = JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 500 } });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
      });
    },
  };

  // buildContext reads MANIFOLD_BUDGET_DB_URL / DATABASE_URL from the environment (there is no
  // ServerOptions override for the DB url itself) — point it at the SAME container just for this
  // call, then restore. The wiring bug is about buildContext's OWN construction, so the superuser
  // URL is fine here — bugs #2/#3 are separately proven end-to-end under manifold_app above.
  const prevUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = pg.url;
  let liveCtx: GatewayContext;
  try {
    liveCtx = await buildContext({
      snapshotPath,
      installationId: INSTALLATION,
      pepper: PEPPER,
      kek,
      fetcher,
      workspaceId: WORKSPACE,
    });
  } finally {
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
  }

  const req = new Request(`http://${HOST}/v1/messages`, {
    method: "POST",
    headers: { host: HOST, authorization: `Bearer ${VALID_KEY}` },
    body: JSON.stringify({ model: "wire2-model", max_tokens: 50 }),
  });

  const res = await handleRequest(liveCtx, req);
  assert.equal(res.status, 200, "the request dispatches");
  const traceId = res.headers.get("x-trace-id");
  assert.ok(traceId, "trace id returned to client");

  // ctx.ingest.emit is fire-and-forget (`void ctx.ingest.emit(event).catch(() => {})` in
  // handleRequest) — poll briefly for the DB write to land instead of asserting synchronously.
  const ledger = await waitFor(async () => {
    const rows = await pg.sql<{ amount_microusd: string }[]>`
      SELECT amount_microusd FROM cost_ledger WHERE trace_id = ${traceId}
    `;
    return rows.length > 0 ? rows : undefined;
  });
  assert.ok(
    ledger,
    "cost_ledger row must appear with NO manual ingestTrace call — pre-fix buildContext wires ONLY " +
      "JsonlIngestSink, so the live path never drives ingestTrace and this row never appears",
  );
  assert.equal(ledger!.length, 1, "cost_ledger row appeared with NO manual ingestTrace call — the live path wired it");

  const resv = await pg.sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE budget_account_id = ${BUDGET_ACCOUNT_2}
  `;
  assert.equal(resv.length, 1);
  assert.equal(resv[0]!.status, "committed", "the reservation auto-reconciled reserved -> committed on the live path");
});

/** Poll `fn` until it returns a defined value or `timeoutMs` elapses. */
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}
