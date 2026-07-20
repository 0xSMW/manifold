// @manifold/provider-registry — capability tri-state mapping.
// SPEC §11 ("capability matrix in tri-state (supported|unsupported|unknown),
// never a false for a missing boolean") and §11.6 field-mapping table:
// `true → supported`, `false → unsupported`, **absent → unknown** — never
// coerce an absent field to `false` (ADR-0009, ADR-0010).

import type { CapabilityMap, ModelsDevModel, TriState } from "./types.js";

/**
 * Map a single models.dev boolean capability field to the tri-state the
 * registry stores. `undefined`/missing MUST resolve to `"unknown"` — the
 * absence of a field in models.dev means "not reported", not "false".
 */
export function capabilityTriState(value: unknown): TriState {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  return "unknown";
}

/** Build the full capability tri-state map for one models.dev model. */
export function buildCapabilityMap(model: ModelsDevModel): CapabilityMap {
  return {
    attachment: capabilityTriState(model.attachment),
    reasoning: capabilityTriState(model.reasoning),
    tool_call: capabilityTriState(model.tool_call),
    structured_output: capabilityTriState(model.structured_output),
    temperature: capabilityTriState(model.temperature),
  };
}
