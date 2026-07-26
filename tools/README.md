# Release conformance and performance gates

`tools/conformance` replays recorded chat, Responses, and embeddings request/response shapes through the current OpenAI codecs. It makes no provider calls. The committed capability matrix is generated only from `adapter-metadata.json`.

```bash
npm run conformance:replay
npm run conformance:matrix:check
```

After a reviewed metadata change, run `npm run conformance:matrix` and commit the new matrix.

Ordinary CI runs the local deterministic `load:k6` and `load:flat-memory` fixtures.
The protected `real-target-release-gates` workflow job runs the corresponding
`:external` commands against an isolated deployed gateway. Configure required
reviewers for the GitHub `release-load` environment, then provide these
environment-scoped values without putting secrets in repository variables:

- `MANIFOLD_GATEWAY_URL` — isolated gateway base URL (variable)
- `MANIFOLD_PUBLIC_VIRTUAL_KEY` — fixture-only public-profile virtual key (secret)
- `MANIFOLD_ENTERPRISE_VIRTUAL_KEY` — fixture-only enterprise-profile virtual key (secret)
- `MANIFOLD_PROVIDER_BASELINE_MS` — measured provider baseline (variable)
- `MANIFOLD_HARD_BUDGET_SUCCESS_CAP` — isolated-account cap (variable)
- `MANIFOLD_FLAT_MEMORY_TARGET_URL` — exact 1 GiB stream endpoint (variable)
- `MANIFOLD_GATEWAY_MEMORY_PROBE_URL` — protected endpoint returning the gateway process RSS sample (variable)
- `MANIFOLD_GATEWAY_MEMORY_CONTRACT=v1` — confirms that endpoint returns `{ baselineRssBytes, peakRssBytes, bytes }`

The protected job preflights every required value without printing any value;
missing configuration fails the job. Its environment protection and single-flight
concurrency prevent concurrent probes from sharing an isolated hard budget. It
runs separate public and enterprise probes with their corresponding keys, then
runs the 1 GiB flat-memory probe.

`tools/load` external gates require a real configured target; missing environment exits nonzero.

```bash
MANIFOLD_GATEWAY_URL=https://gateway.example MANIFOLD_VIRTUAL_KEY=... MANIFOLD_LOAD_PROFILE=public_app MANIFOLD_PROVIDER_BASELINE_MS=... npm run load:k6:external
MANIFOLD_GATEWAY_URL=https://gateway.example MANIFOLD_VIRTUAL_KEY=... MANIFOLD_LOAD_PROFILE=enterprise_egress MANIFOLD_HARD_BUDGET_SUCCESS_CAP=10 MANIFOLD_REQUIRE_INGEST_LAG=1 npm run load:k6:external
MANIFOLD_FLAT_MEMORY_TARGET_URL=https://gateway.example/release/one-gib-stream MANIFOLD_GATEWAY_MEMORY_PROBE_URL=https://gateway.example/release/memory-observation MANIFOLD_GATEWAY_MEMORY_CONTRACT=v1 MANIFOLD_VIRTUAL_KEY=... MANIFOLD_FLAT_MEMORY_BYTES=1073741824 npm run load:flat-memory:external
```

The k6 probe subtracts the measured provider baseline to assert added-overhead P99 (public 15 ms; enterprise 23 ms), counting only HTTP 200 provider dispatches. Public probes require at least one successful dispatch. Enterprise probes require a positive `MANIFOLD_HARD_BUDGET_SUCCESS_CAP`, exactly that many successful dispatches, then at least one HTTP 402 body whose `error.code` is `BUDGET_RESERVE_DENIED`; an all-denied run fails. Enterprise ingest requires `X-Manifold-Ingested-At` when `MANIFOLD_REQUIRE_INGEST_LAG=1`. The local 1 GiB gate runs a child gateway process through the built core and samples that process with `ps`; it never retains the payload. A remote client cannot observe gateway RSS, so the external gate refuses to pass without the explicit memory-observation contract above.
