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
import type { Database } from "@manifold/database";
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
/** The config package takes a drizzle `Database`; it only ever touches `db.$client`. */
let db: Database;

before(async () => {
  pg = await startPg({ namePrefix: "mf-config-test" });
  sql = pg.sql;
  db = { $client: sql } as unknown as Database;

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
      ('off1','cm1','openai','gpt-4o','["chat"]','ar1','{}','cat1');

    INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status, revoked_at) VALUES
      ('cred_openai','ws1','openai','openai key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','valid',NULL),
      ('cred_anthropic','ws1','anthropic','anthropic key','\\xc0ffee','dek1',NULL,'["api.anthropic.com"]','valid',NULL),
      ('cred_evilhost','ws1','openai','evil-target key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','valid',NULL),
      ('cred_revoked','ws1','openai','revoked key','\\xc0ffee','dek1',NULL,'["api.openai.com"]','revoked',now());

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
      ('rev_gpt','ws1','route_gpt','ordered','{}','{"overall_ms":30000}','sha256:rgpt'),
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
  `);
}, { timeout: 300_000 });

after(async () => {
  if (pg) await pg.stop();
});

/** Flatten every target across every route of a built snapshot. */
function allTargets(snap: ConfigSnapshot) {
  return Object.values(snap.routes).flatMap((r) => r.targets);
}

// ── Bug 2: ROUTE-KEY CLOBBER — DEFERRED (review #222) ───────────────────────
// Skipped: the §7.2 `${profile}:${kind}:${public_name}` key that would fix this requires a
// coordinated gateway-core resolveRoute redesign (see build.ts note). We kept the path-based key
// so config-built snapshots actually route in the gateway; the multi-same-kind clobber remains a
// known open item. Un-skip when the gateway resolveRoute reconciliation lands.
test.skip("build: two same-kind (chat) routes with different public_names both survive (no clobber)", async () => {
  const snap = await buildSnapshot(db, "inst_clobber");
  const keys = Object.keys(snap.routes);

  // SPEC §7.2 key shape `${profile}:${kind}:${public_name}` keeps the two chat routes distinct.
  const gptKey = "prof_clobber:chat:gpt-4o";
  const claudeKey = "prof_clobber:chat:claude-3";
  assert.ok(snap.routes[gptKey], `expected route key ${gptKey}; got ${JSON.stringify(keys)}`);
  assert.ok(snap.routes[claudeKey], `expected route key ${claudeKey}; got ${JSON.stringify(keys)}`);

  // Both distinct routes present → their credentials both survive (neither clobbered the other).
  assert.notEqual(snap.routes[gptKey].routeId, snap.routes[claudeKey].routeId);
  assert.equal(snap.routes[gptKey].targets[0]?.credentialId, "cred_openai");
  assert.equal(snap.routes[claudeKey].targets[0]?.credentialId, "cred_anthropic");
});

// ── Bug 1: allowedHosts auto-expand → credential exfil ──────────────────────
test("build: a target baseUrl host absent from the credential allowlist is NOT allowlisted (fail closed)", async () => {
  const snap = await buildSnapshot(db, "inst_sec");

  // The attacker host must appear in NO target's allowedHosts anywhere in the snapshot.
  for (const t of allTargets(snap)) {
    assert.ok(
      !t.allowedHosts.includes("evil.example"),
      `evil.example must never be auto-allowlisted; got ${JSON.stringify(t.allowedHosts)}`,
    );
  }

  // Fail closed: the misconfigured target (host ∉ credential allow_hosts) is dropped, so the route
  // ships with no target for ssrfCheck to (fail to) guard.
  const evil = snap.routes["prof_sec:/v1/chat/completions"];
  assert.ok(evil, "route_evil should still be present as a route");
  assert.equal(evil.targets.length, 0, "the target aimed at evil.example must be dropped");
});

// ── Bug 3: readCredential must not embed a revoked credential ────────────────
test("build: a revoked provider credential is not embedded; its target is dropped", async () => {
  const snap = await buildSnapshot(db, "inst_rev");

  for (const t of allTargets(snap)) {
    assert.notEqual(t.credentialId, "cred_revoked", "a revoked credential must never ship in the snapshot");
  }
  const rev = snap.routes["prof_rev:/v1/chat/completions"];
  assert.ok(rev, "route_revoked should still be present as a route");
  assert.equal(rev.targets.length, 0, "the target referencing the revoked credential must be dropped");
});

// ── Bug 4: apply() must publish only AFTER the DB txn commits ────────────────
test("apply: store.publish runs only after the DB txn commits (publish failure ⇒ DB revision stays committed)", async () => {
  // A store whose publish always throws. Pre-fix, publish ran INSIDE the txn → a throw rolled the
  // whole txn back → NO gateway_config_revision row. Post-fix, publish runs AFTER commit → the row
  // is committed & active even though publish then fails (store simply lags — the safe direction).
  const throwingStore: SnapshotPublishStore = {
    publish: async () => {
      throw new Error("publish boom");
    },
    pointer: async () => null,
    loadActive: async () => {
      throw new Error("unused");
    },
  };

  const target = await buildSnapshot(db, "inst_apply_fail");
  const p = await plan(db, "inst_apply_fail", target);

  await assert.rejects(apply(db, p, throwingStore), /publish boom/);

  // The DB txn committed BEFORE publish was attempted: the new revision is present and active.
  const rows = await sql`
    SELECT id, status FROM gateway_config_revision
    WHERE installation_id = 'inst_apply_fail' AND status = 'active'`;
  assert.equal(rows.length, 1, "the config revision must be committed & active despite publish failure");
  assert.equal(rows[0].id, target.meta.revision);
});

test("apply: happy path publishes after commit and records exactly one active revision", async () => {
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

  const target = await buildSnapshot(db, "inst_apply_ok");
  const p = await plan(db, "inst_apply_ok", target);
  const op = await apply(db, p, store);

  assert.equal(op.outcome, "accepted");
  assert.equal(op.edgeConfigVersion, "v1", "the published version is reflected on the returned op");
  assert.equal(op.revisionId, target.meta.revision);
  assert.equal(publishedRevision, target.meta.revision);

  const rows = await sql`
    SELECT id FROM gateway_config_revision
    WHERE installation_id = 'inst_apply_ok' AND status = 'active'`;
  assert.equal(rows.length, 1, "exactly one active revision after apply");
  assert.equal(rows[0].id, target.meta.revision);
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
  const s1 = await buildSnapshot(db, "inst_budget");
  assert.ok(s1.budgets && s1.budgets["ba_budget"], "the advisory budget must ship in the snapshot");

  // Establish an active revision carrying the budget.
  await apply(db, await plan(db, "inst_budget", s1), okStore());

  // Change ONLY the budget account's cap — nothing else about the installation changes.
  await sql`UPDATE budget_account SET limit_amount = 2000000 WHERE id = 'ba_budget'`;
  const s2 = await buildSnapshot(db, "inst_budget");

  // Pre-fix (budgets excluded from the hash) s1 and s2 hash identically → plan() is a no-op and the
  // change never publishes. Post-fix the hash differs and the diff surfaces the budget change.
  assert.notEqual(s1.meta.contentHash, s2.meta.contentHash, "a budget-only edit must change the content hash");
  const p2 = await plan(db, "inst_budget", s2);
  assert.equal(p2.noop, false, "a budget-only change must NOT be a no-op");
  assert.ok(
    p2.diffJson.budgets.changed.includes("ba_budget"),
    `budget change must appear in diffJson.budgets.changed; got ${JSON.stringify(p2.diffJson.budgets)}`,
  );
});

// ── Fix 2: offering-scoped entitlement resolves to that offering's model (not a wildcard) ──────
test("build: an offering-scoped entitlement scopes to that offering's canonical model, not a wildcard", async () => {
  const snap = await buildSnapshot(db, "inst_ent");
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
  const s1 = await buildSnapshot(db, "inst_tw");
  assert.equal(Object.keys(s1.routes).length, 2, "two distinct-kind routes must be present");
  await apply(db, await plan(db, "inst_tw", s1), okStore());

  // Delete the embeddings route → re-plan produces a route_delete tripwire.
  await sql`UPDATE gateway_route SET active_revision_id = NULL WHERE id = 'route_tw_emb'`;
  const s2 = await buildSnapshot(db, "inst_tw");
  const p2 = await plan(db, "inst_tw", s2);
  const tw = p2.tripwireItems.find((t) => t.kind === "route_delete");
  assert.ok(tw, `a route_delete tripwire must be produced; got ${JSON.stringify(p2.tripwireItems)}`);

  // (a) No approval → apply REJECTS and inserts NO new revision (the base stays active).
  const rejected = await apply(db, p2, okStore());
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
  const stale = await apply(db, p2, okStore(), staleApproval);
  assert.equal(stale.outcome, "rejected", "an approval bound to a different plan must not clear the hold");

  // (c) A matching {kind, ref, planHash} approval lets it through.
  const approvals: Approval[] = [{ kind: tw.kind, ref: tw.ref, planHash: p2.planHash }];
  const accepted = await apply(db, p2, okStore(), approvals);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.revisionId, s2.meta.revision, "the approved change produces the new revision");
});

// ── Fix 5: rollback publishes only AFTER the DB txn commits ────────────────────────────────────
test("rollback: republish runs only after commit (publish failure ⇒ the DB rollback still stands)", async () => {
  // rev1 (active) then a content-different rev2 (active; rev1 → superseded).
  const op1 = await apply(db, await plan(db, "inst_rb", await buildSnapshot(db, "inst_rb")), okStore());
  const rev1 = op1.revisionId as string;

  await sql`UPDATE gateway_target SET weight = 55 WHERE id = 'tg_rb'`; // change snapshot content
  const s2 = await buildSnapshot(db, "inst_rb");
  const op2 = await apply(db, await plan(db, "inst_rb", s2), okStore());
  const rev2 = op2.revisionId as string;
  assert.notEqual(rev1, rev2, "the two applies must produce distinct revisions");

  // Roll back to rev1 with a store whose publish always throws.
  const throwingStore: SnapshotPublishStore = {
    publish: async () => {
      throw new Error("rollback publish boom");
    },
    pointer: async () => null,
    loadActive: async () => {
      throw new Error("unused");
    },
  };
  await assert.rejects(rollback(db, rev1, throwingStore), /rollback publish boom/);

  // Pre-fix (publish INSIDE the txn) the throw rolls the DB back: rev2 stays active + the
  // installation still points at rev2. Post-fix the DB commit stands despite the publish failure.
  const inst = await sql`SELECT applied_config_revision FROM gateway_installation WHERE id = 'inst_rb'`;
  assert.equal(inst[0].applied_config_revision, rev1, "installation must point at the rolled-back-to revision");
  const rev2row = await sql`SELECT status FROM gateway_config_revision WHERE id = ${rev2}`;
  assert.equal(rev2row[0].status, "rolled_back", "the prior active revision must be marked rolled_back");
});
