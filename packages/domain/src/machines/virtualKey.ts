// packages/domain/src/machines/virtualKey.ts — virtual key lifecycle (SPEC §5.4, §8.5).
//
// `active → rotating(grace) → revoked` / `expired`. Terminal: `revoked`, `expired`.
// This machine tracks a single key row; a rotation choreographs two rows (predecessor
// grace-window overlap with its successor, §8.5) but each row's own lifecycle is this
// simple chain: the predecessor moves active → rotating and is auto-revoked when the
// grace window elapses (or immediately, on explicit revoke).
import { invalidTransition, ok, type Transition } from "./types.js";

export type VirtualKeyState = "active" | "rotating" | "revoked" | "expired";

export const VIRTUAL_KEY_STATES: readonly VirtualKeyState[] = [
  "active",
  "rotating",
  "revoked",
  "expired",
];

export const VIRTUAL_KEY_TERMINAL_STATES: readonly VirtualKeyState[] = [
  "revoked",
  "expired",
];

export type VirtualKeyEvent =
  /** active → rotating: rotate() mints successor, grace window begins. */
  | { type: "ROTATE" }
  /** rotating → revoked: grace elapsed, predecessor auto-revoked. */
  | { type: "GRACE_ELAPSED" }
  /** active|rotating → revoked: revoke() sets revoked_at immediately. */
  | { type: "REVOKE" }
  /** active → expired: expires_at passed. */
  | { type: "EXPIRE" };

export function transitionVirtualKey(
  state: VirtualKeyState,
  event: VirtualKeyEvent,
): Transition<VirtualKeyState> {
  switch (state) {
    case "active":
      if (event.type === "ROTATE") return ok("rotating");
      if (event.type === "REVOKE") return ok("revoked");
      if (event.type === "EXPIRE") return ok("expired");
      return invalidTransition();

    case "rotating":
      if (event.type === "GRACE_ELAPSED") return ok("revoked");
      if (event.type === "REVOKE") return ok("revoked");
      return invalidTransition();

    case "revoked":
    case "expired":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
