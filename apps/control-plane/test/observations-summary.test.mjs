import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storeSource = readFileSync(new URL("../app/api/v1/observations/_store.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/v1/observations/summary/route.ts", import.meta.url), "utf8");
const summarySource = storeSource.slice(storeSource.indexOf("export async function selectLatencySummary"), storeSource.indexOf("export async function selectObservationRows"));

test("latency summary uses exact scalar percentiles from observation truth", () => {
  assert.match(summarySource, /percentile_disc\(0\.50\) WITHIN GROUP \(ORDER BY o\.latency_ms\)/);
  assert.match(summarySource, /percentile_disc\(0\.95\) WITHIN GROUP \(ORDER BY o\.latency_ms\)/);
  assert.match(summarySource, /count\(o\.latency_ms\)::bigint AS sample_count/);
  assert.match(summarySource, /o\.profile_mode = \$\{profile\}/);
  assert.doesNotMatch(summarySource, /LIMIT\s+\$\{/);
});

test("latency summary is bounded to Overview's 30-day range", () => {
  assert.match(routeSource, /const MAX_SUMMARY_RANGE_MS = 30 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(routeSource, /requireOverviewRange\(filters\.from, filters\.to\)/);
});
