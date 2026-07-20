// @manifold/provider-registry — price fidelity.
// ADR-0009 ("models.dev is the primary registry source") and SPEC §11.6:
// a models.dev price is `aggregator` by default; it becomes `provider_verified`
// only when the models.dev provider id is a known first-party. Hard budgets
// fail closed on `unknown` (missing price data entirely).

import type { Fidelity } from "./types.js";

/**
 * First-party allowlist (SPEC §11.6, verbatim): models.dev provider ids
 * whose prices are trusted as straight-from-the-source, `provider_verified`.
 * Everything else — including well-known aggregators such as `openrouter`,
 * `vercel`, `requesty`, `helicone`, `llmgateway`, `nano-gpt` — is
 * `aggregator`: usable for observability and advisory budgets, never hard
 * budgets, until an operator override or provider-native verification
 * upgrades that specific offering.
 */
export const FIRST_PARTY_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "azure",
  "amazon-bedrock",
  "mistral",
  "cohere",
  "deepseek",
  "xai",
  "groq",
  "together",
  "fireworks-ai",
  "deepinfra",
  "cloudflare-workers-ai",
]);

/**
 * Fidelity for a models.dev-sourced price, given only the provider id.
 * Does not account for missing cost data — see `priceRevisionFidelity`.
 */
export function fidelityFor(providerId: string): "provider_verified" | "aggregator" {
  return FIRST_PARTY_PROVIDERS.has(providerId) ? "provider_verified" : "aggregator";
}

/**
 * Full `provider_price_revision.fidelity` (SPEC §6.4 CHECK / §11.6 mapping
 * table row "(derived)"): an offering with no `cost` block at all fails
 * closed to `unknown` regardless of provider — hard budgets can never be
 * built against a guess (ADR-0009).
 */
export function priceRevisionFidelity(providerId: string, hasCost: boolean): Fidelity {
  return hasCost ? fidelityFor(providerId) : "unknown";
}
