// END-TO-END policy enforcement over a REAL Postgres 16 (SPEC §6.6, §7.5, §11, §16.3).
//
// This is the whole point of the config→gateway policy seam: an OPERATOR writes a DB entitlement
// (a DENY on canonical model M, plus a max_tokens reject constraint), `config.buildSnapshot` emits
// it, and gateway-core `handleRequest` ENFORCES it — with NO inline policy and NO hand-built
// snapshot. The chain proven here is:
//
//   operator DB (model_entitlement / request_constraint, bound to a profile's
//   gateway_policy_revision)  →  config.assembleSnapshot  →  snapshot.policies (EVALUATOR shape)
//   →  gateway-core.enforceRequest → gateway-policy.evaluate  →  403 before any provider dispatch.
//
// Spends ZERO external tokens: an in-memory counting fetcher stands in for the provider, and the
// load-bearing property on a deny is "upstream call count 0" (a deny actually denies). An allowed
// model on the SAME policy dispatches (count 1) — so we prove the policy is real, not deny-all.
//
// Container/migration lifecycle is the shared throwaway-Postgres harness (docker-run postgres:16,
// apply every migration, superuser driver pool), reused from the database + config-snapshot suites.
//
// BEFORE the emission fix (config emitted the transport ConfigPolicy — entitlementIndex + string
// bounds — with NO `modelEntitlements`), this suite FAILS: the built snapshot carries no evaluator
// policy, so the operator's DB deny never reaches the gateway. AFTER the fix it PASSES.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import type { Database } from "@manifold/database";
import { buildSnapshot } from "@manifold/config";
import type { GatewayContext } from "@manifold/gateway-core";
import { handleRequest } from "@manifold/gateway-core";
import type { Fetcher, Snapshot, SnapshotTarget } from "@manifold/ports";
import { FakeCrypto, FakeIngestSink, FixedClock, keyedHashHex } from "@manifold/ports/testing";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

type Sql = ReturnType<typeof postgres>;

// ── shared crypto + key material (the SAME FakeCrypto the gateway authenticates with) ──────────
const crypto = new FakeCrypto();
const pepper = new TextEncoder().encode("e2e-pepper");
const VALID_KEY = "sk-e2e-operator-key";
// hex(HMAC(pepper, VALID_KEY)) — exactly what buildKeysSection stores as the snapshot key AND what
// authenticate() recomputes from the presented Bearer token. We seed the DB `keyed_hash` with the
// SAME bytes so the built snapshot's key authenticates the request.
const keyHashHex = await keyedHashHex(crypto, pepper, VALID_KEY);

const INSTALLATION = "inst_e2e";
const PROFILE = "prof_e2e";
const HOST = "e2e.local";
const DENIED_MODEL = "cm_denied"; // canonical model M (DB row) the operator DENIES
const ALLOWED_MODEL = "gpt-4o-open"; // matched by the wildcard `all/allow` grant, never denied

// ── Fix 3 (team-scoped governance) key material + scenario ids ──────────────────────────────────
const TEAM_KEY = "sk-e2e-team-key";
const teamKeyHashHex = await keyedHashHex(crypto, pepper, TEAM_KEY);
const INST_TEAM = "inst_team";
const HOST_TEAM = "team.local";
const TEAM = "team_x"; // the team the key belongs to AND the team-scoped deny targets
const TEAM_BLOCKED = "team-blocked-model"; // denied for TEAM by a subject_kind='team' entitlement
const TEAM_OK = "team-ok-model"; // not team-denied ⇒ allowed by the all/allow grant

let pg: PgHarness;
let sql: Sql;
let db: Database;

before(async () => {
  pg = await startPg({ namePrefix: "mf-policy-e2e" });
  sql = pg.sql;
  db = { $client: sql } as unknown as Database;

  // One workspace, one canonical model (the DENY target), one offering + credential + DEK, an
  // installation + ingress profile BOUND to a policy revision, a route (so an allowed model can
  // dispatch), and the governance rows: an allow-all grant, a DENY on the canonical model, and a
  // max_tokens reject constraint. The credential allowlist contains api.openai.com (the resolved
  // base URL host) so the target survives assembleSnapshot's fail-closed egress filter.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws_e2e','ws-e2e','E2E Workspace','local');

    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('${DENIED_MODEL}','denied-model','Denied Model','cat1');

    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('dek_e2e','ws_e2e','\\xdeadbeef','kek1','active');

    INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision,
       capabilities, catalog_revision) VALUES
      ('off_e2e','${DENIED_MODEL}','openai','denied-model','["chat"]','ar1','{}','cat1');

    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status) VALUES
      ('cred_e2e','ws_e2e','openai','openai key','\\xc0ffee','dek_e2e',NULL,'["api.openai.com"]','valid');

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('${INSTALLATION}','ws_e2e','inst-e2e','{"kind":"test"}');

    -- Governance: a policy + one revision the profile binds to.
    INSERT INTO gateway_policy (id, workspace_id, name) VALUES
      ('pol_e2e','ws_e2e','e2e-policy');
    INSERT INTO gateway_policy_revision (id, workspace_id, policy_id, content_hash) VALUES
      ('polrev_e2e','ws_e2e','pol_e2e','sha256:polrev');
    UPDATE gateway_policy SET active_revision_id = 'polrev_e2e' WHERE id = 'pol_e2e';

    -- The operator's entitlements: allow everything, then DENY canonical model M (deny wins).
    INSERT INTO model_entitlement
      (id, workspace_id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect) VALUES
      ('ent_allow','ws_e2e','polrev_e2e','all',NULL,NULL,NULL,'allow'),
      ('ent_deny','ws_e2e','polrev_e2e','all',NULL,'${DENIED_MODEL}',NULL,'deny');

    -- A NUMERIC reject ceiling: max_tokens > 1000 ⇒ POLICY_PARAM_REJECTED (proves numeric bounds).
    INSERT INTO request_constraint
      (id, workspace_id, policy_revision_id, param, max_value, min_value, on_violation) VALUES
      ('rc_maxtok','ws_e2e','polrev_e2e','max_tokens',1000,NULL,'reject');

    -- Ingress profile BOUND to the policy revision.
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config, policy_revision_id) VALUES
      ('${PROFILE}','ws_e2e','${INSTALLATION}','${HOST}','public_app','{}','polrev_e2e');

    -- A chat route (→ /v1/chat/completions) so an ALLOWED model actually dispatches.
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_e2e','ws_e2e','${INSTALLATION}','chat-route','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_e2e','ws_e2e','route_e2e','ordered','{}','{"overall_ms":30000}','sha256:reve2e');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_e2e','ws_e2e','rev_e2e','cred_e2e','off_e2e','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_e2e' WHERE id = 'route_e2e';

    -- The virtual key on this profile. keyed_hash = hex(HMAC(pepper, VALID_KEY)) computed by the
    -- SAME FakeCrypto the gateway authenticates with, so the built snapshot key authenticates.
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids) VALUES
      ('vk_e2e','ws_e2e','${PROFILE}','sk-e2e','\\x${keyHashHex}','[]','[]');

    -- ── Fix 3: team-scoped governance end-to-end. A key on team_x, and a policy that allows all
    --    models EXCEPT one denied specifically for team_x. Pre-fix, config never SELECTed/emitted
    --    virtual_key.team_id → SnapshotKey.team, so the team-scoped deny matched NO key and the
    --    request was (wrongly) allowed. The key must carry its team facet for the deny to bind.
    INSERT INTO team (id, workspace_id, slug, name) VALUES ('team_x','ws_e2e','team-x','Team X');

    -- The canonical model the team-scoped deny targets (model_entitlement.canonical_model_id FK).
    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('${TEAM_BLOCKED}','team-blocked','Team Blocked Model','cat1');

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('${INST_TEAM}','ws_e2e','inst-team','{"kind":"test"}');

    INSERT INTO gateway_policy (id, workspace_id, name) VALUES ('pol_team','ws_e2e','team-policy');
    INSERT INTO gateway_policy_revision (id, workspace_id, policy_id, content_hash) VALUES
      ('polrev_team','ws_e2e','pol_team','sha256:polteam');
    UPDATE gateway_policy SET active_revision_id = 'polrev_team' WHERE id = 'pol_team';

    INSERT INTO model_entitlement
      (id, workspace_id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect) VALUES
      ('ent_team_allow','ws_e2e','polrev_team','all',NULL,NULL,NULL,'allow'),
      ('ent_team_deny','ws_e2e','polrev_team','team','${TEAM}','${TEAM_BLOCKED}',NULL,'deny');

    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config, policy_revision_id) VALUES
      ('prof_team','ws_e2e','${INST_TEAM}','${HOST_TEAM}','public_app','{}','polrev_team');

    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_team','ws_e2e','${INST_TEAM}','team-chat','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_team','ws_e2e','route_team','ordered','{}','{"overall_ms":30000}','sha256:revteam');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_team','ws_e2e','rev_team','cred_e2e','off_e2e','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_team' WHERE id = 'route_team';

    -- The team key: keyed_hash from the SAME FakeCrypto; team_id = team_x (the fix emits this).
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, team_id) VALUES
      ('vk_team','ws_e2e','prof_team','sk-team','\\x${teamKeyHashHex}','[]','[]','${TEAM}');
  `);
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
    // SKELETON secret resolution (§14.3): the passthrough path reads a stand-in secret; the
    // enforcement gate runs BEFORE dispatch so a deny never gets here anyway.
    resolveSecret: async (_t: SnapshotTarget) => "PROVIDER-SECRET",
  };
}

function req(body: unknown): Request {
  return new Request(`http://${HOST}/v1/chat/completions`, {
    method: "POST",
    headers: { host: HOST, authorization: `Bearer ${VALID_KEY}` },
    body: JSON.stringify(body),
  });
}

/** A ctx for an arbitrary installation (the team scenario runs under a second installation). */
function ctxFor(installationId: string, snapshot: Snapshot, fetcher: Fetcher): GatewayContext {
  return { ...makeCtx(snapshot, fetcher), installationId };
}

/** A chat request to an arbitrary host with an arbitrary bearer key. */
function reqTo(host: string, key: string, body: unknown): Request {
  return new Request(`http://${host}/v1/chat/completions`, {
    method: "POST",
    headers: { host, authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

// ── (0) REAL EMISSION — the built snapshot carries the operator's DENY in the evaluator shape ──
test("buildSnapshot emits the operator DB entitlements in the evaluator (SnapshotPolicyRevision) shape", async () => {
  const snap = await buildSnapshot(db, INSTALLATION);

  // The profile is keyed by its trusted host and references the policy revision the gateway reads.
  const profile = snap.profiles[HOST];
  assert.ok(profile, `profile for host ${HOST} must be present`);
  assert.equal(profile.policyRevision, "polrev_e2e", "profile binds the operator's policy revision");

  // snapshot.policies is keyed EXACTLY how enforce.ts looks it up: profile.policyRevision.
  const policy = snap.policies?.[profile.policyRevision!];
  assert.ok(policy, "snapshot.policies must carry the bound policy revision");

  // EVALUATOR shape (the whole fix): modelEntitlements + numeric requestConstraints, NOT the old
  // transport-only ConfigPolicy. On pre-fix code `modelEntitlements` is undefined and this fails.
  assert.ok(Array.isArray(policy.modelEntitlements), "policy carries modelEntitlements (evaluator shape)");
  const deny = policy.modelEntitlements.find(
    (e) => e.effect === "deny" && e.canonicalModelId === DENIED_MODEL,
  );
  assert.ok(deny, `the operator's DENY on ${DENIED_MODEL} must be emitted; got ${JSON.stringify(policy.modelEntitlements)}`);

  // The reject constraint's bound must be a NUMBER (numeric column parsed), not a string — the
  // evaluator compares `value > maxValue` numerically.
  const rc = policy.requestConstraints.find((c) => c.param === "max_tokens");
  assert.ok(rc, "the max_tokens constraint must be emitted");
  assert.equal(typeof rc.maxValue, "number", "constraint bound must be numeric");
  assert.equal(rc.maxValue, 1000);
});

// ── (1) THE DENY DENIES — DB-denied model ⇒ 403 POLICY_MODEL_DENIED, upstream NEVER called ─────
test("config-built policy DENIES model M end-to-end ⇒ 403 POLICY_MODEL_DENIED, 0 upstream calls", async () => {
  const snap = await buildSnapshot(db, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const res = await handleRequest(ctx, req({ model: DENIED_MODEL, max_tokens: 10 }));

  assert.equal(res.status, 403, "the DB-denied model must be rejected");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "POLICY_MODEL_DENIED", "the deny reason reaches the client");
  assert.equal(fetcher.count, 0, "a deny must NEVER reach the provider");
});

// ── (2) THE POLICY IS REAL — an allowed model on the SAME policy dispatches (count 1) ──────────
test("config-built policy ALLOWS a non-denied model end-to-end ⇒ dispatched, 1 upstream call", async () => {
  const snap = await buildSnapshot(db, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const res = await handleRequest(ctx, req({ model: ALLOWED_MODEL, max_tokens: 10 }));

  assert.equal(res.status, 200, "an allowed model on the same policy proceeds to dispatch");
  assert.equal(fetcher.count, 1, "the allowed request WAS dispatched to the provider exactly once");
});

// ── (3) NUMERIC BOUND ENFORCED — allowed model but max_tokens over the reject ceiling ⇒ 403 ────
test("config-built numeric reject constraint ⇒ over-ceiling max_tokens is 403 POLICY_PARAM_REJECTED, 0 upstream calls", async () => {
  const snap = await buildSnapshot(db, INSTALLATION);
  const fetcher = new CountingFetcher();
  const ctx = makeCtx(snap, fetcher);

  const res = await handleRequest(ctx, req({ model: ALLOWED_MODEL, max_tokens: 5000 }));

  assert.equal(res.status, 403, "max_tokens over the reject ceiling is denied");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "POLICY_PARAM_REJECTED", "the numeric reject constraint fired");
  assert.equal(fetcher.count, 0, "a rejected request must NEVER reach the provider");
});

// ── (4) TEAM GOVERNANCE — a subject_kind='team' deny actually blocks a key on that team ─────────
test("config-built team-scoped deny BLOCKS a key on that team ⇒ 403 POLICY_MODEL_DENIED, 0 upstream calls", async () => {
  const snap = await buildSnapshot(db, INST_TEAM);

  // The key must carry its team facet, or the team-scoped deny can never match (the whole fix). On
  // pre-fix code `SnapshotKey.team` is undefined here and the request below would (wrongly) dispatch.
  const teamKey = Object.values(snap.keys).find((k) => k.id === "vk_team");
  assert.ok(teamKey, "the team key must be in the snapshot");
  assert.equal(teamKey.team, TEAM, "buildSnapshot must emit virtual_key.team_id as SnapshotKey.team");

  const fetcher = new CountingFetcher();
  const ctx = ctxFor(INST_TEAM, snap, fetcher);
  const res = await handleRequest(ctx, reqTo(HOST_TEAM, TEAM_KEY, { model: TEAM_BLOCKED, max_tokens: 10 }));

  assert.equal(res.status, 403, "the team-denied model must be blocked for a key on that team");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "POLICY_MODEL_DENIED", "the team deny reaches the client");
  assert.equal(fetcher.count, 0, "a team deny must NEVER reach the provider");
});

// ── (5) THE TEAM POLICY IS REAL — a non-denied model on the SAME team key dispatches (not deny-all) ──
test("config-built team policy ALLOWS a non-team-denied model for the same team key ⇒ dispatched, 1 upstream call", async () => {
  const snap = await buildSnapshot(db, INST_TEAM);
  const fetcher = new CountingFetcher();
  const ctx = ctxFor(INST_TEAM, snap, fetcher);
  const res = await handleRequest(ctx, reqTo(HOST_TEAM, TEAM_KEY, { model: TEAM_OK, max_tokens: 10 }));

  assert.equal(res.status, 200, "a non-team-denied model dispatches (proves the team policy is not deny-all)");
  assert.equal(fetcher.count, 1, "the allowed request WAS dispatched exactly once");
});
