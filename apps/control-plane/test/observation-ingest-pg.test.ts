import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { installationRequestSigningInput } from "../lib/installation-auth.ts";
import { POST } from "../app/api/v1/observation-events:batch/route.ts";
import { redactPressureJournalPayload } from "../lib/observation-ingest/index.ts";

let pg: PgHarness;
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
let nonce = 0;

before(async () => {
  pg = await startPg({ namePrefix: "mf-observation-ingest", poolSize: 8 });
  const pair = generateKeyPairSync("ed25519");
  privateKey = pair.privateKey;
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_ingest_a','ingest-a','Ingest A','local'), ('ws_ingest_b','ingest-b','Ingest B','local');
    INSERT INTO gateway_installation (id, workspace_id, name, public_key) VALUES
      ('inst_ingest_a','ws_ingest_a','Ingest A', decode('${pair.publicKey.export({ format: "der", type: "spki" }).toString("hex")}', 'hex')),
      ('inst_ingest_b','ws_ingest_b','Ingest B', decode('${generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("hex")}', 'hex'));
  `);
  process.env.DATABASE_URL = pg.url;
}, { timeout: 180_000 });
after(async () => { await pg?.stop(); });

const terminal = (traceId = "trace_ingest_complete") => ({
  traceId, kind: "terminal", seq: 2, occurredAt: "2026-07-25T01:00:02.000Z", profileId: "public_app",
  keyId: null, routeId: "route_a", offeringId: "offer_a", status: 200, reasonCodes: ["PROVIDER_TIMEOUT"],
  usage: { inputTokens: 100, outputTokens: 25 }, price: { inputPerMtokMicroUsd: "1000000", outputPerMtokMicroUsd: "2000000" }, priceRevisionId: "price_a", budgetAccountId: null,
});
const accepted = (traceId = "trace_ingest_complete") => ({
  traceId, kind: "accepted", seq: 1, occurredAt: "2026-07-25T01:00:01.000Z", profileId: "public_app",
  keyId: null, routeId: "route_a", offeringId: null, status: null, reasonCodes: [],
});

function signedRequest(body: unknown): Request {
  const encoded = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const nonceValue = `nonce-observation-ingest-${String(++nonce).padStart(3, "0")}-entropy`;
  const input = installationRequestSigningInput({ installationId: "inst_ingest_a", timestamp, nonce: nonceValue, method: "POST", pathname: "/api/v1/observation-events:batch", query: "", bodyHash: createHash("sha256").update(encoded).digest("base64url") });
  return new Request("https://control.example.com/api/v1/observation-events:batch", { method: "POST", body: encoded, headers: { "content-type": "application/json", "x-manifold-installation-id": "inst_ingest_a", "x-manifold-timestamp": timestamp, "x-manifold-nonce": nonceValue, "x-manifold-signature": sign(null, input, privateKey).toString("base64") } });
}

function traceForPressureSample(sampledIn: boolean): string {
  for (let index = 0; index < 10_000; index += 1) {
    const traceId = `trace_pressure_high_${sampledIn ? "in" : "out"}_${index}`;
    const bucket = createHash("sha256").update(traceId).digest().readUIntBE(0, 6) / 2 ** 48;
    if ((bucket < 0.1) === sampledIn) return traceId;
  }
  throw new Error("failed to derive deterministic pressure sample trace");
}

test("signed installation batch derives identity, journals rich events, projects money once, and advances checkpoint", async () => {
  const response = await POST(signedRequest({ events: [accepted(), terminal()] }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 2, projected: 1 });
  const journal = await pg.sql<{ workspace_id: string; producer_id: string; installation_id: string; kind: string; payload: { tokens?: { inputTokens: string } } }[]>`SELECT workspace_id, producer_id, installation_id, kind, payload FROM observation_event WHERE trace_id = 'trace_ingest_complete' ORDER BY seq`;
  assert.equal(journal.length, 2);
  assert.deepEqual(journal.map((row) => [row.workspace_id, row.producer_id, row.installation_id]), [["ws_ingest_a", "inst_ingest_a", "inst_ingest_a"], ["ws_ingest_a", "inst_ingest_a", "inst_ingest_a"]]);
  assert.equal(journal[1]?.payload.tokens?.inputTokens, "100");
  const observation = await pg.sql<{ status: string; input_tokens: string; cost_microusd: string; reason_codes: string[] }[]>`SELECT status, input_tokens, cost_microusd, reason_codes FROM observation WHERE trace_id = 'trace_ingest_complete'`;
  assert.deepEqual([...observation], [{ status: "timeout", input_tokens: "100", cost_microusd: "150", reason_codes: ["PROVIDER_TIMEOUT"] }]);
  assert.equal((await pg.sql`SELECT * FROM usage_record WHERE trace_id = 'trace_ingest_complete'`).length, 1);
  assert.equal((await pg.sql`SELECT * FROM cost_ledger WHERE trace_id = 'trace_ingest_complete'`).length, 1);
  const checkpoint = await pg.sql<{ projection: string; last_event_seq: string; lag_seconds: number }[]>`SELECT projection, last_event_seq, lag_seconds FROM projection_checkpoint WHERE workspace_id = 'ws_ingest_a'`;
  assert.deepEqual([...checkpoint], [{ projection: "observation_reducer", last_event_seq: "2", lag_seconds: 0 }]);

  const replay = await POST(signedRequest({ events: [accepted(), terminal()] }));
  assert.equal(replay.status, 202);
  assert.equal((await pg.sql`SELECT * FROM observation_event WHERE trace_id = 'trace_ingest_complete'`).length, 2, "at-least-once replay must not append duplicate events");
  assert.equal((await pg.sql`SELECT * FROM cost_ledger WHERE trace_id = 'trace_ingest_complete'`).length, 1, "money projection must remain deduplicated");
});

test("batch size and caller-supplied tenant or producer fields are rejected before persistence", async () => {
  const tooLarge = await POST(signedRequest({ events: Array.from({ length: 101 }, (_, index) => accepted(`trace_too_large_${index}`)) }));
  assert.equal(tooLarge.status, 422);
  assert.deepEqual((await tooLarge.json()).error.reason_codes, ["OBSERVATION_INGEST_BATCH_TOO_LARGE"]);
  const forged = await POST(signedRequest({ workspaceId: "ws_ingest_b", events: [{ ...accepted("trace_forged"), producerId: "inst_ingest_b" }] }));
  assert.equal(forged.status, 422);
  assert.deepEqual((await forged.json()).error.reason_codes, ["OBSERVATION_INGEST_CALLER_IDENTITY_FORBIDDEN"]);
  assert.equal((await pg.sql`SELECT * FROM observation_event WHERE trace_id IN ('trace_forged', 'trace_too_large_0')`).length, 0);

  const malformedCapture = await POST(signedRequest({ events: [{
    ...terminal("trace_capture_unknown"),
    capture: { mode: "full", bytes: 0, unknown: true },
  }] }));
  assert.equal(malformedCapture.status, 422, "capture envelope rejects unknown fields");
  const oversizedCapture = await POST(signedRequest({ events: [{
    ...terminal("trace_capture_oversized"),
    capture: { mode: "full", bytes: 4_096, request: { text: "x".repeat(4_100) } },
  }] }));
  assert.equal(oversizedCapture.status, 422, "capture envelope has a strict transport byte cap");
});

test("a signed installation cannot select another tenant through event fields", async () => {
  const response = await POST(signedRequest({ events: [{ ...terminal("trace_cross_tenant"), workspace_id: "ws_ingest_b", installation_id: "inst_ingest_b" }] }));
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).error.reason_codes, ["OBSERVATION_INGEST_CALLER_IDENTITY_FORBIDDEN"]);
  assert.equal((await pg.sql`SELECT * FROM observation_event WHERE trace_id = 'trace_cross_tenant'`).length, 0);
  assert.equal((await pg.sql`SELECT * FROM observation_event WHERE workspace_id = 'ws_ingest_b'`).length, 0);
});

test("provider attempts require immutable health attribution and preserve it in the journal", async () => {
  const missingIdentity = await POST(signedRequest({ events: [{
    ...accepted("trace_health_missing"), kind: "provider_attempt", offeringId: "offer_a", status: 503,
    reasonCodes: ["PROVIDER_HTTP_5XX"],
  }] }));
  assert.equal(missingIdentity.status, 422);

  const response = await POST(signedRequest({ events: [{
    ...accepted("trace_health_identity"), kind: "provider_attempt", offeringId: "offer_a", status: 503,
    reasonCodes: ["PROVIDER_HTTP_5XX"], targetId: "target_a", routeRevisionId: "route_revision_a",
    snapshotRevision: "snapshot_revision_a", attemptOutcome: "transient_failure",
  }] }));
  assert.equal(response.status, 202);
  const [journal] = await pg.sql<{ payload: { targetId?: string; routeRevisionId?: string; snapshotRevision?: string; outcome?: string } }[]>`
    SELECT payload FROM observation_event WHERE trace_id = 'trace_health_identity'`;
  assert.deepEqual(journal?.payload, {
    provider: "offer_a", offeringId: "offer_a", httpStatus: 503, reasonCodes: ["PROVIDER_HTTP_5XX"],
    targetId: "target_a", routeRevisionId: "route_revision_a", snapshotRevision: "snapshot_revision_a",
    outcome: "transient_failure",
  });
});

test("persisted storage pressure deterministically samples detail, sheds at critical, and recovery restores journal writes", async () => {
  await pg.sql`INSERT INTO storage_pressure_state (workspace_id, tier, capture_mode, payload_sample_rate, journal_mode, trigger_compaction, compact_every_measure, block_non_essential_growth, measured_at)
    VALUES ('ws_ingest_a', 'warning', 'full', 0, 'full', true, false, false, now())`;
  const warning = await POST(signedRequest({ events: [accepted("trace_pressure_sampled"), terminal("trace_pressure_sampled")] }));
  assert.equal(warning.status, 202);
  const sampled = await pg.sql<{ payload: { reasonCodes?: string[] } }[]>`SELECT payload FROM observation_event WHERE trace_id='trace_pressure_sampled' ORDER BY seq`;
  assert.ok(sampled.every((event) => event.payload.reasonCodes?.includes("STORAGE_SHED_SAMPLED")), "sampled-out traces retain metadata and a durable explanation");

  await pg.sql`INSERT INTO storage_pressure_state (workspace_id, tier, capture_mode, payload_sample_rate, journal_mode, trigger_compaction, compact_every_measure, block_non_essential_growth, measured_at)
    VALUES ('ws_ingest_a', 'high', 'redacted', 0.1, 'full', true, true, false, now())
    ON CONFLICT (workspace_id) DO UPDATE SET tier=EXCLUDED.tier, capture_mode=EXCLUDED.capture_mode, payload_sample_rate=EXCLUDED.payload_sample_rate, journal_mode=EXCLUDED.journal_mode, trigger_compaction=EXCLUDED.trigger_compaction, compact_every_measure=EXCLUDED.compact_every_measure, block_non_essential_growth=EXCLUDED.block_non_essential_growth, measured_at=EXCLUDED.measured_at`;
  const sampledInTrace = traceForPressureSample(true);
  const sampledIn = await POST(signedRequest({ events: [
    accepted(sampledInTrace),
    { ...terminal(sampledInTrace), capture: { mode: "full", bytes: 181, request: { prompt: "safe prompt", authorization: "Bearer pressure-secret-should-never-persist" }, response: { answer: "safe response", apiKey: "pressure-api-key-should-never-persist", diagnostic: "Bearer pressure-value-should-never-persist" } } },
  ] }));
  assert.equal(sampledIn.status, 202);
  const [retained] = await pg.sql<{ capture_ref: { bytes: number; redacted: boolean; truncated: boolean } }[]>`
    SELECT capture_ref FROM observation WHERE trace_id = ${sampledInTrace}`;
  assert.equal(retained?.capture_ref.redacted, true);
  assert.ok(retained?.capture_ref.bytes <= 1_024, "high-pressure retained capture has the strict reduced cap");
  assert.equal(retained?.capture_ref.truncated, false);
  const retainedText = JSON.stringify(retained?.capture_ref);
  assert.doesNotMatch(retainedText, /pressure-(?:secret|api-key|value)-should-never-persist/);
  const trustedPayload = redactPressureJournalPayload({ capture: { mode: "full", bytes: 0, request: { authorization: "Bearer pressure-secret-should-never-persist", prompt: "safe prompt" }, response: { apiKey: "pressure-api-key-should-never-persist", diagnostic: "Bearer pressure-value-should-never-persist", text: "x".repeat(2_048) } } });
  const redactedText = JSON.stringify(trustedPayload.capture);
  assert.ok(Buffer.byteLength(redactedText, "utf8") <= 1_024);
  assert.doesNotMatch(redactedText, /pressure-(?:secret|api-key|value)-should-never-persist/);
  assert.match(redactedText, /\[REDACTED\]/);

  const sampledOutTrace = traceForPressureSample(false);
  const sampledOut = await POST(signedRequest({ events: [
    accepted(sampledOutTrace),
    terminal(sampledOutTrace),
  ] }));
  assert.equal(sampledOut.status, 202);
  const sampledOutEvents = await pg.sql<{ payload: { reasonCodes?: string[] } }[]>`SELECT payload FROM observation_event WHERE trace_id = ${sampledOutTrace} ORDER BY seq`;
  assert.ok(sampledOutEvents.every((event) => event.payload.reasonCodes?.includes("STORAGE_SHED_SAMPLED")));
  const [sampledOutObservation] = await pg.sql<{ capture_ref: unknown }[]>`SELECT capture_ref FROM observation WHERE trace_id = ${sampledOutTrace}`;
  assert.equal(sampledOutObservation?.capture_ref, null, "sampled-out high-pressure traces retain metadata only");

  await pg.sql`INSERT INTO storage_pressure_state (workspace_id, tier, capture_mode, payload_sample_rate, journal_mode, trigger_compaction, compact_every_measure, block_non_essential_growth, measured_at)
    VALUES ('ws_ingest_a', 'critical', 'metadata', 0, 'full', true, true, true, now())
    ON CONFLICT (workspace_id) DO UPDATE SET tier=EXCLUDED.tier, capture_mode=EXCLUDED.capture_mode, payload_sample_rate=EXCLUDED.payload_sample_rate, journal_mode=EXCLUDED.journal_mode, trigger_compaction=EXCLUDED.trigger_compaction, compact_every_measure=EXCLUDED.compact_every_measure, block_non_essential_growth=EXCLUDED.block_non_essential_growth, measured_at=EXCLUDED.measured_at`;
  const critical = await POST(signedRequest({ events: [accepted("trace_pressure_critical"), terminal("trace_pressure_critical")] }));
  assert.equal(critical.status, 202);
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM observation_event WHERE trace_id='trace_pressure_critical'`)[0]?.count, 2);
  const criticalReasons = await pg.sql<{ payload: { reasonCodes?: string[] } }[]>`SELECT payload FROM observation_event WHERE trace_id='trace_pressure_critical' ORDER BY seq`;
  assert.ok(criticalReasons.every((event) => event.payload.reasonCodes?.includes("STORAGE_EMERGENCY_SHED")));
  const criticalCapture = await pg.sql`SELECT capture_ref FROM observation WHERE trace_id='trace_pressure_critical'`;
  assert.equal(criticalCapture[0]?.capture_ref, null, "critical persists metadata/usage, never a capture payload");

  await pg.sql`UPDATE storage_pressure_state SET tier='emergency', capture_mode='none', journal_mode='aggregate_only', updated_at=now() WHERE workspace_id='ws_ingest_a'`;
  const emergency = await POST(signedRequest({ events: [accepted("trace_pressure_emergency"), terminal("trace_pressure_emergency")] }));
  assert.equal(emergency.status, 202);
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM observation_event WHERE trace_id='trace_pressure_emergency'`)[0]?.count, 0, "emergency drops new raw journal detail");
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM usage_record WHERE trace_id='trace_pressure_emergency'`)[0]?.count, 1, "aggregate usage remains durable");
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM cost_ledger WHERE trace_id='trace_pressure_emergency'`)[0]?.count, 1, "cost truth remains durable");

  await pg.sql`UPDATE storage_pressure_state SET tier='normal', capture_mode='full', payload_sample_rate=1, journal_mode='full', trigger_compaction=false, compact_every_measure=false, block_non_essential_growth=false, updated_at=now() WHERE workspace_id='ws_ingest_a'`;
  const recovered = await POST(signedRequest({ events: [accepted("trace_pressure_recovered"), terminal("trace_pressure_recovered")] }));
  assert.equal(recovered.status, 202);
  assert.equal((await pg.sql`SELECT count(*)::int AS count FROM observation_event WHERE trace_id='trace_pressure_recovered'`)[0]?.count, 2, "recovery restores standard journal capture");
});
