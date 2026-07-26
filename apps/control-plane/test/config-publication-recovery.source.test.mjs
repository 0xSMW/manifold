import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(new URL("../../../packages/database/migrations/0024_config_publication_recovery.sql", import.meta.url), "utf8");
const snapshot = readFileSync(new URL("../lib/snapshot.ts", import.meta.url), "utf8");

test("publication recovery retires stale work before selecting one newest active operation per installation", () => {
  assert.match(migration, /WITH superseded_operations AS/);
  assert.match(migration, /SET accelerator_status = 'superseded'/);
  assert.match(migration, /SET status = 'superseded'/);
  assert.match(migration, /JOIN public\.gateway_config_revision r ON r\.id = o\.revision_id AND r\.status = 'active'/);
  assert.match(migration, /SELECT DISTINCT ON \(o\.installation_id\)/);
  assert.match(migration, /ORDER BY o\.installation_id, o\.created_at DESC, o\.id DESC/);
  assert.doesNotMatch(migration, /FROM config_operation o\s+WHERE o\.accelerator_status IN \('pending', 'reconciliation_required'\) AND o\.revision_id IS NOT NULL\s+ORDER BY o\.created_at\s+LIMIT/);
});

test("privileged recovery functions use a safe search path, restricted execution, and online-safe status checks", () => {
  for (const name of ["claim_config_publication_recovery", "claim_config_key_publication_recovery"]) {
    assert.match(migration, new RegExp(`FUNCTION public\\.${name}\\(p_limit integer DEFAULT 20\\)[\\s\\S]*?SECURITY DEFINER SET search_path = pg_catalog`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(integer\\) FROM PUBLIC`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(integer\\) TO manifold_app`));
  }
  assert.match(migration, /FROM public\.config_operation o/);
  assert.match(migration, /FROM public\.job_ledger j/);
  assert.match(migration, /ADD CONSTRAINT config_operation_accelerator_status_chk_v2[\s\S]*?NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT config_operation_accelerator_status_chk_v2/);
  assert.match(migration, /RENAME CONSTRAINT config_operation_accelerator_status_chk_v2[\s\S]*?TO config_operation_accelerator_status_chk/);
  assert.match(migration, /ADD CONSTRAINT job_ledger_status_chk_v2[\s\S]*?NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT job_ledger_status_chk_v2/);
});

test("manual reconciliation retires a revision that loses active status without requeueing it", () => {
  assert.match(snapshot, /async function terminalizeSupersededConfigPublication/);
  assert.match(snapshot, /await terminalizeSupersededConfigPublication\(workspaceId, operationId\)/);
  assert.match(snapshot, /kind = 'config_publish_reconcile'/);
  assert.match(snapshot, /status IN \('pending', 'claimed'\)/);
});
