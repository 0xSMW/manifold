// packages/domain/src/machines/providerCredential.ts — provider credential lifecycle (SPEC §5.4, §6.4).
//
// `unvalidated → valid ⇄ invalid → rotating → revoked`. Terminal: `revoked`. Credentials
// use lifecycle columns (never row deletion, §5.3), so `revoked` is reachable directly
// from `valid`/`invalid` (immediate revoke) as well as via `rotating` (planned rotation).
//
// Persistence mapping (F23-F3): the pre-revoke states map 1:1 to provider_credential.status
// ('unvalidated','valid','invalid','rotating' — exactly the status CHECK), while `revoked` is the
// single revoke signal `revoked_at IS NOT NULL` (NOT a status value). Keep the four non-terminal
// states here in lock-step with provider_credential_status_chk so the machine and DB never drift.
import { invalidTransition, ok, type Transition } from "./types.js";

export const PROVIDER_CREDENTIAL_STATES = [
  "unvalidated",
  "valid",
  "invalid",
  "rotating",
  "revoked",
] as const;

/** Union of every state, derived from the single-source states list above. */
export type ProviderCredentialState = (typeof PROVIDER_CREDENTIAL_STATES)[number];

export const PROVIDER_CREDENTIAL_TERMINAL_STATES: readonly ProviderCredentialState[] = [
  "revoked",
];

export type ProviderCredentialEvent =
  /** unvalidated|invalid → valid | invalid: validation probe result. */
  | { type: "VALIDATE"; ok: boolean }
  /** valid → invalid: a subsequent probe/health-check failed. */
  | { type: "INVALIDATE" }
  /** valid|invalid → rotating: rotation to a successor credential begins. */
  | { type: "ROTATE" }
  /** rotating → revoked: rotation complete, predecessor retired. */
  | { type: "ROTATION_COMPLETE" }
  /** valid|invalid|rotating → revoked: immediate revoke. */
  | { type: "REVOKE" };

export function transitionProviderCredential(
  state: ProviderCredentialState,
  event: ProviderCredentialEvent,
): Transition<ProviderCredentialState> {
  switch (state) {
    case "unvalidated":
      if (event.type === "VALIDATE") {
        return ok(event.ok ? "valid" : "invalid");
      }
      return invalidTransition();

    case "valid":
      if (event.type === "INVALIDATE") return ok("invalid");
      if (event.type === "ROTATE") return ok("rotating");
      if (event.type === "REVOKE") return ok("revoked");
      return invalidTransition();

    case "invalid":
      if (event.type === "VALIDATE") {
        return ok(event.ok ? "valid" : "invalid");
      }
      if (event.type === "ROTATE") return ok("rotating");
      if (event.type === "REVOKE") return ok("revoked");
      return invalidTransition();

    case "rotating":
      if (event.type === "ROTATION_COMPLETE") return ok("revoked");
      if (event.type === "REVOKE") return ok("revoked");
      return invalidTransition();

    case "revoked":
      // Terminal — no outgoing transitions.
      return invalidTransition();
  }
}
