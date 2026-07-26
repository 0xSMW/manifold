import assert from "node:assert/strict";
import test from "node:test";
import { InternalContracts } from "../src/index.ts";

test("storage compaction blocked response preserves the structured redacted blocker golden", () => {
  const result = InternalContracts.storageCompactionResponse.safeParse({
    status: "blocked",
    blocker: { code: "RETENTION_PREREQUISITES_MISSING", missing: ["export_target"], destructiveWorkSkipped: true },
    beforeBytes: 100, afterBytes: 100, freedBytes: 0,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.success ? result.data : null, {
    status: "blocked",
    blocker: { code: "RETENTION_PREREQUISITES_MISSING", missing: ["export_target"], destructiveWorkSkipped: true },
    beforeBytes: 100, afterBytes: 100, freedBytes: 0,
  });
  assert.equal(InternalContracts.storageCompactionResponse.safeParse({
    status: "blocked", blocker: "database detail", beforeBytes: 1, afterBytes: 1, freedBytes: 0,
  }).success, false);
});
