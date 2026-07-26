// Focused source-level contract tests for snapshot runtime controls. The test
// loader maps local .js specifiers back to TypeScript source, so this exercises
// the pending builder rather than a previously generated dist/ tree.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@manifold/ports") {
      return { url: new URL("../../ports/src/index.ts", import.meta.url).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(sourceUrl)) return { url: sourceUrl.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip" }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const { snapshotRateLimit, snapshotRetryPolicy } = await import("../src/build.ts");
const { readVirtualKeys, readRouteRevision, readTargets } = await import("../src/db.ts");

test("snapshot controls retain valid limits and bounded raw retry policy", () => {
  assert.deepEqual(snapshotRateLimit({ rpm: 120, tpm: 24_000, burst: 15 }), {
    rpm: 120,
    tpm: 24_000,
    burst: 15,
  });
  assert.deepEqual(snapshotRateLimit({ rpm: 0, tpm: -1, burst: 1.5 }), undefined);
  assert.deepEqual(snapshotRateLimit({ rpm: 5, tpm: "bad", extra: 1 }), { rpm: 5 });

  const raw = { max_attempts: 3, retry_on: ["429", "5xx"], backoff_ms: 250 };
  assert.deepEqual(snapshotRetryPolicy(raw), raw);
  assert.equal(snapshotRetryPolicy({ retry_on: Array.from({ length: 33 }, () => "429") }), undefined);
  assert.equal(snapshotRetryPolicy({ nested: { a: { b: { c: { d: 1 } } } } }), undefined);
});

test("snapshot DB readers select key limits, retry policy, and target health", async () => {
  const queries = [];
  const sql = ((strings, ...values) => {
    if (Array.isArray(strings) && Object.prototype.hasOwnProperty.call(strings, "raw")) {
      queries.push(strings.join("?").replace(/\s+/g, " "));
      return Promise.resolve([]);
    }
    return strings;
  });

  await readVirtualKeys(sql, ["profile_1"]);
  await readRouteRevision(sql, "rev_1");
  await readTargets(sql, "rev_1");

  assert.match(queries[0], /rate_limit/);
  assert.match(queries[1], /retry_policy/);
  assert.match(queries[2], /health_state/);
});
