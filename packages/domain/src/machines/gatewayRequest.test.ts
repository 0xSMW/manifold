// packages/domain/src/machines/gatewayRequest.test.ts — SPEC §5.4, §8.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATEWAY_REQUEST_TERMINAL_STATES,
  transitionGatewayRequest,
} from "./gatewayRequest.js";

test("every legal transition succeeds", () => {
  assert.deepEqual(transitionGatewayRequest("received", { type: "PROFILE" }), {
    ok: true,
    state: "profiled",
  });
  assert.deepEqual(
    transitionGatewayRequest("profiled", { type: "AUTHENTICATE", ok: true }),
    { ok: true, state: "authenticated" },
  );
  assert.deepEqual(
    transitionGatewayRequest("profiled", { type: "AUTHENTICATE", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(
    transitionGatewayRequest("authenticated", { type: "AUTHORIZE", ok: true }),
    { ok: true, state: "authorized" },
  );
  assert.deepEqual(
    transitionGatewayRequest("authenticated", { type: "AUTHORIZE", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(
    transitionGatewayRequest("authorized", { type: "RESERVE", ok: true }),
    { ok: true, state: "reserved" },
  );
  assert.deepEqual(
    transitionGatewayRequest("authorized", { type: "RESERVE", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(
    transitionGatewayRequest("authorized", { type: "SKIP_RESERVE" }),
    { ok: true, state: "dispatching" },
  );
  assert.deepEqual(
    transitionGatewayRequest("reserved", { type: "DISPATCH", ok: true }),
    { ok: true, state: "dispatching" },
  );
  assert.deepEqual(
    transitionGatewayRequest("reserved", { type: "DISPATCH", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(
    transitionGatewayRequest("dispatching", { type: "FIRST_BYTE" }),
    { ok: true, state: "streaming" },
  );
  assert.deepEqual(
    transitionGatewayRequest("dispatching", { type: "DISPATCH", ok: false }),
    { ok: true, state: "rejected" },
  );
  assert.deepEqual(transitionGatewayRequest("streaming", { type: "COMPLETE" }), {
    ok: true,
    state: "reconciled",
  });
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Skipping stages.
  assert.deepEqual(transitionGatewayRequest("received", { type: "FIRST_BYTE" }), {
    ok: false,
    code: "INVALID_TRANSITION",
  });
  assert.deepEqual(
    transitionGatewayRequest("received", { type: "AUTHENTICATE", ok: true }),
    { ok: false, code: "INVALID_TRANSITION" },
  );
  // Wrong event for the current state.
  assert.deepEqual(
    transitionGatewayRequest("authenticated", { type: "RESERVE", ok: true }),
    { ok: false, code: "INVALID_TRANSITION" },
  );
  // Terminal states have no outgoing transitions.
  for (const terminal of GATEWAY_REQUEST_TERMINAL_STATES) {
    assert.deepEqual(transitionGatewayRequest(terminal, { type: "PROFILE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
    assert.deepEqual(transitionGatewayRequest(terminal, { type: "COMPLETE" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  }
});
