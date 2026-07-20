// packages/domain/src/machines/gatewayRequest.ts — gateway request lifecycle (SPEC §5.4, §8.1).
//
// `received → profiled → authenticated → authorized → reserved? → dispatching → streaming
//  → reconciled` (or `→ rejected` at any guard). `reserved` is optional: a request with no
// applicable hard budget skips straight from `authorized` to `dispatching` (SKIP_RESERVE).
// Terminal: `reconciled`, `rejected`.
import { invalidTransition, ok, type Transition } from "./types.js";

export type GatewayRequestState =
  | "received"
  | "profiled"
  | "authenticated"
  | "authorized"
  | "reserved"
  | "dispatching"
  | "streaming"
  | "reconciled"
  | "rejected";

export const GATEWAY_REQUEST_STATES: readonly GatewayRequestState[] = [
  "received",
  "profiled",
  "authenticated",
  "authorized",
  "reserved",
  "dispatching",
  "streaming",
  "reconciled",
  "rejected",
];

export const GATEWAY_REQUEST_TERMINAL_STATES: readonly GatewayRequestState[] = [
  "reconciled",
  "rejected",
];

export type GatewayRequestEvent =
  /** received → profiled: resolveProfile(Host) succeeded (pre-auth, ADR-0001). */
  | { type: "PROFILE" }
  /** profiled → authenticated | rejected (AUTH_KEY_UNKNOWN/REVOKED/EXPIRED/PROFILE_MISMATCH). */
  | { type: "AUTHENTICATE"; ok: boolean }
  /** authenticated → authorized | rejected (POLICY_MODEL_DENIED/POLICY_PARAM_REJECTED). */
  | { type: "AUTHORIZE"; ok: boolean }
  /** authorized → reserved | rejected (BUDGET_RESERVE_DENIED/BUDGET_PRICE_UNKNOWN). */
  | { type: "RESERVE"; ok: boolean }
  /** authorized → dispatching directly: no hard budget applies to this scope. */
  | { type: "SKIP_RESERVE" }
  /** reserved|dispatching → dispatching | rejected (ROUTE_NO_HEALTHY_TARGET/ROUTE_ENDPOINT_UNSUPPORTED). */
  | { type: "DISPATCH"; ok: boolean }
  /** dispatching → streaming: upstream returned first byte within timeout. */
  | { type: "FIRST_BYTE" }
  /** streaming → reconciled: terminal reached (ok or error) — always terminal. */
  | { type: "COMPLETE" };

export function transitionGatewayRequest(
  state: GatewayRequestState,
  event: GatewayRequestEvent,
): Transition<GatewayRequestState> {
  switch (state) {
    case "received":
      if (event.type === "PROFILE") return ok("profiled");
      return invalidTransition();

    case "profiled":
      if (event.type === "AUTHENTICATE") {
        return ok(event.ok ? "authenticated" : "rejected");
      }
      return invalidTransition();

    case "authenticated":
      if (event.type === "AUTHORIZE") {
        return ok(event.ok ? "authorized" : "rejected");
      }
      return invalidTransition();

    case "authorized":
      if (event.type === "RESERVE") {
        return ok(event.ok ? "reserved" : "rejected");
      }
      if (event.type === "SKIP_RESERVE") return ok("dispatching");
      return invalidTransition();

    case "reserved":
      if (event.type === "DISPATCH") {
        return ok(event.ok ? "dispatching" : "rejected");
      }
      return invalidTransition();

    case "dispatching":
      if (event.type === "FIRST_BYTE") return ok("streaming");
      if (event.type === "DISPATCH" && !event.ok) return ok("rejected");
      return invalidTransition();

    case "streaming":
      if (event.type === "COMPLETE") return ok("reconciled");
      return invalidTransition();

    case "reconciled":
    case "rejected":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
