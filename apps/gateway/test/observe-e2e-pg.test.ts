// END-TO-END observation/billing over a REAL Postgres 16 (SPEC §6.9, §6.10, §8.3, §8.4, ADR-0011/12).
//
// This proves the LAST governance-critical wire: a real request whose provider reports token usage
// produces (a) a correct `cost_ledger` row and (b) a hard-budget reservation reconciled
// reserved→committed at the ACTUAL cost. The chain proven here is:
//
//   operator DB (offering + provider_price_revision + HARD budget_account + virtual_key)
//     → config.buildSnapshot → snapshot.offerings[off].price + snapshot.budgets
//     → gateway-core.handleRequest (REAL DB reserve pre-dispatch; mock upstream returns a JSON
//       `usage` block) → flat terminal observation carrying tokens + dispatch price + reservation
//     → observability.journalFromPortsEvents → reduce() → project() (§6.10 computeCost)
//     → INSERT cost_ledger + usage_record  AND  @manifold/budget.commit (reserved→committed).
//
// The reserve AND the commit are REAL DB transactions against the SAME container; the cost is REAL
// §6.10 integer-µ$ math. Spends ZERO external tokens: an in-memory fetcher stands in for the provider.
//
// BEFORE this wire (the gateway emitted a terminal with NO tokens, no ingest, no reconcile) there is
// NO cost_ledger row and the reservation is stranded at 'reserved'. AFTER it, cost_ledger carries the
// exact µ$ and the reservation is 'committed'. (The failing→passing demonstration is in the report.)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Sql } from "@manifold/database";
import { buildSnapshot } from "@manifold/config";
import { computeCost, type TokenCounts } from "@manifold/domain";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type { Fetcher, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { BudgetReserverAdapter, makeDbBudgetReserveFn } from "../src/adapters.ts";
import { ingestTrace } from "../src/observe.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";

// ── shared crypto + key material (the SAME FakeCrypto the gateway authenticates with) ──────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("observe-e2e-pepper");
const VALID_KEY = "sk-observe-e2e-key";
const keyHashHex = await keyedHashHex(crypto, pepper, VALID_KEY);

const INSTALLATION = "inst_oe2e";
const WORKSPACE = "ws_oe2e";
const PROFILE = "prof_oe2e";
const HOST = "observe-e2e.local";
const BUDGET_ACCOUNT = "ba_oe2e";
const OFFERING = "off_oe2e";
const PRICE_REV = "prc_oe2e";

// Prices (per-mtok µ$) and usage the mock upstream reports. The hand-computed cost is asserted.
const INPUT_PRICE = 3_000_000n; // $3 / 1M input tokens
const OUTPUT_PRICE = 15_000_000n; // $15 / 1M output tokens
const INPUT_TOKENS = 1000n;
const OUTPUT_TOKENS = 500n;
// A HARD cap generous enough that the pre-dispatch reserve (est ≈ max_tokens=500 µ$) succeeds; the
// reconcile then COMMITS the real actual cost (which may exceed the estimate — that is the point).
const LIMIT_MICROUSD = 1_000_000;

let pg: PgHarness;
let realReserve: GatewayContext["reserveBudget"];

before(async () => {
  pg = await startPg({ namePrefix: "mf-observe-e2e" });

  // Seed one tenant with: an offering PRICED by a provider_price_revision (offering.active_price →
  // price), a credential/DEK, an ingress profile (NO policy — isolate the billing path), a chat
  // route/target, a HARD budget_account, and a virtual_key bound to it. The offering↔price FK is
  // circular, so insert the offering unpriced, insert the price, then point the offering at it.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('${WORKSPACE}','ws-oe2e','Observe E2E Workspace','local');

    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('cm_oe2e','oe2e-model','OE2E Model','cat1');

    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('dek_oe2e','${WORKSPACE}','\\xdeadbeef','kek1','active');

    INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision,
       capabilities, catalog_revision) VALUES
      ('${OFFERING}','cm_oe2e','openai','oe2e-model','["chat"]','ar1','{}','cat1');

    -- The price revision the gateway resolves at dispatch and stamps onto the terminal for cost.
    INSERT INTO provider_price_revision
      (id, offering_id, workspace_id, input_per_mtok_microusd, output_per_mtok_microusd,
       fidelity, content_hash, catalog_revision) VALUES
      ('${PRICE_REV}','${OFFERING}','${WORKSPACE}',${INPUT_PRICE},${OUTPUT_PRICE},
       'provider_verified','sha256:priceoe2e','cat1');

    UPDATE provider_model_offering SET active_price_revision_id = '${PRICE_REV}' WHERE id = '${OFFERING}';

    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status) VALUES
      ('cred_oe2e','${WORKSPACE}','openai','openai key','\\xc0ffee','dek_oe2e',NULL,'["api.openai.com"]','valid');

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('${INSTALLATION}','${WORKSPACE}','inst-oe2e','{"kind":"test"}');

    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('${PROFILE}','${WORKSPACE}','${INSTALLATION}','${HOST}','public_app','{}');

    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_oe2e','${WORKSPACE}','${INSTALLATION}','chat-route','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_oe2e','${WORKSPACE}','route_oe2e','ordered','{}','{"overall_ms":30000}','sha256:revoe2e');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_oe2e','${WORKSPACE}','rev_oe2e','cred_oe2e','${OFFERING}','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_oe2e' WHERE id = 'route_oe2e';

    INSERT INTO budget_account
      (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
       pricing_catalog_revision_id) VALUES
      ('${BUDGET_ACCOUNT}','${WORKSPACE}','key','vk_oe2e','cost_microusd','total',${LIMIT_MICROUSD},'hard','pcr_oe2e');

    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
      ('vk_oe2e','${WORKSPACE}','${PROFILE}','sk-oe2e','\\x${keyHashHex}','[]','[]','${BUDGET_ACCOUNT}');
  `);

  const reserver = new BudgetReserverAdapter(
    makeDbBudgetReserveFn({ sql: pg.sql as unknown as Sql }),
  );
  realReserve = (input) => reserver.reserve(input);
}, { timeout: 300_000 });

after(async () => {
  if (pg) await pg.stop();
});

/** Mock upstream: a SMALL JSON completion carrying a `usage` block (declared content-type + length). */
class UsageFetcher implements Fetcher {
  count = 0;
  async fetch(_req: Request): Promise<Response> {
    this.count += 1;
    const body = JSON.stringify({
      id: "msg_oe2e",
      model: "oe2e-model",
      usage: { input_tokens: Number(INPUT_TOKENS), output_tokens: Number(OUTPUT_TOKENS) },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
  }
}

function makeCtx(snapshot: Snapshot, fetcher: Fetcher): { ctx: GatewayContext; ingest: FakeIngestSink } {
  const ingest = new FakeIngestSink();
  const ctx: GatewayContext = {
    installationId: INSTALLATION,
    snapshot,
    crypto,
    clock: new FixedClock(),
    ingest,
    fetcher,
    pepper,
    resolveSecret: async (_t: SnapshotTarget) => "PROVIDER-SECRET",
    reserveBudget: realReserve,
  };
  return { ctx, ingest };
}

function req(body: unknown): Request {
  return new Request(`http://${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { host: HOST, authorization: `Bearer ${VALID_KEY}` },
    body: JSON.stringify(body),
  });
}

// The hand-computed §6.10 cost of this request, to the µ$ (the ledger MUST match exactly).
const EXPECTED_TOKENS: TokenCounts = {
  inputTokens: INPUT_TOKENS,
  outputTokens: OUTPUT_TOKENS,
  cacheReadTokens: 0n,
  reasoningTokens: 0n,
  cacheWriteTokens: 0n,
  audioInputTokens: 0n,
  audioOutputTokens: 0n,
};
const EXPECTED_COST = computeCost(EXPECTED_TOKENS, {
  inputPerMtokMicroUsd: INPUT_PRICE,
  outputPerMtokMicroUsd: OUTPUT_PRICE,
}); // = 3000 + 7500 = 10500 µ$

test("snapshot carries the offering's dispatch price (offerings[off].price)", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const off = snap.offerings?.[OFFERING];
  assert.ok(off, "the offering must be present in snapshot.offerings");
  assert.equal(off.priceRevisionId, PRICE_REV);
  assert.equal(off.price?.inputPerMtokMicroUsd, String(INPUT_PRICE));
  assert.equal(off.price?.outputPerMtokMicroUsd, String(OUTPUT_PRICE));
});

test("real request → correct cost_ledger row AND reservation reserved→committed at ACTUAL cost", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new UsageFetcher();
  const { ctx, ingest } = makeCtx(snap, fetcher);

  // Drive a REAL request. The DB reserve runs pre-dispatch; the mock upstream returns the usage body.
  const res = await handleRequest(ctx, req({ model: "oe2e-model", max_tokens: 500 }));
  assert.equal(res.status, 200, "the under-cap request dispatches");
  assert.equal(fetcher.count, 1, "upstream was called exactly once");

  const traceId = res.headers.get("x-trace-id");
  assert.ok(traceId, "trace id returned to client");

  // The terminal flat event must carry the captured usage + dispatch price + the reservation.
  const terminal = ingest.events.find((e) => e.kind === "terminal");
  assert.ok(terminal, "a terminal observation was emitted");
  assert.equal(terminal.usage?.inputTokens, Number(INPUT_TOKENS), "terminal carries input tokens");
  assert.equal(terminal.usage?.outputTokens, Number(OUTPUT_TOKENS), "terminal carries output tokens");
  assert.ok(terminal.reservationId, "terminal carries the reservation id to reconcile");

  // A reservation exists and is still 'reserved' BEFORE ingest (proves the reconcile is what commits).
  const beforeIngest = await pg.sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  assert.equal(beforeIngest.length, 1, "exactly one reservation was created by the pre-dispatch reserve");
  assert.equal(beforeIngest[0]!.status, "reserved", "the reservation is 'reserved' until reconciled");

  // ── INGEST: map → reduce → project → INSERT cost_ledger/usage_record + commit the reservation ──
  const result = await ingestTrace({
    sql: pg.sql as unknown as Sql,
    events: ingest.events,
    workspaceId: WORKSPACE,
    producerId: INSTALLATION,
  });

  // (a) cost_ledger row exists with amount_microusd == the hand-computed computeCost, to the µ$.
  const ledger = await pg.sql<{ amount_microusd: string; fidelity: string; offering_id: string; price_revision_id: string }[]>`
    SELECT amount_microusd, fidelity, offering_id, price_revision_id
    FROM cost_ledger WHERE trace_id = ${traceId}
  `;
  assert.equal(ledger.length, 1, "exactly one cost_ledger row was written for the trace");
  assert.equal(
    BigInt(ledger[0]!.amount_microusd),
    EXPECTED_COST,
    `cost_ledger amount_microusd must equal computeCost = ${EXPECTED_COST} µ$`,
  );
  assert.equal(ledger[0]!.fidelity, "exact", "usage + price captured ⇒ exact fidelity");
  assert.equal(ledger[0]!.offering_id, OFFERING);
  assert.equal(ledger[0]!.price_revision_id, PRICE_REV);
  // The projection agrees with the returned Observation cost.
  assert.equal(result.cost.amountMicroUsd, EXPECTED_COST);

  // (b) the reservation moved reserved→committed by the ACTUAL cost.
  const resv = await pg.sql<{ status: string; reconciled_microusd: string | null }[]>`
    SELECT status, reconciled_microusd FROM budget_reservation WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  assert.equal(resv[0]!.status, "committed", "the reservation is now committed");
  assert.equal(
    BigInt(resv[0]!.reconciled_microusd ?? "0"),
    EXPECTED_COST,
    "reconciled_microusd reflects the real spend",
  );

  // The window counter released the hold and booked the real spend.
  const win = await pg.sql<{ reserved_microusd: string; committed_microusd: string }[]>`
    SELECT reserved_microusd, committed_microusd FROM budget_window_state
    WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  assert.equal(BigInt(win[0]!.reserved_microusd), 0n, "the reserved hold was released");
  assert.equal(
    BigInt(win[0]!.committed_microusd),
    EXPECTED_COST,
    "committed_microusd is the real spend (reserved→committed)",
  );
});

// review HIGH #12 / data-F6: the ingest transport is at-least-once, so a REDELIVERED trace must not
// double-write the money-truth ledger nor double-commit the reservation. The deterministic created_at
// + ON CONFLICT DO NOTHING (and idempotent commit) make the whole ingest at-most-once.
test("idempotent re-ingest: same trace twice ⇒ cost_ledger written ONCE and committed ONCE (#12)", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  const fetcher = new UsageFetcher();
  const { ctx, ingest } = makeCtx(snap, fetcher);

  const res = await handleRequest(ctx, req({ model: "oe2e-model", max_tokens: 500 }));
  assert.equal(res.status, 200, "the under-cap request dispatches");
  const traceId = res.headers.get("x-trace-id");
  assert.ok(traceId, "trace id returned");

  // window committed_microusd accumulates across tests → measure the DELTA this trace contributes.
  const before = await pg.sql<{ committed_microusd: string }[]>`
    SELECT committed_microusd FROM budget_window_state WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  const committedBefore = BigInt(before[0]?.committed_microusd ?? "0");

  const args = {
    sql: pg.sql as unknown as Sql,
    events: ingest.events,
    workspaceId: WORKSPACE,
    producerId: INSTALLATION,
  };
  await ingestTrace(args);
  await ingestTrace(args); // REDELIVERY of the identical trace — must be a clean no-op

  const ledger = await pg.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM cost_ledger WHERE trace_id = ${traceId}
  `;
  assert.equal(ledger[0]!.n, "1", "a redelivered trace must NOT double-write the money-truth ledger");

  const after = await pg.sql<{ committed_microusd: string }[]>`
    SELECT committed_microusd FROM budget_window_state WHERE budget_account_id = ${BUDGET_ACCOUNT}
  `;
  const committedDelta = BigInt(after[0]!.committed_microusd) - committedBefore;
  assert.equal(committedDelta, EXPECTED_COST, "the reservation commits exactly once, not twice");
});

// review gateway-F5 / #2: a STREAMED success captures no usage, so pre-fix its terminal carried NO
// reservation id and the hold was orphaned until an (unwired) sweep — a budget-hold DoS + headroom
// leak. Now the terminal ALWAYS carries the reservation id, so ingest reconciles it (commits at $0,
// releasing the hold) even with no measured usage.
test("gateway-F5/#2: a STREAMED success (no usage) RELEASES the hold, not orphaned at 'reserved'", async () => {
  const snap = await buildSnapshot(pg.sql, INSTALLATION);
  // No content-length + event-stream ⇒ isBufferableJson=false ⇒ no usage captured (a real SSE shape).
  const streamFetcher: Fetcher = {
    async fetch() {
      return new Response("data: {}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  };
  const { ctx, ingest } = makeCtx(snap, streamFetcher);

  const res = await handleRequest(ctx, req({ model: "oe2e-model", max_tokens: 500 }));
  assert.equal(res.status, 200, "the streamed response is relayed");
  const traceId = res.headers.get("x-trace-id");
  assert.ok(traceId, "trace id returned");

  const terminal = ingest.events.find((e) => e.kind === "terminal");
  assert.ok(terminal, "a terminal was emitted for the streamed success");
  assert.equal(terminal.usage, undefined, "a streamed response captures NO usage (the pre-fix leak trigger)");
  assert.ok(terminal.reservationId, "the streamed-success terminal MUST still carry the reservation id");

  // Reservation for THIS trace exists and is 'reserved' before ingest.
  const before = await pg.sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE request_id = ${traceId}
  `;
  assert.equal(before.length, 1, "a reservation was held for the streamed request");
  assert.equal(before[0]!.status, "reserved", "held until reconciled");

  await ingestTrace({
    sql: pg.sql as unknown as Sql,
    events: ingest.events,
    workspaceId: WORKSPACE,
    producerId: INSTALLATION,
  });

  const resv = await pg.sql<{ status: string }[]>`
    SELECT status FROM budget_reservation WHERE request_id = ${traceId}
  `;
  assert.equal(
    resv[0]!.status,
    "committed",
    "the streamed-success hold was RELEASED (committed at $0), not stranded at 'reserved'",
  );
});
