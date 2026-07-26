// The gateway's observation transaction is the only admission boundary for
// provider-attempt health facts.  This suite uses the production RLS role to
// prove it accepts only facts still authorized by the active config topology.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import type { Sql } from "@manifold/database";
import type { HotPathObservationEvent } from "@manifold/ports";
import { ingestTrace } from "../src/observe.ts";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { seedMinimalGatewayTenant } from "../../../packages/database/test/seed-gateway-tenant.ts";

const APP_PASSWORD = "CHANGEME_APP_PASSWORD";
const WORKSPACE_A = "ws_hfa";
const INSTALLATION_A = "inst_hfa";
const WORKSPACE_B = "ws_hfb";
const INSTALLATION_B = "inst_hfb";
const SNAPSHOT_A = "cfg_hfa";
const SNAPSHOT_B = "cfg_hfb";

let pg: PgHarness;
let appSql: Sql;

before(async () => {
  pg = await startPg({ namePrefix: "mf-target-health-ingest" });
  pg.psql(`
    ${seedMinimalGatewayTenant({ prefix: "hfa", hostname: "hfa.local", keyHashHex: "aa".repeat(32) })}
    ${seedMinimalGatewayTenant({ prefix: "hfb", hostname: "hfb.local", keyHashHex: "bb".repeat(32) })}

    INSERT INTO gateway_config_revision
      (id, workspace_id, installation_id, content_hash, snapshot, status) VALUES
      ('${SNAPSHOT_A}', '${WORKSPACE_A}', '${INSTALLATION_A}', 'sha256:cfg-hfa', '{}'::jsonb, 'active'),
      ('${SNAPSHOT_B}', '${WORKSPACE_B}', '${INSTALLATION_B}', 'sha256:cfg-hfb', '{}'::jsonb, 'active'),
      ('cfg_hfa_stale', '${WORKSPACE_A}', '${INSTALLATION_A}', 'sha256:cfg-hfa-stale', '{}'::jsonb, 'superseded');

    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_hfa_inactive', '${WORKSPACE_A}', 'route_hfa', 'ordered', '{}'::jsonb, '{"overall_ms":30000}'::jsonb, 'sha256:rev-hfa-inactive');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_hfa_inactive', '${WORKSPACE_A}', 'rev_hfa_inactive', 'cred_hfa', 'off_hfa', 'ar1', NULL);
  `);
  const appUrl = pg.url.replace("postgres:postgres@", `manifold_app:${APP_PASSWORD}@`);
  appSql = postgres(appUrl, { max: 4, prepare: false, onnotice: () => {} }) as unknown as Sql;
}, { timeout: 180_000 });

after(async () => {
  if (appSql) await (appSql as unknown as postgres.Sql).end({ timeout: 5 });
  if (pg) await pg.stop();
});

function attempt(
  traceId: string,
  seq: number,
  fields: Pick<HotPathObservationEvent, "targetId" | "routeRevisionId" | "snapshotRevision">,
): HotPathObservationEvent {
  return {
    traceId,
    seq,
    kind: "provider_attempt",
    occurredAt: "2026-07-25T00:00:00.000Z",
    profileId: "prof_hfa",
    keyId: "vk_hfa",
    routeId: "route_hfa",
    offeringId: "off_hfa",
    status: 200,
    reasonCodes: [],
    ...fields,
    attemptOutcome: "success",
  };
}

function events(traceId: string): HotPathObservationEvent[] {
  const common = {
    traceId,
    occurredAt: "2026-07-25T00:00:00.000Z",
    profileId: "prof_hfa",
    keyId: "vk_hfa",
    routeId: "route_hfa",
    offeringId: "off_hfa",
    reasonCodes: [],
  };
  return [
    { ...common, seq: 0, kind: "accepted", status: null },
    // The active target, active route revision, and active installation snapshot are admitted.
    attempt(traceId, 1, { targetId: "tg_hfa", routeRevisionId: "rev_hfa", snapshotRevision: SNAPSHOT_A }),
    // All three remain ordinary billing telemetry but cannot alter health.
    attempt(traceId, 2, { targetId: "tg_hfa", routeRevisionId: "rev_hfa", snapshotRevision: "cfg_hfa_stale" }),
    attempt(traceId, 3, { targetId: "tg_hfa_inactive", routeRevisionId: "rev_hfa_inactive", snapshotRevision: SNAPSHOT_A }),
    attempt(traceId, 4, { targetId: "tg_hfb", routeRevisionId: "rev_hfb", snapshotRevision: SNAPSHOT_B }),
    { ...common, seq: 5, kind: "terminal", status: 200 },
  ];
}

test("RLS ingest atomically admits one active health fact, coalesces its rollup, and ignores stale or foreign attribution", async () => {
  const traceId = "01K0HEALTHINGEST00000000000";
  const input = { sql: appSql, events: events(traceId), workspaceId: WORKSPACE_A, producerId: INSTALLATION_A };

  await ingestTrace(input);
  await ingestTrace(input); // durable-job redelivery must not append or enqueue again.

  const facts = await pg.sql<{
    source_event_id: string;
    target_id: string;
    route_revision_id: string;
    snapshot_revision_id: string;
    outcome: string;
  }[]>`
    SELECT source_event_id, target_id, route_revision_id, snapshot_revision_id, outcome
    FROM gateway_target_health_observation
    ORDER BY source_event_id
  `;
  assert.deepEqual(Array.from(facts), [{
    source_event_id: `${traceId}:1`, target_id: "tg_hfa", route_revision_id: "rev_hfa",
    snapshot_revision_id: SNAPSHOT_A, outcome: "success",
  }], "only the current installation's active snapshot/revision/target fact is durable");

  const jobs = await pg.sql<{ kind: string; idempotency_key: string; payload: { installationId: string; targetId: string } }[]>`
    SELECT kind, idempotency_key, payload
    FROM job_ledger
    WHERE kind = 'target_health_rollup'
  `;
  assert.deepEqual(Array.from(jobs), [{
    kind: "target_health_rollup",
    idempotency_key: "target_health_rollup:tg_hfa",
    payload: { installationId: INSTALLATION_A, targetId: "tg_hfa" },
  }], "accepted facts create one coalesced rollup job even after redelivery");
});
