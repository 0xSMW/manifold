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
import type { Database } from "@manifold/database";
import { buildSnapshot } from "@manifold/config";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type { Fetcher, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { BudgetReserverAdapter, makeDbBudgetReserveFn } from "../src/adapters.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

// ── shared crypto + key material (the SAME FakeCrypto the gateway authenticates with) ──────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("budget-e2e-pepper");
const VALID_KEY = "sk-budget-e2e-key";
const keyHashHex = await keyedHashHex(crypto, pepper, VALID_KEY);

const INSTALLATION = "inst_be2e";
const PROFILE = "prof_be2e";
const HOST = "budget-e2e.local";
const BUDGET_ACCOUNT = "ba_be2e";
// A small HARD cap of 100 µ$. enforce.ts estimates est ≈ max_tokens, so max_tokens=50 fits (≤100)
// and max_tokens=1000 blows the cap (>100) — the real DB reserve is the thing that decides.
const LIMIT_MICROUSD = 100;

let pg: PgHarness;
let db: Database;
/** The REAL reserver: @manifold/budget.reserve bound to the SAME container. NO fake. */
let realReserve: GatewayContext["reserveBudget"];

before(async () => {
  pg = await startPg({ namePrefix: "mf-budget-e2e" });
  db = { $client: pg.sql } as unknown as Database;

  // One workspace + installation + ingress profile (NO policy bound — this isolates the budget
  // gate), an offering/credential/DEK + a chat route so an under-cap request can actually dispatch,
  // a HARD budget_account with a small cap, and a virtual_key BOUND to that budget account. The
  // credential allowlist contains api.openai.com so the target survives the fail-closed egress filter.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_be2e','ws-be2e','Budget E2E Workspace','local');

    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('cm_be2e','be2e-model','BE2E Model','cat1');

    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('dek_be2e','ws_be2e','\\xdeadbeef','kek1','active');

    INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision,
       capabilities, catalog_revision) VALUES
      ('off_be2e','cm_be2e','openai','be2e-model','["chat"]','ar1','{}','cat1');

    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status) VALUES
      ('cred_be2e','ws_be2e','openai','openai key','\\xc0ffee','dek_be2e',NULL,'["api.openai.com"]','valid');

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('${INSTALLATION}','ws_be2e','inst-be2e','{"kind":"test"}');

    -- Ingress profile with NO policy revision: the ONLY enforcement here is the hard budget.
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('${PROFILE}','ws_be2e','${INSTALLATION}','${HOST}','public_app','{}');

    -- A chat route (→ /v1/chat/completions) so an UNDER-cap request actually dispatches.
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_be2e','ws_be2e','${INSTALLATION}','chat-route','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_be2e','ws_be2e','route_be2e','ordered','{}','{"overall_ms":30000}','sha256:revbe2e');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_be2e','ws_be2e','rev_be2e','cred_be2e','off_be2e','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_be2e' WHERE id = 'route_be2e';

    -- The operator's HARD budget account: cost_microusd / total window / small cap. hard budgets
    -- require a pricing catalog revision (schema CHECK hard_requires_pricing).
    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id) VALUES
      ('${BUDGET_ACCOUNT}','ws_be2e','key','vk_be2e','cost_microusd','total',${LIMIT_MICROUSD},'hard','pcr_be2e');

    -- The virtual key on this profile, BOUND to the hard budget account. keyed_hash = hex(HMAC(
    -- pepper, VALID_KEY)) computed by the SAME FakeCrypto the gateway authenticates with.
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
      ('vk_be2e','ws_be2e','${PROFILE}','sk-be2e','\\x${keyHashHex}','[]','[]','${BUDGET_ACCOUNT}');
  `);

  // THE REAL RESERVER: @manifold/budget.reserve against the SAME Postgres container (NO fake).
  const reserver = new BudgetReserverAdapter(
    makeDbBudgetReserveFn({ sql: pg.sql as unknown as Sql }),
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

function req(body: unknown): Request {
  return new Request(`http://${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { host: HOST, authorization: `Bearer ${VALID_KEY}` },
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
  const snap = await buildSnapshot(db, INSTALLATION);

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
  const snap = await buildSnapshot(db, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const before = await reservationCount();
  const res = await handleRequest(ctx, req({ model: "be2e-model", max_tokens: 50 }));

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
  const snap = await buildSnapshot(db, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const before = await reservationCount();
  // est ≈ max_tokens = 1000 ≫ cap 100 ⇒ the DB reserve denies (committed+reserved+est > limit).
  const res = await handleRequest(ctx, req({ model: "be2e-model", max_tokens: 1000 }));

  assert.equal(res.status, 402, "an over-cap hard budget returns 402");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "BUDGET_RESERVE_DENIED", "the reserve-denied reason reaches the client");
  assert.equal(fetcher.count, 0, "a denied request must NEVER reach the provider");
  assert.equal(await reservationCount(), before, "no reservation row is created for a denied request");
});
