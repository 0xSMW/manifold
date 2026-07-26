import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/api/v1/storage/route.ts", import.meta.url), "utf8");

test("storage overview treats persisted pressure state as authoritative and has only a truthful pre-measurement fallback", () => {
  assert.match(source, /FROM storage_pressure_state WHERE workspace_id/);
  assert.match(source, /const tier = result\.pressure\?\.tier \?\? fallbackTier/);
  assert.match(source, /captureMode: "full" as const, payloadSampleRate: 1, journalMode: "full" as const, source: "fallback"/);
  assert.match(source, /source: "persisted" as const/);
});

test("storage overview projects the nullable claim timestamp expected by the compaction UI", () => {
  assert.match(source, /SELECT id, status, created_at, claimed_at, updated_at, last_error, payload/);
  assert.match(source, /claimedAt: result\.compaction\.claimed_at/);
});
