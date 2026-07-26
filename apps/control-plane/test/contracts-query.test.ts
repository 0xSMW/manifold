import assert from "node:assert/strict";
import test from "node:test";
import { ConfigContracts, InternalContracts, KeysApi } from "@manifold/contracts";
import { contractOptionalEmptyBody, contractQuery } from "../lib/contracts/index.ts";
import { mutationRequestHash } from "../lib/mutation-guard.ts";

test("active snapshot and storage cadence queries reject unknown and repeated fields", () => {
  assert.deepEqual(
    contractQuery(new URLSearchParams("installationId=inst_1"), ConfigContracts.activeQuery),
    { installationId: "inst_1" },
  );
  assert.throws(
    () => contractQuery(new URLSearchParams("installationId=inst_1&unknown=1"), ConfigContracts.activeQuery),
    /query does not match the API contract/,
  );
  assert.throws(
    () => contractQuery(new URLSearchParams("installationId=inst_1&installationId=inst_2"), ConfigContracts.activeQuery),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && JSON.stringify(error).includes("query parameters must not be repeated"),
  );
  assert.deepEqual(contractQuery(new URLSearchParams(), InternalContracts.emptyQuery), {});
  assert.throws(
    () => contractQuery(new URLSearchParams("unexpected=1"), InternalContracts.emptyQuery),
    /query does not match the API contract/,
  );
});

test("optional-empty-body validation on a clone preserves the guarded request body", async () => {
  const request = new Request("https://control.example/api/v1/keys/key_1/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "revoke-key-1" },
    body: "{}",
  });

  await contractOptionalEmptyBody(request.clone(), KeysApi.emptyRequest);
  const requestHash = await mutationRequestHash(request);
  assert.match(requestHash, /^[a-f0-9]{64}$/);
  assert.equal(await request.text(), "{}", "guard hashing must leave the route request readable");
});
