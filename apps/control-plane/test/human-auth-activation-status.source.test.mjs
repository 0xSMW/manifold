import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("activation status exposes a requestable unconfigured state", async () => {
  const source = await readFile(new URL("../app/api/v1/auth/activation/status/route.ts", import.meta.url), "utf8");
  assert.match(source, /const configured = await activationStatus\(\)/);
  assert.match(source, /required: !configured, configured/);
});
