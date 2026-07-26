import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startPg, type PgHarness } from "../../../packages/database/test/pg-harness.ts";
import { listAlertRules } from "../app/api/v1/settings/alerts/route.ts";

let pg: PgHarness;

before(async () => {
  pg = await startPg({ namePrefix: "mf-settings-alerts", poolSize: 1 });
  pg.psql(`
    INSERT INTO workspace (id, slug, name, region) VALUES ('ws_alerts', 'alerts', 'Alerts', 'local');
    INSERT INTO alert_rule (id, workspace_id, scope_type, scope_id, metric, threshold, "window", destinations)
    VALUES ('alert_1', 'ws_alerts', 'workspace', NULL, 'spend', 100, 'monthly', '[]'::jsonb);
  `);
}, { timeout: 180_000 });

after(async () => { await pg?.stop(); });

test("alerts query executes against PostgreSQL with the reserved window column", async () => {
  const rows = await listAlertRules(pg.sql, "ws_alerts", null, 20);
  assert.deepEqual(rows.map((row) => ({ id: row.id, window: row.window })), [{ id: "alert_1", window: "monthly" }]);
});
