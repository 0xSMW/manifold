// Integration regression tests for the @manifold/config snapshot builder + publisher against a
// REAL Postgres 16 (SPEC §7.5, §8.2). Each of these pins a bug the review found in build.ts /
// db.ts / apply.ts; every test FAILS on the pre-fix code and PASSES after the fix.
//
//   1. build.ts SECURITY — a target baseUrl host absent from the credential's allowed_hosts must
//      NOT be auto-allowlisted (credential-exfil: auto-grant → ssrfCheck passes → secret injected
//      on an attacker host). Fail closed: the target is dropped and the bad host appears nowhere.
//   2. build.ts ROUTE-KEY CLOBBER — two same-kind (chat) routes with different public_names must
//      both survive assembleSnapshot; keying by `${profile}:${path}` alone collapses them.
//   3. db.ts readCredential — a revoked credential must not be embedded; its target is dropped.
//   4. apply.ts store.publish ordering — publish must happen AFTER the DB txn commits, so a publish
//      failure can never leave the store pointing at a revision the DB rolled back.
//
// Container/migration lifecycle is the shared throwaway-Postgres harness the database + budget
// attack suites use (packages/database/test/pg-harness.ts): docker-run postgres:16 on a random
// loopback port, apply every migration, hand back a superuser driver pool (RLS-exempt, the
// migration / control-plane seeding path). Teardown in `after` even on failure.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import {
  buildSnapshot,
  plan,
  apply,
  rollback,
  type Approval,
  type ConfigSnapshot,
  type SnapshotPublishStore,
} from "@manifold/config";
import { startPg, type PgHarness } from "../../database/test/pg-harness.ts";

type Sql = ReturnType<typeof postgres>;

let pg: PgHarness;
let sql: Sql;

before(async () => {
  pg = await startPg({ namePrefix: "mf-config-test" });
  sql = pg.sql;

  // One workspace, one canonical model + offering + DEK, four provider credentials (valid /
  // valid-anthropic / valid-but-points-at-evil-host / revoked), and separate installations so a
  // scenario's routes never clobber another's. Routes have a circular FK with their revisions
  // (route.active_revision_id → revision.id, revision.route_id → route.id): insert the route with
  // a NULL active_revision_id, insert the revision + target, then point the route at the revision.
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES
      ('ws1','ws1','Workspace 1','local');

    INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('cm1','gpt-4o','GPT-4o','cat1');

    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('dek1','ws1','\\xdeadbeef','kek1','active');

    INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision,
       capabilities, catalog_revision) VALUES
      ('off1','cm1','openai','gpt-4o','["chat"]','ar1','{"providerIdempotency":"supported"}','cat1');

    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status, revoked_at) VALUES
      ('cred_openai','ws1','openai','openai key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','valid',NULL),
      ('cred_anthropic','ws1','anthropic','anthropic key','\\xc0ffee','dek1',NULL,'["api.anthropic.com"]','valid',NULL),
      ('cred_evilhost','ws1','openai','evil-target key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','valid',NULL),
      ('cred_revoked','ws1','openai','revoked key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','valid',now());

    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_clobber','ws1','inst-clobber','{"kind":"test"}'),
      ('inst_sec','ws1','inst-sec','{"kind":"test"}'),
      ('inst_rev','ws1','inst-rev','{"kind":"test"}'),
      ('inst_apply_ok','ws1','inst-apply-ok','{"kind":"test"}'),
      ('inst_apply_fail','ws1','inst-apply-fail','{"kind":"test"}');

    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_clobber','ws1','inst_clobber','clobber.local','public_app','{}'),
      ('prof_sec','ws1','inst_sec','sec.local','public_app','{}'),
      ('prof_rev','ws1','inst_rev','rev.local','public_app','{}'),
      ('prof_apply_ok','ws1','inst_apply_ok','applyok.local','public_app','{}'),
      ('prof_apply_fail','ws1','inst_apply_fail','applyfail.local','public_app','{}');

    -- routes (active_revision_id filled in after the revisions exist)
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_gpt','ws1','inst_clobber','gpt-4o','chat'),
      ('route_claude','ws1','inst_clobber','claude-3','chat'),
      ('route_evil','ws1','inst_sec','evil-route','chat'),
      ('route_revoked','ws1','inst_rev','revoked-route','chat');

    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_gpt','ws1','route_gpt','ordered','{"provider_idempotency":{"target_id":"tg_gpt","header_name":"idempotency-key"}}','{"overall_ms":30000}','sha256:rgpt'),
      ('rev_claude','ws1','route_claude','ordered','{}','{"overall_ms":30000}','sha256:rcla'),
      ('rev_evil','ws1','route_evil','ordered','{}','{"overall_ms":30000}','sha256:revl'),
      ('rev_revoked','ws1','route_revoked','ordered','{}','{"overall_ms":30000}','sha256:rrev');

    -- targets. route_gpt→cred_openai (host api.openai.com ∈ allowlist), route_claude→cred_anthropic
    -- (api.anthropic.com ∈ allowlist): both are valid and must survive. route_evil aims cred_evilhost
    -- (allowlist ["api.openai.com"]) at base_url https://evil.example (NOT in the allowlist).
    -- route_revoked→cred_revoked (host api.openai.com IS in its allowlist, so ONLY the revoked filter
    -- can drop it — a discriminating test that the drop is due to revocation, not the host check).
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_gpt','ws1','rev_gpt','cred_openai','off1','ar1',NULL),
      ('tg_claude','ws1','rev_claude','cred_anthropic','off1','ar1',NULL),
      ('tg_evil','ws1','rev_evil','cred_evilhost','off1','ar1','https://evil.example'),
      ('tg_revoked','ws1','rev_revoked','cred_revoked','off1','ar1',NULL);

    UPDATE gateway_route SET active_revision_id = 'rev_gpt'     WHERE id = 'route_gpt';
    UPDATE gateway_route SET active_revision_id = 'rev_claude'  WHERE id = 'route_claude';
    UPDATE gateway_route SET active_revision_id = 'rev_evil'    WHERE id = 'route_evil';
    UPDATE gateway_route SET active_revision_id = 'rev_revoked' WHERE id = 'route_revoked';

    -- ── Fix 1 (budgets in the signed content hash): an installation whose only content is a key
    --    referencing an advisory budget account, so buildSnapshot emits a budgets section.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_budget','ws1','inst-budget','{"kind":"test"}');
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_budget','ws1','inst_budget','budget.local','public_app','{}');
    INSERT INTO budget_account
      (id, workspace_id, scope_type, unit, "window", limit_amount, enforcement) VALUES
      ('ba_budget','ws1','key','cost_microusd','monthly',1000000,'advisory');
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
      ('vk_budget','ws1','prof_budget','sk-bud','\\xb0d9','[]','[]','ba_budget');
    -- A REVOKED key on the same profile (F10): keyed_hash hex "dead". It must be filtered OUT of the
    -- built snapshot (revoked_at IS NULL) so it can never authenticate — absent ⇒ AUTH_KEY_UNKNOWN.
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, revoked_at) VALUES
      ('vk_revoked','ws1','prof_budget','sk-rev','\\xdead','[]','[]',now());

    -- ── Fix 2 (offering-scoped entitlement → correct model, not a wildcard): a policy revision with
    --    an offering_id-scoped allow (canonical_model_id NULL). off1's canonical model is cm1.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_ent','ws1','inst-ent','{"kind":"test"}');
    INSERT INTO gateway_policy (id, workspace_id, name) VALUES ('pol_ent','ws1','ent-policy');
    INSERT INTO gateway_policy_revision (id, workspace_id, policy_id, content_hash) VALUES
      ('polrev_ent','ws1','pol_ent','sha256:polent');
    UPDATE gateway_policy SET active_revision_id = 'polrev_ent' WHERE id = 'pol_ent';
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config, policy_revision_id) VALUES
      ('prof_ent','ws1','inst_ent','ent.local','public_app','{}','polrev_ent');
    INSERT INTO model_entitlement
      (id, workspace_id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect) VALUES
      ('ent_off','ws1','polrev_ent','all',NULL,NULL,'off1','allow');

    -- ── Fix 4 (apply() enforces tripwire approval): two DISTINCT-kind routes (chat + embeddings so
    --    they do not clobber), so removing one produces a route_delete tripwire on re-plan.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_tw','ws1','inst-tw','{"kind":"test"}');
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_tw','ws1','inst_tw','tw.local','public_app','{}');
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_tw_chat','ws1','inst_tw','tw-chat','chat'),
      ('route_tw_emb','ws1','inst_tw','tw-emb','embeddings');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_tw_chat','ws1','route_tw_chat','ordered','{}','{"overall_ms":30000}','sha256:rtwc'),
      ('rev_tw_emb','ws1','route_tw_emb','ordered','{}','{"overall_ms":30000}','sha256:rtwe');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_tw_chat','ws1','rev_tw_chat','cred_openai','off1','ar1',NULL),
      ('tg_tw_emb','ws1','rev_tw_emb','cred_openai','off1','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_tw_chat' WHERE id = 'route_tw_chat';
    UPDATE gateway_route SET active_revision_id = 'rev_tw_emb'  WHERE id = 'route_tw_emb';

    -- ── Fix 5 (rollback publishes AFTER commit): one route; two applies produce a superseded + an
    --    active revision to roll back between.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_rb','ws1','inst-rb','{"kind":"test"}');
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_rb','ws1','inst_rb','rb.local','public_app','{}');
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_rb','ws1','inst_rb','rb-chat','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_rb','ws1','route_rb','ordered','{}','{"overall_ms":30000}','sha256:rrb');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url, weight) VALUES
      ('tg_rb','ws1','rev_rb','cred_openai','off1','ar1',NULL,100);
    UPDATE gateway_route SET active_revision_id = 'rev_rb' WHERE id = 'route_rb';

    -- ── Bug fix (db.ts readDek): a credential whose DEK is NOT status='active' (retiring/revoked)
    --    must not ship that DEK's wrapped bytes in the built snapshot.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_dek','ws1','inst-dek','{"kind":"test"}');
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_dek','ws1','inst_dek','dek.local','public_app','{}');
    INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('dek_retiring','ws1','\\xfeedface','kek1','retiring');
    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status, revoked_at) VALUES
      ('cred_dek_retiring','ws1','openai','retiring-dek key','\\xc0ffee','dek_retiring',NULL,'["api.openai.com"]','valid',NULL);
    INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('route_dek','ws1','inst_dek','dek-route','chat');
    INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('rev_dek','ws1','route_dek','ordered','{}','{"overall_ms":30000}','sha256:rdek');
    INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('tg_dek','ws1','rev_dek','cred_dek_retiring','off1','ar1',NULL);
    UPDATE gateway_route SET active_revision_id = 'rev_dek' WHERE id = 'route_dek';

    -- ── Bug fix (plan.ts tripwires): a budget account whose enforcement flips hard -> advisory.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_budget_tw','ws1','inst-budget-tw','{"kind":"test"}');
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config) VALUES
      ('prof_budget_tw','ws1','inst_budget_tw','budgettw.local','public_app','{}');
    INSERT INTO budget_account
      (id, workspace_id, scope_type, unit, "window", limit_amount, enforcement, pricing_catalog_revision_id) VALUES
      ('ba_hard_tw','ws1','key','cost_microusd','monthly',1000000,'hard','pcr_hard_tw');
    INSERT INTO virtual_key
      (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
      ('vk_budget_tw','ws1','prof_budget_tw','sk-budtw','\\xb0da','[]','[]','ba_hard_tw');

    -- ── Bug fix (plan.ts tripwires): removing a deny entitlement (not just allow) is a tripwire.
    INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('inst_deny_tw','ws1','inst-deny-tw','{"kind":"test"}');
    INSERT INTO gateway_policy (id, workspace_id, name) VALUES ('pol_deny_tw','ws1','deny-tw-policy');
    INSERT INTO gateway_policy_revision (id, workspace_id, policy_id, content_hash) VALUES
      ('polrev_deny_tw','ws1','pol_deny_tw','sha256:polrevdenytw');
    UPDATE gateway_policy SET active_revision_id = 'polrev_deny_tw' WHERE id = 'pol_deny_tw';
    INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config, policy_revision_id) VALUES
      ('prof_deny_tw','ws1','inst_deny_tw','denytw.local','public_app','{}','polrev_deny_tw');
    INSERT INTO model_entitlement
      (id, workspace_id, policy_revision_id, subject_kind, subject_ref, canonical_model_id, offering_id, effect) VALUES
      ('ent_deny_tw','ws1','polrev_deny_tw','all',NULL,'cm1',NULL,'deny');
  `);
}, { timeout: 300_000 });

after(async () => {
  if (pg) await pg.stop();
});

/** Flatten every target across every route of a built snapshot. */
function allTargets(snap: ConfigSnapshot) {
  return Object.values(snap.routes).flatMap((r) => r.targets);
}

// ── Bug 2: ROUTE-KEY CLOBBER ────────────────────────────────────────────────
test("build: two same-kind (chat) routes with different public_names both survive (no clobber)", async () => {
  const snap = await buildSnapshot(sql, "inst_clobber");
  const keys = Object.keys(snap.routes);

  // SPEC §7.2 key shape `${profile}:${kind}:${public_name}` keeps the two chat routes distinct.
  const gptKey = "prof_clobber:chat:gpt-4o";
  const claudeKey = "prof_clobber:chat:claude-3";
  assert.ok(snap.routes[gptKey], `expected route key ${gptKey}; got ${JSON.stringify(keys)}`);
  assert.ok(snap.routes[claudeKey], `expected route key ${claudeKey}; got ${JSON.stringify(keys)}`);

  // Both distinct routes present → their credentials both survive (neither clobbered the other).
  assert.notEqual(snap.routes[gptKey].routeId, snap.routes[claudeKey].routeId);
  assert.equal(snap.routes[gptKey].targets[0]?.targetId, "tg_gpt");
  assert.deepEqual(snap.routes[gptKey].retryPolicy?.provider_idempotency, {
    target_id: "tg_gpt",
    header_name: "idempotency-key",
  }, "the signed snapshot must carry the persisted target-scoped retry contract");
  assert.equal(snap.routes[claudeKey].targets[0]?.targetId, "tg_claude");
  assert.equal(snap.routes[gptKey].targets[0]?.credentialId, "cred_openai");
  assert.equal(snap.routes[gptKey].targets[0]?.kekId, "kek1", "new snapshots must project the DEK KEK identity");
  assert.equal(snap.routes[claudeKey].targets[0]?.credentialId, "cred_anthropic");
});

test("build: workspace operator price override wins and is carried into the snapshot", async () => {
  await sql`
    INSERT INTO provider_price_revision
      (id, offering_id, workspace_id, input_per_mtok_microusd, output_per_mtok_microusd, fidelity, content_hash, catalog_revision)
    VALUES ('prc_global_snapshot', 'off1', NULL, 100, 200, 'provider_verified', 'sha256:global-snapshot-price', 'cat1')`;
  await sql`UPDATE provider_model_offering SET active_price_revision_id = 'prc_global_snapshot' WHERE id = 'off1'`;
  await sql`
    INSERT INTO provider_price_revision
      (id, offering_id, workspace_id, input_per_mtok_microusd, output_per_mtok_microusd, fidelity, content_hash)
    VALUES ('prc_override_snapshot', 'off1', 'ws1', 300, 400, 'operator_override', 'sha256:override-snapshot-price')`;
  const snapshot = await buildSnapshot(sql, "inst_clobber");
  const offering = snapshot.offerings.off1;
  assert.ok(offering, "offering must be present in the signed snapshot");
  assert.equal(offering.priceRevisionId, "prc_override_snapshot");
  assert.equal(offering.priceFidelity, "operator_override");
  assert.equal(offering.price?.inputPerMtokMicroUsd, "300");
  assert.equal(offering.price?.outputPerMtokMicroUsd, "400");
});

// ── Bug 1: allowedHosts auto-expand → credential exfil ──────────────────────
test("build: a target baseUrl host absent from the credential allowlist is NOT allowlisted (fail closed)", async () => {
  const snap = await buildSnapshot(sql, "inst_sec");

  // The attacker host must appear in NO target's allowedHosts anywhere in the snapshot.
  for (const t of allTargets(snap)) {
    assert.ok(
      !t.allowedHosts.includes("evil.example"),
      `evil.example must never be auto-allowlisted; got ${JSON.stringify(t.allowedHosts)}`,
    );
  }

  // Fail closed: the misconfigured target (host ∉ credential allow_hosts) is dropped, so the route
  // ships with no target for ssrfCheck to (fail to) guard.
  const evil = snap.routes["prof_sec:chat:evil-route"];
  assert.ok(evil, "route_evil should still be present as a route");
  assert.equal(evil.targets.length, 0, "the target aimed at evil.example must be dropped");
});

// ── Bug 3: readCredential must not embed a revoked credential ────────────────
test("build: a revoked provider credential is not embedded; its target is dropped", async () => {
  const snap = await buildSnapshot(sql, "inst_rev");

  for (const t of allTargets(snap)) {
    assert.notEqual(t.credentialId, "cred_revoked", "a revoked credential must never ship in the snapshot");
  }
  const rev = snap.routes["prof_rev:chat:revoked-route"];
  assert.ok(rev, "route_revoked should still be present as a route");
  assert.equal(rev.targets.length, 0, "the target referencing the revoked credential must be dropped");
});

// ── F10: a revoked virtual key is filtered out of the snapshot (never ships in the signed blob) ──
test("build: a revoked virtual key is not carried into snapshot.keys (⇒ AUTH_KEY_UNKNOWN)", async () => {
  const snap = await buildSnapshot(sql, "inst_budget");
  // The live key (keyed_hash "b0d9") is present; the revoked key (keyed_hash "dead") is absent — a
  // revoked key never reaches the gateway, so authenticate() cannot find it and returns
  // AUTH_KEY_UNKNOWN. This preserves "a revoked key cannot authenticate" without a per-key tombstone.
  assert.ok(snap.keys["b0d9"], "the live key must ship in the snapshot");
  assert.equal(snap.keys["dead"], undefined, "a revoked key must never ship in the snapshot");
  assert.equal(
    Object.values(snap.keys).some((k) => k.id === "vk_revoked"),
    false,
    "no revoked key may appear in snapshot.keys under any hash",
  );
});

// ── Bug 4: apply() must durably queue publication inside the DB transaction ──
test("apply: commits DB truth and a publication job without an inline store side effect", async () => {
  let publishCalls = 0;
  const throwingStore: SnapshotPublishStore = {
    publish: async () => {
      publishCalls += 1;
      throw new Error("publish boom");
    },
    pointer: async () => null,
    loadActive: async () => {
      throw new Error("unused");
    },
  };

  const target = await buildSnapshot(sql, "inst_apply_fail");
  const p = await plan(sql, "inst_apply_fail", target);

  const op = await apply(sql, p, throwingStore);
  assert.equal(op.outcome, "accepted");
  assert.equal(publishCalls, 0, "the request path must leave the external effect to the durable worker");

  const rows = await sql`
    SELECT id, status FROM gateway_config_revision
    WHERE installation_id = 'inst_apply_fail' AND status = 'active'`;
  assert.equal(rows.length, 1, "the config revision must be committed and active");
  assert.equal(rows[0].id, target.meta.revision);
  const jobs = await sql`
    SELECT status FROM job_ledger
    WHERE kind = 'config_publish_reconcile'
      AND payload->>'installationId' = 'inst_apply_fail'`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "pending");
});

test("apply: records exactly one active revision and one durable publication job", async () => {
  let publishedRevision: string | null = null;
  const store: SnapshotPublishStore = {
    publish: async (_inst, revision) => {
      // Publish is a post-commit cache write: by now the revision is committed DB truth.
      publishedRevision = revision;
      return { version: "v1" };
    },
    pointer: async () => null,
    loadActive: async () => {
      throw new Error("unused");
    },
  };

  const target = await buildSnapshot(sql, "inst_apply_ok");
  const p = await plan(sql, "inst_apply_ok", target);
  const op = await apply(sql, p, store);

  assert.equal(op.outcome, "accepted");
  assert.equal(op.edgeConfigVersion, null, "the worker records an accelerator version after publication");
  assert.equal(op.revisionId, target.meta.revision);
  assert.equal(publishedRevision, null, "the request path must not publish inline");

  const rows = await sql`
    SELECT id FROM gateway_config_revision
    WHERE installation_id = 'inst_apply_ok' AND status = 'active'`;
  assert.equal(rows.length, 1, "exactly one active revision after apply");
  assert.equal(rows[0].id, target.meta.revision);
  const jobs = await sql`
    SELECT status FROM job_ledger
    WHERE kind = 'config_publish_reconcile'
      AND payload->>'installationId' = 'inst_apply_ok'`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "pending");
});

/** An in-memory publish store that always succeeds (for tests that need an active revision). */
const okStore = (): SnapshotPublishStore => ({
  publish: async () => ({ version: "v1" }),
  pointer: async () => null,
  loadActive: async () => {
    throw new Error("unused");
  },
});

// ── Fix 1: `budgets` is inside the signed content hash ⇒ a budget-only edit is NOT a no-op ────
test("plan: a budget-only change is NOT a no-op (budgets are inside the signed content hash)", async () => {
  const s1 = await buildSnapshot(sql, "inst_budget");
  assert.ok(s1.budgets && s1.budgets["ba_budget"], "the advisory budget must ship in the snapshot");

  // Establish an active revision carrying the budget.
  await apply(sql, await plan(sql, "inst_budget", s1), okStore());

  // Change ONLY the budget account's cap — nothing else about the installation changes.
  await sql`UPDATE budget_account SET limit_amount = 2000000 WHERE id = 'ba_budget'`;
  const s2 = await buildSnapshot(sql, "inst_budget");

  // Pre-fix (budgets excluded from the hash) s1 and s2 hash identically → plan() is a no-op and the
  // change never publishes. Post-fix the hash differs and the diff surfaces the budget change.
  assert.notEqual(s1.meta.contentHash, s2.meta.contentHash, "a budget-only edit must change the content hash");
  const p2 = await plan(sql, "inst_budget", s2);
  assert.equal(p2.noop, false, "a budget-only change must NOT be a no-op");
  assert.ok(
    p2.diffJson.budgets.changed.includes("ba_budget"),
    `budget change must appear in diffJson.budgets.changed; got ${JSON.stringify(p2.diffJson.budgets)}`,
  );
});

// ── Fix 2: offering-scoped entitlement resolves to that offering's model (not a wildcard) ──────
test("build: an offering-scoped entitlement scopes to that offering's canonical model, not a wildcard", async () => {
  const snap = await buildSnapshot(sql, "inst_ent");
  const pol = snap.policies["polrev_ent"];
  assert.ok(pol, "the bound policy revision must be present");
  const ent = pol.modelEntitlements.find((e) => e.effect === "allow");
  assert.ok(ent, "the offering-scoped allow must be emitted in the evaluator shape");
  // The whole fix: off1's canonical model is cm1. Pre-fix this was null, which the evaluator treats
  // as an all-models WILDCARD (offering-scoped allow → allow-ALL). It must be exactly cm1.
  assert.notEqual(ent.canonicalModelId, null, "an offering-scoped allow must NOT collapse to a model wildcard");
  assert.equal(ent.canonicalModelId, "cm1", `must scope to the offering's model; got ${JSON.stringify(ent)}`);
});

// ── Fix 4: apply() enforces tripwire approval (unapproved route_delete rejected) ───────────────
test("apply: an unapproved route_delete is rejected; a matching {kind,ref,planHash} approval lets it through", async () => {
  // Active revision with BOTH routes (chat + embeddings, distinct keys).
  const s1 = await buildSnapshot(sql, "inst_tw");
  assert.equal(Object.keys(s1.routes).length, 2, "two distinct-kind routes must be present");
  await apply(sql, await plan(sql, "inst_tw", s1), okStore());

  // Delete the embeddings route → re-plan produces a route_delete tripwire.
  await sql`UPDATE gateway_route SET active_revision_id = NULL WHERE id = 'route_tw_emb'`;
  const s2 = await buildSnapshot(sql, "inst_tw");
  const p2 = await plan(sql, "inst_tw", s2);
  const tw = p2.tripwireItems.find((t) => t.kind === "route_delete");
  assert.ok(tw, `a route_delete tripwire must be produced; got ${JSON.stringify(p2.tripwireItems)}`);

  // (a) No approval → apply REJECTS and inserts NO new revision (the base stays active).
  const rejected = await apply(sql, p2, okStore());
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reasonCode, "CONFIG_TRIPWIRE_HELD");
  assert.equal(rejected.revisionId, null, "a held tripwire must not produce a new revision");
  const active1 = await sql`
    SELECT content_hash FROM gateway_config_revision
    WHERE installation_id = 'inst_tw' AND status = 'active'`;
  assert.equal(active1.length, 1);
  assert.equal(active1[0].content_hash, s1.meta.contentHash, "the base revision must remain active");

  // (b) An approval for a DIFFERENT planHash must NOT clear the hold (approval is plan-bound).
  const staleApproval: Approval[] = [{ kind: tw.kind, ref: tw.ref, planHash: "sha256:stale" }];
  const stale = await apply(sql, p2, okStore(), staleApproval);
  assert.equal(stale.outcome, "rejected", "an approval bound to a different plan must not clear the hold");

  // (c) A matching {kind, ref, planHash} approval lets it through.
  const approvals: Approval[] = [{ kind: tw.kind, ref: tw.ref, planHash: p2.planHash }];
  const accepted = await apply(sql, p2, okStore(), approvals);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.revisionId, s2.meta.revision, "the approved change produces the new revision");
});

// ── Fix 5: rollback commits DB truth plus a durable publication job ────────────────────────────
test("rollback: reactivates DB truth and queues byte-identical publication", async () => {
  // rev1 (active) then a content-different rev2 (active; rev1 → superseded).
  const op1 = await apply(sql, await plan(sql, "inst_rb", await buildSnapshot(sql, "inst_rb")), okStore());
  const rev1 = op1.revisionId as string;

  await sql`UPDATE gateway_target SET weight = 55 WHERE id = 'tg_rb'`; // change snapshot content
  const s2 = await buildSnapshot(sql, "inst_rb");
  const op2 = await apply(sql, await plan(sql, "inst_rb", s2), okStore());
  const rev2 = op2.revisionId as string;
  assert.notEqual(rev1, rev2, "the two applies must produce distinct revisions");

  let publishCalls = 0;
  const throwingStore: SnapshotPublishStore = {
    publish: async () => {
      publishCalls += 1;
      throw new Error("rollback publish boom");
    },
    pointer: async () => null,
    loadActive: async () => {
      throw new Error("unused");
    },
  };
  const rollbackOp = await rollback(sql, rev1, throwingStore, { workspaceId: "ws1" });
  assert.equal(rollbackOp.outcome, "accepted");
  assert.equal(publishCalls, 0, "the request path must leave publication to the durable worker");

  // The control plane commits active DB truth before publication. The gateway-reported
  // applied_config_revision stays untouched until an authenticated gateway report arrives.
  const inst = await sql`SELECT applied_config_revision FROM gateway_installation WHERE id = 'inst_rb'`;
  assert.equal(inst[0].applied_config_revision, null, "rollback must not self-report gateway adoption");
  const rev1row = await sql`SELECT status FROM gateway_config_revision WHERE id = ${rev1}`;
  assert.equal(rev1row[0].status, "active", "the rolled-back-to revision must be active DB truth");
  const rev2row = await sql`SELECT status FROM gateway_config_revision WHERE id = ${rev2}`;
  assert.equal(rev2row[0].status, "rolled_back", "the prior active revision must be marked rolled_back");
  const jobs = await sql`
    SELECT status FROM job_ledger
    WHERE kind = 'config_publish_reconcile'
      AND payload->>'operationId' = ${rollbackOp.id}`;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "pending");
});

// ── Bug fix (db.ts readDek): a non-active (retiring/revoked) DEK must not ship its wrapped bytes ─
test("build: a non-active DEK (retiring/revoked) does not ship its wrapped bytes in the snapshot", async () => {
  const snap = await buildSnapshot(sql, "inst_dek");
  const target = allTargets(snap).find((t) => t.credentialId === "cred_dek_retiring");
  assert.ok(target, "the target must still be present (its credential itself is live/valid)");
  // Pre-fix, readDek ignored `status` and returned the retiring DEK's wrapped bytes verbatim
  // (base64 of \xfeedface, non-empty). Post-fix, readDek requires status='active', so a
  // retiring/revoked DEK resolves to null and build.ts ships an empty string instead.
  assert.equal(
    target.wrappedDek,
    "",
    `a non-active DEK's wrapped bytes must not ship in the snapshot; got ${JSON.stringify(target.wrappedDek)}`,
  );
});

// ── Bug fix (plan.ts tripwires): a budget hard->advisory enforcement flip requires approval ─────
test("plan: a budget hard->advisory enforcement flip is a tripwire requiring approval", async () => {
  const s1 = await buildSnapshot(sql, "inst_budget_tw");
  assert.equal(s1.budgets["ba_hard_tw"]?.enforcement, "hard", "fixture must start hard");
  await apply(sql, await plan(sql, "inst_budget_tw", s1), okStore());

  // Relax the SAME account from hard to advisory — no route/entitlement change at all.
  await sql`UPDATE budget_account SET enforcement = 'advisory' WHERE id = 'ba_hard_tw'`;
  const s2 = await buildSnapshot(sql, "inst_budget_tw");
  assert.equal(s2.budgets["ba_hard_tw"]?.enforcement, "advisory");
  const p2 = await plan(sql, "inst_budget_tw", s2);

  const tw = p2.tripwireItems.find((t) => t.kind === "budget_enforcement_relaxed" && t.ref === "ba_hard_tw");
  assert.ok(
    tw,
    `a hard->advisory budget flip must produce a tripwire; got ${JSON.stringify(p2.tripwireItems)}`,
  );

  // apply() must hold it without a matching approval...
  const rejected = await apply(sql, p2, okStore());
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reasonCode, "CONFIG_TRIPWIRE_HELD");
  assert.equal(rejected.revisionId, null, "a held budget tripwire must not produce a new revision");

  // ...and let it through once approved.
  const approvals: Approval[] = [{ kind: tw!.kind, ref: tw!.ref, planHash: p2.planHash }];
  const accepted = await apply(sql, p2, okStore(), approvals);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.revisionId, s2.meta.revision);
});

// ── Bug fix (plan.ts tripwires): removing a `deny` entitlement is ALSO a tripwire (not just allow) ─
test("plan: removing a deny entitlement is a tripwire requiring approval (not allow-only)", async () => {
  const s1 = await buildSnapshot(sql, "inst_deny_tw");
  const pol1 = s1.policies["polrev_deny_tw"];
  assert.ok(
    pol1?.modelEntitlements.some((e) => e.effect === "deny"),
    "fixture must carry a deny entitlement in the base",
  );
  await apply(sql, await plan(sql, "inst_deny_tw", s1), okStore());

  // Remove the deny entitlement entirely — access it used to block is now silently open.
  await sql`DELETE FROM model_entitlement WHERE id = 'ent_deny_tw'`;
  const s2 = await buildSnapshot(sql, "inst_deny_tw");
  const p2 = await plan(sql, "inst_deny_tw", s2);

  const tw = p2.tripwireItems.find((t) => t.kind === "entitlement_removal" && t.ref.startsWith("deny:"));
  assert.ok(
    tw,
    `removing a deny entitlement must produce a tripwire; got ${JSON.stringify(p2.tripwireItems)}`,
  );

  // apply() must hold it without a matching approval...
  const rejected = await apply(sql, p2, okStore());
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.reasonCode, "CONFIG_TRIPWIRE_HELD");

  // ...and let it through once approved.
  const approvals: Approval[] = [{ kind: tw!.kind, ref: tw!.ref, planHash: p2.planHash }];
  const accepted = await apply(sql, p2, okStore(), approvals);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.revisionId, s2.meta.revision);
});
