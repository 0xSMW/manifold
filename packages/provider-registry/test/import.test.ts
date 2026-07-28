// Golden tests for the models.dev importer (SPEC §11.6, ADR-0008, ADR-0009).
// Fixture: test/fixtures/models-dev.sample.json — three offerings across
// three providers (one first-party, one aggregator, one unlisted/aggregator
// with no cost block at all) covering:
//   - exact µ$/1M price conversion (ADR-0008)
//   - an absent capability boolean resolving to "unknown", never "false"
//   - provider_verified vs aggregator fidelity (ADR-0009)
//   - fail-closed "unknown" fidelity when cost is missing entirely
//   - canonical-model dedup: two providers hosting the same models.dev
//     model id collapse into one canonical model, not two.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  importFromModelsDev,
  priceToMicroUnits,
  capabilityTriState,
  fidelityFor,
  type ModelsDevPayload,
} from "../src/index.js";

// This file compiles to dist/test/import.test.js (see package.json's "test"
// script — tests run against the build, not raw source, so relative imports
// above resolve the normal Node ESM way). The fixture is plain JSON and
// isn't part of the tsc build, so we walk back up to the source `test/`
// directory to find it regardless of cwd.
const here = dirname(fileURLToPath(import.meta.url));
const sourceFixturePath = join(here, "fixtures", "models-dev.sample.json");
const fixturePath = existsSync(sourceFixturePath)
  ? sourceFixturePath
  : join(here, "..", "..", "test", "fixtures", "models-dev.sample.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ModelsDevPayload;

// ---------------------------------------------------------------------------
// priceToMicroUnits — exact price conversions (ADR-0008)
// ---------------------------------------------------------------------------

test("priceToMicroUnits: $3.00 -> 3_000_000n", () => {
  assert.equal(priceToMicroUnits(3), 3_000_000n);
});

test("priceToMicroUnits: $0.30 -> 300_000n", () => {
  assert.equal(priceToMicroUnits(0.3), 300_000n);
});

test("priceToMicroUnits: $15 -> 15_000_000n", () => {
  assert.equal(priceToMicroUnits(15), 15_000_000n);
});

test("priceToMicroUnits: accepts a decimal string directly", () => {
  assert.equal(priceToMicroUnits("3.75"), 3_750_000n);
});

test("priceToMicroUnits: sub-1e-6 numbers (scientific notation) convert without throwing", () => {
  // BUG: String(5e-7) === "5e-7"; the exponential form was rejected by the
  // DECIMAL_LITERAL parser and threw, aborting the import / dropping the
  // offering. 5e-7 === 0.0000005 -> exactly half a µ$; kept magnitude 0 is
  // even, half-to-even rounds down to 0µ$.
  assert.equal(priceToMicroUnits(5e-7), 0n);
  assert.equal(priceToMicroUnits(0.0000005), 0n);
  // 6e-7 -> String is "6e-7"; the 7th fractional digit (6) rounds the µ$ up.
  assert.equal(priceToMicroUnits(6e-7), 1n);
});

test("priceToMicroUnits: rounds half-to-even at the sub-µ$ boundary", () => {
  // 1.0000015 * 1e6 = 1000.0015 -> nowhere near a tie, rounds down to 1000000...
  // Use an exact-tie case instead: 0.0000005 -> exactly half a µ$; the kept
  // magnitude (0) is even, so it rounds down (half-to-even), not up.
  assert.equal(priceToMicroUnits("0.0000005"), 0n);
  // 0.0000015 -> kept magnitude 1 is odd, half-to-even rounds up to 2.
  assert.equal(priceToMicroUnits("0.0000015"), 2n);
});

// ---------------------------------------------------------------------------
// capabilityTriState — absent boolean must be "unknown", never "false"
// ---------------------------------------------------------------------------

test("capabilityTriState: true -> supported", () => {
  assert.equal(capabilityTriState(true), "supported");
});

test("capabilityTriState: false -> unsupported", () => {
  assert.equal(capabilityTriState(false), "unsupported");
});

test("capabilityTriState: undefined (absent) -> unknown, NEVER false", () => {
  assert.equal(capabilityTriState(undefined), "unknown");
  assert.notEqual(capabilityTriState(undefined), false);
});

// ---------------------------------------------------------------------------
// fidelityFor — first-party vs aggregator (ADR-0009)
// ---------------------------------------------------------------------------

test("fidelityFor: a known first-party provider -> provider_verified", () => {
  assert.equal(fidelityFor("anthropic"), "provider_verified");
  assert.equal(fidelityFor("openai"), "provider_verified");
});

test("fidelityFor: an aggregator provider -> aggregator", () => {
  assert.equal(fidelityFor("openrouter"), "aggregator");
});

test("fidelityFor: an unlisted provider also falls to aggregator (fail closed toward caution)", () => {
  assert.equal(fidelityFor("mystery-labs"), "aggregator");
});

// ---------------------------------------------------------------------------
// importFromModelsDev — end-to-end golden transform over the fixture
// ---------------------------------------------------------------------------

test("importFromModelsDev: row counts match the fixture", () => {
  const catalog = importFromModelsDev(fixture);

  // anthropic/claude-sonnet-4-5 and openrouter/claude-sonnet-4-5 share the
  // same models.dev model id and collapse into ONE canonical model;
  // mystery-labs/mystery-mini is a second, distinct canonical model.
  assert.equal(catalog.canonicalModels.length, 2);
  // Three provider offerings: one per (provider, model) pair in the fixture.
  assert.equal(catalog.offerings.length, 3);
  // One price revision per offering.
  assert.equal(catalog.priceRevisions.length, 3);
});

test("importFromModelsDev: canonical dedup keeps one row per models.dev model id", () => {
  const catalog = importFromModelsDev(fixture);
  const slugs = catalog.canonicalModels.map((m) => m.canonicalSlug).sort();
  assert.deepEqual(slugs, ["claude-sonnet-4-5", "mystery-mini"]);
});

test("importFromModelsDev: anthropic offering prices convert exactly (ADR-0008)", () => {
  const catalog = importFromModelsDev(fixture);
  const anthropicOffering = catalog.offerings.find(
    (o) => o.provider === "anthropic" && o.providerModelId === "claude-sonnet-4-5",
  );
  assert.ok(anthropicOffering, "expected the anthropic offering to exist");

  const revision = catalog.priceRevisions.find(
    (r) => r.offeringId === anthropicOffering!.id,
  );
  assert.ok(revision, "expected a price revision for the anthropic offering");

  assert.equal(revision!.inputPerMtokMicrousd, 3_000_000n);
  assert.equal(revision!.outputPerMtokMicrousd, 15_000_000n);
  assert.equal(revision!.cacheReadPerMtokMicrousd, 300_000n);
  assert.equal(revision!.cacheWritePerMtokMicrousd, 3_750_000n);
});

test("importFromModelsDev: absent structured_output on the anthropic model -> unknown, not false", () => {
  const catalog = importFromModelsDev(fixture);
  const anthropicOffering = catalog.offerings.find(
    (o) => o.provider === "anthropic" && o.providerModelId === "claude-sonnet-4-5",
  );
  assert.ok(anthropicOffering);
  assert.equal(anthropicOffering!.capabilities.structuredOutput, "unknown");
  // Every other anthropic capability WAS reported and must not collapse to unknown.
  assert.equal(anthropicOffering!.capabilities.attachment, "supported");
  assert.equal(anthropicOffering!.capabilities.reasoning, "supported");
  assert.equal(anthropicOffering!.capabilities.toolCall, "supported");
  assert.equal(anthropicOffering!.capabilities.temperature, "supported");
  assert.equal(anthropicOffering!.capabilities.providerIdempotency, "unknown");
});

test("importFromModelsDev: the adapter matrix carries OpenAI provider idempotency into the catalog", () => {
  const payload: ModelsDevPayload = {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-retry": { id: "gpt-retry", name: "GPT Retry" },
      },
    },
  };
  const offering = importFromModelsDev(payload).offerings[0];
  assert.ok(offering);
  assert.equal(offering!.adapterRevision, "openai-v1");
  assert.deepEqual(offering!.endpointKinds, ["chat", "responses", "embeddings"]);
  assert.equal(offering!.capabilities.providerIdempotency, "supported");
});

test("importFromModelsDev: providers outside the explicit adapter matrix remain fail-closed", () => {
  const payload: ModelsDevPayload = {
    legacy: {
      id: "legacy",
      name: "Legacy",
      models: { "legacy-model": { id: "legacy-model", name: "Legacy Model" } },
    },
  };
  const offering = importFromModelsDev(payload).offerings[0];
  assert.ok(offering);
  assert.equal(offering!.adapterRevision, "unavailable");
  assert.deepEqual(offering!.endpointKinds, []);
  assert.equal(offering!.capabilities.providerIdempotency, "unknown");
});

test("importFromModelsDev: anthropic (first-party) price revision is provider_verified", () => {
  const catalog = importFromModelsDev(fixture);
  const anthropicOffering = catalog.offerings.find((o) => o.provider === "anthropic");
  const revision = catalog.priceRevisions.find((r) => r.offeringId === anthropicOffering!.id);
  assert.equal(revision!.fidelity, "provider_verified");
});

test("importFromModelsDev: openrouter (aggregator) price revision is aggregator", () => {
  const catalog = importFromModelsDev(fixture);
  const openrouterOffering = catalog.offerings.find((o) => o.provider === "openrouter");
  const revision = catalog.priceRevisions.find((r) => r.offeringId === openrouterOffering!.id);
  assert.equal(revision!.fidelity, "aggregator");
});

test("importFromModelsDev: missing cost block fails closed to unknown fidelity and null prices", () => {
  const catalog = importFromModelsDev(fixture);
  const mysteryOffering = catalog.offerings.find((o) => o.provider === "mystery-labs");
  assert.ok(mysteryOffering);
  const revision = catalog.priceRevisions.find((r) => r.offeringId === mysteryOffering!.id);
  assert.ok(revision);
  assert.equal(revision!.fidelity, "unknown");
  assert.equal(revision!.inputPerMtokMicrousd, null);
  assert.equal(revision!.outputPerMtokMicrousd, null);
  // Its one reported capability is a real false, and must stay unsupported,
  // not be confused with the unknowns around it.
  assert.equal(mysteryOffering!.capabilities.toolCall, "unsupported");
  assert.equal(mysteryOffering!.capabilities.attachment, "unknown");
});

test("importFromModelsDev: empty cost block {} fails closed to unknown fidelity and null prices", () => {
  // BUG: hasCost was `model.cost !== undefined`, so a present-but-empty cost
  // block ({}) was treated as PRICED with first-party (provider_verified)
  // fidelity while every price column was null — letting hard budgets treat
  // null as $0 free dispatch. A cost block with no usable numeric field must
  // yield fidelity 'unknown', exactly like a missing block.
  const payload: ModelsDevPayload = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-empty-cost": { id: "claude-empty-cost", name: "Empty Cost", cost: {} },
      },
    },
  };
  const catalog = importFromModelsDev(payload);
  const revision = catalog.priceRevisions[0];
  assert.ok(revision);
  assert.equal(revision!.fidelity, "unknown");
  assert.equal(revision!.inputPerMtokMicrousd, null);
  assert.equal(revision!.outputPerMtokMicrousd, null);
});

test("importFromModelsDev: cost block with all-null fields fails closed to unknown fidelity and null prices", () => {
  // A cost block present in the JSON but with every field null must behave
  // identically to a missing block: null prices, fidelity 'unknown'. (Before
  // the fix this even threw, since null was fed straight into priceToMicroUnits.)
  const payload = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-null-cost": {
          id: "claude-null-cost",
          name: "Null Cost",
          cost: { input: null, output: null, cache_read: null },
        },
      },
    },
  } as unknown as ModelsDevPayload;
  const catalog = importFromModelsDev(payload);
  const revision = catalog.priceRevisions[0];
  assert.ok(revision);
  assert.equal(revision!.fidelity, "unknown");
  assert.equal(revision!.inputPerMtokMicrousd, null);
  assert.equal(revision!.outputPerMtokMicrousd, null);
});

test("importFromModelsDev: catalog is stamped with the wire schema version", () => {
  const catalog = importFromModelsDev(fixture);
  assert.equal(catalog.schema, "manifold.v1");
});
