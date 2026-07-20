// @manifold/provider-registry — types for the models.dev import pipeline.
// SPEC §11.6 ("Provider & model registry: models.dev sync and field mapping"),
// §6.4 (canonical_model / provider_model_offering / provider_price_revision schema).

/**
 * Capability tri-state (SPEC §11, §11.6, ADR-0010/ADR-0009). An absent
 * upstream boolean MUST map to `"unknown"` — never coerced to `false`.
 */
export type TriState = "supported" | "unsupported" | "unknown";

/**
 * Price fidelity (SPEC §6.4 `provider_price_revision.fidelity` CHECK,
 * ADR-0009). This importer only ever produces `provider_verified`,
 * `aggregator`, or `unknown` — `operator_override` rows are written later,
 * workspace-scoped, by the control plane, never by the importer.
 */
export type Fidelity =
  | "provider_verified"
  | "operator_override"
  | "aggregator"
  | "unknown";

// ---------------------------------------------------------------------------
// models.dev `api.json` input shape (SPEC §11.6, "verified" schema).
// ---------------------------------------------------------------------------

export interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

export interface ModelsDevLimit {
  context?: number;
  output?: number;
}

/** `cost` is USD per 1,000,000 tokens (SPEC §11.6). Values may arrive as a
 * JSON number or (if the caller pre-stringified to dodge float parsing) a
 * decimal string — `priceToMicroUnits` accepts either. */
export interface ModelsDevCost {
  input?: number | string;
  output?: number | string;
  cache_read?: number | string;
  cache_write?: number | string;
  reasoning?: number | string;
  audio_input?: number | string;
  audio_output?: number | string;
}

export interface ModelsDevReasoningOption {
  type: string;
  min?: number;
  [key: string]: unknown;
}

export interface ModelsDevModel {
  id: string;
  name: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  modalities?: ModelsDevModalities;
  open_weights?: boolean;
  limit?: ModelsDevLimit;
  cost?: ModelsDevCost;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  npm?: string;
  doc?: string;
  env?: string[];
  models: Record<string, ModelsDevModel>;
}

/** The full `api.json` payload: keyed by provider id. */
export type ModelsDevPayload = Record<string, ModelsDevProvider>;

// ---------------------------------------------------------------------------
// Manifold registry output shape (SPEC §6.4). These mirror the DB columns
// closely enough to load directly, but this package never touches a
// database — `applyCatalog` (control plane) owns persistence.
// ---------------------------------------------------------------------------

export interface CapabilityMap {
  attachment: TriState;
  reasoning: TriState;
  toolCall: TriState;
  structuredOutput: TriState;
  temperature: TriState;
}

export interface CanonicalModel {
  id: string;
  canonicalSlug: string;
  family: string | null;
  displayName: string;
  modalityIn: string[];
  modalityOut: string[];
  openWeights: boolean | null;
  knowledgeCutoff: string | null;
  releaseDate: string | null;
  source: "models.dev";
}

export interface ProviderModelOffering {
  id: string;
  canonicalModelId: string;
  provider: string;
  providerModelId: string;
  endpointKinds: string[];
  contextLimitTokens: number | null;
  outputLimitTokens: number | null;
  capabilities: CapabilityMap;
  region: string | null;
}

export interface ProviderPriceRevision {
  id: string;
  offeringId: string;
  inputPerMtokMicrousd: bigint | null;
  outputPerMtokMicrousd: bigint | null;
  cacheReadPerMtokMicrousd: bigint | null;
  cacheWritePerMtokMicrousd: bigint | null;
  reasoningPerMtokMicrousd: bigint | null;
  audioInPerMtokMicrousd: bigint | null;
  audioOutPerMtokMicrousd: bigint | null;
  currency: "USD";
  unit: "per_mtok";
  fidelity: Fidelity;
}

export interface Catalog {
  schema: string;
  catalogRevision: string;
  canonicalModels: CanonicalModel[];
  offerings: ProviderModelOffering[];
  priceRevisions: ProviderPriceRevision[];
}
