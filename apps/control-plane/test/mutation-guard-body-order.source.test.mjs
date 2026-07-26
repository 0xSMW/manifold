import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../app/api/v1/", import.meta.url);

test("pre-guard optional-empty-body mutations validate a request clone", () => {
  const routes = [
    "providers/[id]/revoke/route.ts",
    "providers/[id]/validate/route.ts",
    "keys/[id]/revoke/route.ts",
    "installations/[id]/disable/route.ts",
  ];

  for (const route of routes) {
    const source = readFileSync(new URL(route, root), "utf8");
    const validation = source.indexOf("contractOptionalEmptyBody(req.clone()");
    const guard = source.indexOf("runMutationGuard({ request: req");
    assert.ok(validation >= 0, `${route} must validate the optional body on a clone`);
    assert.ok(guard > validation, `${route} must preserve the original request for mutation guard hashing`);
  }
});
