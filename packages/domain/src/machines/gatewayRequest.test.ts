// packages/domain/src/machines/gatewayRequest.test.ts — SPEC §5.4, §8.1.
import { test } from "node:test";
import {
  GATEWAY_REQUEST_TERMINAL_STATES,
  transitionGatewayRequest,
} from "./gatewayRequest.js";
import { expectInvalid, expectOk } from "./transitionTestKit.js";

test("every legal transition succeeds", () => {
  expectOk(transitionGatewayRequest, "received", { type: "PROFILE" }, "profiled");
  expectOk(transitionGatewayRequest, "profiled", { type: "AUTHENTICATE", ok: true }, "authenticated");
  expectOk(transitionGatewayRequest, "profiled", { type: "AUTHENTICATE", ok: false }, "rejected");
  expectOk(transitionGatewayRequest, "authenticated", { type: "AUTHORIZE", ok: true }, "authorized");
  expectOk(transitionGatewayRequest, "authenticated", { type: "AUTHORIZE", ok: false }, "rejected");
  expectOk(transitionGatewayRequest, "authorized", { type: "RESERVE", ok: true }, "reserved");
  expectOk(transitionGatewayRequest, "authorized", { type: "RESERVE", ok: false }, "rejected");
  expectOk(transitionGatewayRequest, "authorized", { type: "SKIP_RESERVE" }, "dispatching");
  expectOk(transitionGatewayRequest, "reserved", { type: "DISPATCH", ok: true }, "dispatching");
  expectOk(transitionGatewayRequest, "reserved", { type: "DISPATCH", ok: false }, "rejected");
  expectOk(transitionGatewayRequest, "dispatching", { type: "FIRST_BYTE" }, "streaming");
  expectOk(transitionGatewayRequest, "dispatching", { type: "DISPATCH", ok: false }, "rejected");
  expectOk(transitionGatewayRequest, "streaming", { type: "COMPLETE" }, "reconciled");
});

test("a sampling of illegal transitions returns INVALID_TRANSITION", () => {
  // Skipping stages.
  expectInvalid(transitionGatewayRequest, "received", { type: "FIRST_BYTE" });
  expectInvalid(transitionGatewayRequest, "received", { type: "AUTHENTICATE", ok: true });
  // Wrong event for the current state.
  expectInvalid(transitionGatewayRequest, "authenticated", { type: "RESERVE", ok: true });
  // Terminal states have no outgoing transitions.
  for (const terminal of GATEWAY_REQUEST_TERMINAL_STATES) {
    expectInvalid(transitionGatewayRequest, terminal, { type: "PROFILE" });
    expectInvalid(transitionGatewayRequest, terminal, { type: "COMPLETE" });
  }
});
