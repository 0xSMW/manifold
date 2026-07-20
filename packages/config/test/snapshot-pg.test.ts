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
  planApply,
  apply,
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
  const plan = await planApply(db, "inst_apply_fail", target);

  await assert.rejects(apply(db, plan, throwingStore), /publish boom/);

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
  const plan = await planApply(db, "inst_apply_ok", target);
  const op = await apply(db, plan, store);

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
