// END-TO-END hard-budget enforcement over a REAL Postgres 16 (SPEC §6.7, §7.5, §16.3, ADR-0012).
//
// This proves the WHOLE budget seam the same way policy-e2e-pg proved the policy seam: an OPERATOR
// writes a DB `budget_account` (enforcement='hard'), binds a `virtual_key` to it, and the running
// gateway REFUSES an over-cap request BEFORE any provider dispatch — with NO hand-built snapshot and
// NO fake reserver. The chain proven here is:
//
//   operator DB (budget_account 'hard' + virtual_key.budget_account_id)
//     → config.buildSnapshot → snapshot.budgets (SnapshotBudgetAccount, enforcement 'hard')
//     → gateway-core.enforceRequest → ctx.reserveBudget (the REAL BudgetReserverAdapter
//       = @manifold/budget.reserve against the SAME Postgres) → 402 BUDGET_RESERVE_DENIED,
//       upstream call count 0.
//
// The reservation is a REAL DB transaction: an under-cap request creates a genuine
// `budget_reservation` row and dispatches (upstream count 1); an over-cap request is denied by the
// DB reserve (`committed + reserved + est > limit`) and never reaches the provider.
//
// BEFORE the two fixes this FAILS:
//   (a) config did not emit `snapshot.budgets`, so enforce.ts sees no hard budget and the over-cap
//       request DISPATCHES (status 200, upstream count 1) instead of 402; and
//   (b) apps/gateway had no real reserver wired.
// AFTER the fixes it PASSES.
//
// Spends ZERO external tokens: an in-memory counting fetcher stands in for the provider. Container
// lifecycle is the shared throwaway-Postgres harness (docker-run postgres:16, every migration).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "@manifold/database";
import { buildSnapshot } from "@manifold/config";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type { Fetcher, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { BudgetReserverAdapter, makeDbBudgetReserveFn } from "../src/adapters.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { seedMinimalGatewayTenant } from "../../../packages/database/test/seed-gateway-tenant.ts";

// ── shared crypto + key material (the SAME FakeCrypto the gateway authenticates with) ──────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("budget-e2e-pepper");
const VALID_KEY = "sk-budget-e2e-key";
const keyHashHex = await keyedHashHex(crypto, pepper, VALID_KEY);
// A second key bound to a unit=TOKENS hard budget (review #3: token budgets enforce pre-dispatch).
const TOKEN_KEY = "sk-budget-e2e-token-key";
const tokenKeyHashHex = await keyedHashHex(crypto, pepper, TOKEN_KEY);
const TOKEN_BUDGET_ACCOUNT = "ba_be2e_tok";
// A small HARD cap of 100 TOKENS. estTokens = input_est(~10) + max_tokens, so max_tokens=10 fits (~20)
// and max_tokens=1000 blows it (~1010) — enforced on reserved_tokens BEFORE dispatch.
const TOKEN_LIMIT = 100;

const INSTALLATION = "inst_be2e";
const PROFILE = "prof_be2e";
const HOST = "budget-e2e.local";
const BUDGET_ACCOUNT = "ba_be2e";
// A small HARD cap of 100 µ$. enforce.ts estimates est ≈ max_tokens, so max_tokens=50 fits (≤100)
// and max_tokens=1000 blows the cap (>100) — the real DB reserve is the thing that decides.
const LIMIT_MICROUSD = 100;

let pg: PgHarness;
/** The REAL reserver: @manifold/budget.reserve bound to the SAME container. NO fake. */
let realReserve: GatewayContext["reserveBudget"];

before(async () => {
  pg = await startPg({ namePrefix: "mf-budget-e2e" });

  // One workspace + installation + ingress profile (NO policy bound — this isolates the budget
  // gate), an offering/credential/DEK + a chat route so an under-cap request can actually dispatch,
  // a HARD budget_account with a small cap, and a virtual_key BOUND to that budget account, all via
  // the shared helper (prefix be2e ⇒ ws_be2e, off_be2e, prc_be2e, ba_be2e = BUDGET_ACCOUNT, vk_be2e).
  // The credential allowlist contains api.openai.com so the target survives the fail-closed egress
  // filter. The offering is PRICED (review #4: a µ$ hard budget over an UNPRICED offering fails
  // closed); 1,000,000 µ$/mtok = exactly 1 µ$/token, so the reserve estimate stays est ≈ max_tokens
  // — the 100 µ$ cap still admits max_tokens=50 and denies max_tokens=1000, exactly as before pricing.
  //
  // Appended AFTER the helper: a SECOND unit=TOKENS hard budget (100 tokens) + a key bound to it
  // (review #3: pre-dispatch token guard) — the token scenario this suite additionally proves.
  pg.psql(
    seedMinimalGatewayTenant({
      prefix: "be2e",
      hostname: HOST,
      keyHashHex,
      workspaceName: "Budget E2E Workspace",
      price: { inputPerMtokMicrousd: 1000000, outputPerMtokMicrousd: 1000000 },
      budget: { limitAmount: LIMIT_MICROUSD },
    }) +
      `
    -- A unit=TOKENS hard budget (100 tokens) + a key bound to it (review #3: pre-dispatch token guard).
    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id) VALUES
      ('${TOKEN_BUDGET_ACCOUNT}','ws_be2e','key','vk_be2e_tok','tokens','total',${TOKEN_LIMIT},'hard','pcr_be2e');
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
      ('vk_be2e_tok','ws_be2e','${PROFILE}','sk-tok','\\x${tokenKeyHashHex}','[]','[]','${TOKEN_BUDGET_ACCOUNT}');
  `,
  );

  // THE REAL RESERVER: @manifold/budget.reserve against the SAME Postgres container (NO fake).
  const reserver = new BudgetReserverAdapter(
    makeDbBudgetReserveFn({ sql: pg.sql as unknown as Sql, workspaceId: "ws_be2e" }),
  );
  realReserve = (input) => reserver.reserve(input);
}, { timeout: 300_000 });

after(async () => {
  if (pg) await pg.stop();
});

// ── gateway harness: a counting fetcher + a context over the CONFIG-BUILT snapshot ─────────────
class CountingFetcher implements Fetcher {
  count = 0;
  async fetch(_req: Request): Promise<Response> {
    this.count += 1;
    return new Response("upstream-ok", { status: 200 });
  }
}

function makeCtx(snapshot: Snapshot, fetcher: Fetcher): GatewayContext {
  return {
    installationId: INSTALLATION,
    snapshot,
    crypto,
    clock: new FixedClock(),
    ingest: new FakeIngestSink(),
    fetcher,
    pepper,
    resolveSecret: async (_t: SnapshotTarget) => "PROVIDER-SECRET",
    reserveBudget: realReserve, // the REAL DB reserve
  };
}

function req(body: unknown, key: string = VALID_KEY): Request {
  return new Request(`http://${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { host: HOST, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function reservationCount(): Promise<number> {
  const rows = await pg.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM budget_reservation WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  return Number(rows[0]!.n);
}

// ── (0) REAL EMISSION — the built snapshot carries the operator's HARD budget + the key's link ──
test("buildSnapshot emits the HARD budget_account into snapshot.budgets and the key carries budgetAccountId", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);

  // The key is keyed by hex(keyed_hash); it must carry the operator's budget_account_id.
  const key = snap.keys[keyHashHex];
  assert.ok(key, "the virtual key must be present in the snapshot");
  assert.equal(key.budgetAccountId, BUDGET_ACCOUNT, "the key carries its budget account id");

  // snapshot.budgets is keyed EXACTLY how enforce.ts looks it up: key.budgetAccountId. On pre-fix
  // code `snapshot.budgets` is undefined and this fails.
  const budget = snap.budgets?.[BUDGET_ACCOUNT];
  assert.ok(budget, "snapshot.budgets must carry the referenced hard account");
  assert.equal(budget.enforcement, "hard", "the account is emitted as a HARD budget");
  assert.equal(budget.window, "total");
  assert.equal(budget.limit, String(LIMIT_MICROUSD));
});

// ── (1) UNDER the cap ⇒ dispatched (upstream count 1) AND a real budget_reservation row exists ──
test("under-cap request ⇒ dispatched (upstream call 1) and a REAL budget_reservation row is created", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const before = await reservationCount();
  const res = await handleRequest(ctx, req({ model: "chat-route", max_tokens: 50 }));

  assert.equal(res.status, 200, "an under-cap request proceeds to dispatch");
  assert.equal(fetcher.count, 1, "the under-cap request WAS dispatched to the provider exactly once");
  assert.equal(
    await reservationCount(),
    before + 1,
    "a REAL budget_reservation row was created by the DB reserve",
  );
});

// ── (2) EXCEEDS the cap ⇒ 402 BUDGET_RESERVE_DENIED, upstream call count 0 (the DB denied it) ───
test("over-cap request ⇒ 402 BUDGET_RESERVE_DENIED and upstream call count 0 (denied by the DB reserve)", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const before = await reservationCount();
  // est ≈ max_tokens = 1000 ≫ cap 100 ⇒ the DB reserve denies (committed+reserved+est > limit).
  const res = await handleRequest(ctx, req({ model: "chat-route", max_tokens: 1000 }));

  assert.equal(res.status, 402, "an over-cap hard budget returns 402");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "BUDGET_RESERVE_DENIED", "the reserve-denied reason reaches the client");
  assert.equal(fetcher.count, 0, "a denied request must NEVER reach the provider");
  assert.equal(await reservationCount(), before, "no reservation row is created for a denied request");
});

// review #3: a unit=TOKENS hard budget must enforce on reserved_tokens BEFORE dispatch. Pre-fix the
// gateway passed no token estimate, so estTokens=0, the token guard never tripped, and a token cap was
// unenforced. Now enforce threads estimatedInputTokens+maxOutputTokens through the reserver.
test("(#3) TOKEN-unit hard budget: over-token-cap request ⇒ 402, upstream count 0 (denied pre-dispatch)", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  // estTokens = input_est(~10) + max_tokens(1000) = ~1010 ≫ 100-token cap ⇒ the DB reserve denies.
  const res = await handleRequest(ctx, req({ model: "chat-route", max_tokens: 1000 }, TOKEN_KEY));
  assert.equal(res.status, 402, "an over-token-cap hard budget returns 402");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "BUDGET_RESERVE_DENIED", "reserve-denied reason reaches the client");
  assert.equal(fetcher.count, 0, "the provider was NEVER dispatched to for an over-token-cap request");
});

test("(#3) TOKEN-unit hard budget: under-token-cap request ⇒ dispatched (upstream count 1)", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  // estTokens = input_est(~10) + max_tokens(10) = ~20 ≤ 100-token cap ⇒ reserve admits, dispatches.
  const res = await handleRequest(ctx, req({ model: "chat-route", max_tokens: 10 }, TOKEN_KEY));
  assert.equal(res.status, 200, "an under-token-cap request dispatches");
  assert.equal(fetcher.count, 1, "the under-token-cap request WAS dispatched exactly once");
});
