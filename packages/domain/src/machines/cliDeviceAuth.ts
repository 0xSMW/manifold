// packages/domain/src/machines/cliDeviceAuth.ts — CLI device authorization lifecycle (SPEC §5.4, §8.6).
//
// `pending → approved → issued` / `denied` / `expired`. Terminal: `issued`, `denied`,
// `expired`. Re-poll after `issued` is a single-issue guarantee, enforced by `issued`
// being terminal (no outgoing transitions).
import { invalidTransition, ok, type Transition } from "./types.js";

export const CLI_DEVICE_AUTH_STATES = [
  "pending",
  "approved",
  "issued",
  "denied",
  "expired",
] as const;

/** Union of every state, derived from the single-source states list above. */
export type CliDeviceAuthState = (typeof CLI_DEVICE_AUTH_STATES)[number];

export const CLI_DEVICE_AUTH_TERMINAL_STATES: readonly CliDeviceAuthState[] = [
  "issued",
  "denied",
  "expired",
];

export type CliDeviceAuthEvent =
  /** pending → approved: member approves the user_code after console login. */
  | { type: "APPROVE" }
  /** pending → denied: member denies. */
  | { type: "DENY" }
  /** pending|approved → expired: device code expired before issuance. */
  | { type: "EXPIRE" }
  /** approved → issued: server mints and returns the api_token (once). */
  | { type: "ISSUE" };

export function transitionCliDeviceAuth(
  state: CliDeviceAuthState,
  event: CliDeviceAuthEvent,
): Transition<CliDeviceAuthState> {
  switch (state) {
    case "pending":
      if (event.type === "APPROVE") return ok("approved");
      if (event.type === "DENY") return ok("denied");
      if (event.type === "EXPIRE") return ok("expired");
      return invalidTransition();

    case "approved":
      if (event.type === "ISSUE") return ok("issued");
      if (event.type === "EXPIRE") return ok("expired");
      return invalidTransition();

    case "issued":
    case "denied":
    case "expired":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
