#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { positiveInteger } from "./budget-contract.mjs";

const missing = ["MANIFOLD_GATEWAY_URL", "MANIFOLD_VIRTUAL_KEY", "MANIFOLD_LOAD_PROFILE"].filter((name) => !process.env[name]);
if (missing.length) {
  process.stderr.write(`k6 release gate skipped as failure: missing required environment: ${missing.join(", ")}\n`);
  process.exitCode = 1;
} else if (! ["public_app", "enterprise_egress"].includes(process.env.MANIFOLD_LOAD_PROFILE)) {
  process.stderr.write("k6 release gate failed: MANIFOLD_LOAD_PROFILE must be public_app or enterprise_egress\n");
  process.exitCode = 1;
} else {
  try {
    if (process.env.MANIFOLD_LOAD_PROFILE === "enterprise_egress") positiveInteger(process.env.MANIFOLD_HARD_BUDGET_SUCCESS_CAP);
    const result = spawnSync(process.env.K6_BIN ?? "k6", ["run", fileURLToPath(new URL("./gateway-overhead.k6.js", import.meta.url))], { stdio: "inherit", env: process.env });
    if (result.error?.code === "ENOENT") { process.stderr.write("k6 release gate failed: k6 is not installed\n"); process.exitCode = 1; } else process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`k6 release gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
