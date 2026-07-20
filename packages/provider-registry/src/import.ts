// @manifold/provider-registry — models.dev importer.
// SPEC §11.6 "Importer pipeline" step 3 (`transformModelsDev` in the spec's
// pseudocode is `importFromModelsDev` here): transform the validated
// models.dev payload into a `Catalog` of canonical models, provider
// offerings, and price revisions. Pure and offline — no network, no DB. This
// package stops at the in-memory `Catalog`; hashing/PR-opening (steps 4-5)
// and `RegistryService.applyCatalog` (persistence) are the control plane's
// job, not this package's.

import { SCHEMA_VERSION } from "@manifold/contracts";
import { buildCapabilityMap } from "./capabilities.js";
import { priceRevisionFidelity } from "./fidelity.js";
import { priceToMicroUnits } from "./price.js";
import type {
  Catalog,
  CanonicalModel,
  ModelsDevCost,
  ModelsDevModel,
  ModelsDevPayload,
  ProviderModelOffering,
  ProviderPriceRevision,
} from "./types.js";

export interface ImportOptions {
  /**
   * Curated slug overrides for models whose canonical grouping can't be
   * inferred from the top-level model `id` (SPEC §11.6: "slug from a
   * curated canonical map — many provider ids → one canonical"). Keyed by
   * `${providerId}/${providerModelId}` → canonical slug. Defaults to using
   * the model's own `id` verbatim, which is how models.dev already groups
   * the same underlying model across providers in practice.
   */
  canonicalOverrides?: Record<string, string>;
  /** `catalog_revision` to stamp on the resulting `Catalog` (SPEC §6.4). */
  catalogRevision?: string;
}

function canonicalSlugFor(
  providerId: string,
  model: ModelsDevModel,
  overrides: Record<string, string>,
): string {
  return overrides[`${providerId}/${model.id}`] ?? model.id;
}

type PriceFields = Pick<
  ProviderPriceRevision,
  | "inputPerMtokMicrousd"
  | "outputPerMtokMicrousd"
  | "cacheReadPerMtokMicrousd"
  | "cacheWritePerMtokMicrousd"
  | "reasoningPerMtokMicrousd"
  | "audioInPerMtokMicrousd"
  | "audioOutPerMtokMicrousd"
>;

function microOrNull(value: number | string | null | undefined): bigint | null {
  return value === undefined || value === null ? null : priceToMicroUnits(value);
}

/** SPEC §11.6 mapping: each `cost.*` USD/1M field → its µ$/1M column. */
function priceFieldsFromCost(cost: ModelsDevCost | undefined): PriceFields {
  return {
    inputPerMtokMicrousd: microOrNull(cost?.input),
    outputPerMtokMicrousd: microOrNull(cost?.output),
    cacheReadPerMtokMicrousd: microOrNull(cost?.cache_read),
    cacheWritePerMtokMicrousd: microOrNull(cost?.cache_write),
    reasoningPerMtokMicrousd: microOrNull(cost?.reasoning),
    audioInPerMtokMicrousd: microOrNull(cost?.audio_input),
    audioOutPerMtokMicrousd: microOrNull(cost?.audio_output),
  };
}

/**
 * Transform a models.dev-shaped `api.json` payload into the canonical-model
 * / provider-offering / price-revision rows the Manifold registry stores
 * (SPEC §11.6, §6.4). Deterministic: row ids are derived from the input, not
 * random, so re-running on the same payload produces the same `Catalog`.
 */
export function importFromModelsDev(
  payload: ModelsDevPayload,
  options: ImportOptions = {},
): Catalog {
  const overrides = options.canonicalOverrides ?? {};
  const catalogRevision = options.catalogRevision ?? "unpinned";

  const canonicalById = new Map<string, CanonicalModel>();
  const offerings: ProviderModelOffering[] = [];
  const priceRevisions: ProviderPriceRevision[] = [];

  for (const providerId of Object.keys(payload)) {
    const provider = payload[providerId];
    if (!provider) continue;

    for (const model of Object.values(provider.models)) {
      const slug = canonicalSlugFor(providerId, model, overrides);
      const canonicalId = `cm_${slug}`;

      if (!canonicalById.has(canonicalId)) {
        canonicalById.set(canonicalId, {
          id: canonicalId,
          canonicalSlug: slug,
          family: model.family ?? null,
          displayName: model.name,
          modalityIn: model.modalities?.input ?? ["text"],
          modalityOut: model.modalities?.output ?? ["text"],
          openWeights: model.open_weights ?? null,
          knowledgeCutoff: model.knowledge ?? null,
          releaseDate: model.release_date ?? null,
          source: "models.dev",
        });
      }

      const offeringId = `off_${providerId}_${model.id}`;
      offerings.push({
        id: offeringId,
        canonicalModelId: canonicalId,
        provider: providerId,
        providerModelId: model.id,
        // models.dev does not report endpoint kinds directly; left empty
        // for the adapter layer to populate from its own capability matrix
        // (SPEC §21.6), not guessed here.
        endpointKinds: [],
        contextLimitTokens: model.limit?.context ?? null,
        outputLimitTokens: model.limit?.output ?? null,
        capabilities: buildCapabilityMap(model),
        region: null,
      });

      // A `cost` block only counts as pricing if it carries at least one
      // usable numeric field. A missing block, an empty `{}`, or a block
      // whose every field is null/absent all yield null prices — and must
      // fail closed to `unknown` fidelity, never provider_verified/aggregator
      // (which would let hard budgets treat the null prices as $0 free
      // dispatch). SPEC §11.6 / ADR-0009.
      const priceFields = priceFieldsFromCost(model.cost);
      const hasCost = Object.values(priceFields).some((value) => value !== null);
      priceRevisions.push({
        id: `prc_${offeringId}`,
        offeringId: offeringId,
        ...priceFields,
        currency: "USD",
        unit: "per_mtok",
        fidelity: priceRevisionFidelity(providerId, hasCost),
      });
    }
  }

  return {
    schema: SCHEMA_VERSION,
    catalogRevision,
    canonicalModels: [...canonicalById.values()],
    offerings,
    priceRevisions,
  };
}
