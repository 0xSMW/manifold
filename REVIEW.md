# Manifold SPEC.md — Adversarial Principal-Engineer Review

Reviewer posture: I must personally approve this for a production build, long-term operation, and 3am incident response. I reward precise contracts, coherent invariants, and executable detail; I do not reward breadth or confident prose. Every finding cites a section and states the failure scenario, the correction, and how to verify it.

Scope reviewed: `SPEC.md` (2,853 lines, §0–§28) in full, plus platform-limit verification against current (2026) Vercel, Neon, and Cloudflare documentation. The console wireframe was reviewed at the spec level (§11), not pixel level.

---

## 1. Verdict

**REJECTED for a production build.** Re-reviewable — and likely approvable — once the blocking checklist in §17 is closed.

This is a strong document: the ADR discipline, the ports/adapters seam, the immutability/content-addressing model, the deny-first authorizer, and the two-profile isolation are genuinely well-designed and mostly build-ready. The rejection is not a verdict on the vision. It is a verdict on four defects that make the durable-state layer either non-applicable, unmeasurable, or self-contradictory, plus a hot-path secret-handling gap that contradicts the spec's own headline invariant. Each is fixable with the concrete replacement text in §15. None requires abandoning the architecture.

I am rejecting rather than "approving with blocking changes" for one reason: two of the blockers (B1, B2) mean the schema as written will not `CREATE`, and the product's defining constraint (the 500 MB ceiling) cannot be measured for the deployment topology the console implies. You cannot conditionally approve a schema that does not apply or a capacity model that cannot be computed. Close B1–B4 and H1–H10 and this becomes an approval.

---

## 2. Executive finding — the largest systemic risk

**The spec never states its tenancy cardinality — one workspace per database, or many workspaces per database — and that single unstated decision silently breaks the storage-bounded mode, the RLS/pooling model, and the capacity promise at once.**

The console has a workspace switcher and the schema scopes every row by `workspace_id` (multi-tenant SaaS). But §13.2 measures footprint with `pg_total_relation_size` over `nspname='public'` — a database-wide number that cannot be attributed to one workspace — while `workspace.storage_ceiling_bytes` is per-workspace (500 MB each). These two facts cannot both be true in a multi-tenant database: every workspace's `storage_stat.total_bytes` would report the same database-wide total, so the tiers, forecasts, and emergency shedding all act on the wrong number. The entire §13 mechanism only works if each workspace is its own database.

The same unstated decision compounds three ways:

- **Capacity.** At the 500 MB default with the spec's own retention floors (72 h journal, 7 d reduced observations), sustained capacity is ~0.25 req/s for the indie profile and ~0.13 req/s for enterprise (arithmetic in §8). "An enterprise's governed internal model exit" runs 10–100 req/s. The ceiling and the target market are off by 2–3 orders of magnitude, and no supported-capacity limit is published.
- **Isolation.** `budget_window_state` — the money hot row — carries no `workspace_id` at all (§6.7), so RLS cannot protect it and the query-lint rule cannot pass on it.
- **Secrecy.** The zero-DB-read hot path (ADR-0005) has no place to read the provider-secret ciphertext from (§7.6), because the snapshot deliberately omits it.

Fixing the tenancy-cardinality statement first (§15, B2) forces the storage, isolation, and capacity questions into the open and makes the rest of the corrections mechanical. Everything else in this review is downstream of that one missing sentence.

---

## 3. Severity-ranked findings

Severity: **BLOCKER** = cannot approve for production; **HIGH** = must fix before the milestone that ships the affected subsystem; **MEDIUM** = fix before GA / will cause drift or incidents; **LOW** = correctness/quality debt. Replacement text for BLOCKER/HIGH is in §15.

### Blockers

| ID | §/evidence | Failure scenario | Required correction | Verification |
|---|---|---|---|---|
| B1 | §6.8, §6.9, §6.12, §6.7 (`budget_reservation`): every RANGE-partitioned table declares `PRIMARY KEY (id)` and/or `UNIQUE` constraints that omit the partition key `created_at` | Postgres rejects the DDL: "unique constraint on partitioned table must include all partitioning columns." `observation_event`, `observation`, `trace_summary`, `policy_decision`, `usage_record`, `cost_ledger`, `audit_event`, `budget_reservation` all fail to create. The database — the "authoritative for everything durable" layer (ADR-0006) — does not exist. | Include `created_at` in every PK and unique on a partitioned table; move dedup/idempotency uniqueness to `(…, created_at)` and accept per-partition dedup, or dedup in the reducer. Exact DDL in §15.B1. | WP-012 test "DDL applies" must run against real Postgres (Testcontainers) and currently would fail — that failure is the acceptance signal. Add an assertion that each partitioned relation's PK contains `created_at`. |
| B2 | §13.2 (`pg_total_relation_size` over the whole DB) vs `workspace.storage_ceiling_bytes` per workspace (§6.2); console workspace switcher (§11.2) | In any multi-tenant database, per-workspace footprint is unmeasurable; every workspace reports the DB-wide total; tiers/forecasts/shedding act on a number that is not the workspace's. Storage-bounded mode is inoperable for the topology the console implies. | State the deployment cardinality explicitly (ADR). If one-workspace-per-database: say so, and gate the console's multi-workspace UI to an operator/admin plane. If multi-tenant: replace catalog-size measurement with per-workspace accounting (row counts × measured avg row width, or a per-tenant byte counter maintained at write/compaction time). Text in §15.B2. | A deterministic test (§21.10) that provisions two workspaces in one database, writes a known distribution to each, and asserts each `storage_stat.total_bytes` reflects only that workspace. Today no such test can pass. |
| B3 | ADR-0005 (zero DB reads on hot path); §7.1 `credmap` = credential id + dek id, "NOT the secret"; §7.6 "decrypt … from the credential store"; §14.3 | To decrypt a provider secret the gateway needs the ciphertext (`provider_credential.encrypted_secret`), which lives only in Postgres and is deliberately not in the snapshot. Every request therefore either reads Neon on the dispatch path (violates ADR-0005) or reads an unspecified in-process cache with unspecified invalidation (use-after-revoke, stale-secret auth failures). The headline invariant and the security model collide with no resolution. | Specify the ciphertext's hot-path location and its cache/invalidation contract. Recommended: carry the AES-GCM ciphertext (not plaintext) in the snapshot `credmap`, decrypt in-process with the cached DEK; rotation/revocation republishes the snapshot (already the config path). Text in §15.B3. | A test asserting zero Neon queries on the dispatch path including credential retrieval (extend WP-021/WP-022 "zero DB reads" assertion to cover the secret fetch), plus a rotation test asserting the old ciphertext stops working within the publish window. |
| B4 | §2.3, §7.4, §3.7, §8.2 assume Edge Config "~5 MB/store," "< 1 s" propagation, free sharding. Actual (Vercel docs, updated 2026-03-19): **512 KB** max store size (Enterprise; 64 KB Pro, 8 KB Hobby), **up to 10 s** propagation, **10 stores/account, 3/project**, guidance "avoid Edge Config for frequently updated data" | The primary hot-path store is ~10× smaller than the design assumes. The §7.4 budget ("~4,000 keys + ~2,000 routes + ~2,000 offerings") is off by 10×; realistic capacity is ~400 keys / ~200 routes / ~200 offerings before pressure. Sharding caps at 3 stores/project = 1.5 MB, so any non-trivial tenant cannot fit the hot path in Edge Config and silently falls to boot-fallback (a control-plane fetch) — which is no longer the "Edge Config hot path" the SLOs assume. Per-PR ephemeral preview stores (§2.5) exhaust the 10-store account cap after a few open PRs. | Re-baseline all snapshot sizing to 512 KB; make boot-fallback (§7.4) the documented default for tenants over the cap; treat Edge Config as an optional accelerator, not the required hot path; move key material out of the per-request store or accept sharded boot-fallback. Fix propagation math (10 s, not 1 s) everywhere it feeds a grace window. Text in §15.B4. | Snapshot build size-gate must warn at 80% of **512 KB** (not 5 MB) and the CI must include a fixture tenant whose snapshot exceeds one store and asserts correct shard/boot-fallback behavior. |

### High

| ID | §/evidence | Failure scenario | Required correction | Verification |
|---|---|---|---|---|
| H1 | §8.1, §8.4, §17.2: reconcile runs in-request via `after()`; the sweep only "releases the hold" at `expires_at` | A completed request is billed by the provider, then the invocation is killed (maxDuration, deploy, crash) before reconcile. The sweep expires the reservation and releases `reserved` — but never debits `committed` with the real cost. Hard-budget spend silently under-counts; over time a "hard" budget is exceeded with no signal. | Drive reconciliation from the durable ingest terminal event (which carries real usage/cost), not from best-effort `after()`. The `reconcile` job must reconstruct actual cost from the terminal `Observation` and move `reserved→committed`; expiry must reconcile-to-actual-if-terminal-exists, not zero. Text in §15.H1. | Chaos test (§21.12): kill the invocation after provider bytes but before reconcile; assert `committed` reflects actual cost after the next ingest/reconcile cycle, and the budget cannot be overspent across 10k such requests. |
| H2 | §16.3 (single `budget_window_state` row per budget, `FOR UPDATE`); §3.4 (one DO per budget); DO throughput ~500–1000 rps (CF docs) | A workspace-level hard budget makes the workspace-root window row (or root DO) a single serialization point that every enterprise hard-budget request must lock. Under concurrency the ≤8 ms P99 and "no oversell" claims are mutually exclusive: requests serialize on one row/DO; on Cloudflare the DO returns "overloaded" past ~1k rps. | State the throughput ceiling per budget explicitly. Reduce root contention with per-shard sub-counters that reconcile to the root, or document a supported max concurrent hard-budget rps per budget subtree. Text in §15.H2. | Load test (§21.7) N concurrent requests against a 3-level budget tree with a workspace root cap; record P99 and assert the documented ceiling; assert overload behavior is a clean `BUDGET_RESERVE_DENIED`/backpressure, not corruption. |
| H3 | §6.7 `budget_window_state` has no `workspace_id`; PK `(budget_account_id, window_start)`; `window` enum includes `rolling_30d`, `total` but the table models only fixed buckets; no `reserved_tokens` | (a) A durable tenant row is outside RLS and the query-lint — a resolution bug can read/update another tenant's money counter. (b) `rolling_30d`/`total` hard budgets cannot be enforced from a single `window_start` row. (c) Token-unit hard budgets have no `reserved_tokens` counter, so they cannot reserve pre-dispatch. | Add `workspace_id NOT NULL` + RLS; define how rolling/total windows compute headroom (trailing sum vs. bucket); add `reserved_tokens`. Text in §15.H3. | RLS cross-tenant test on `budget_window_state`; a reserve test for each `window` value including `rolling_30d` and `total`; a token-budget oversell test. |
| H4 | §13.1 lists `cost_ledger` under "never compacted away"; §13.4 says its "rows past window summarized … totals kept"; §6.15 immutability trigger forbids `DELETE` on `cost_ledger`; 500 MB ceiling | Contradiction: `cost_ledger` is simultaneously inviolable-per-row, summarized-then-dropped, and undeletable. Under sustained traffic it either grows unbounded (breaks the ceiling) or is partition-dropped (breaks "inviolable" and loses per-request cost). An engineer will pick one and violate a stated invariant either way. | Restate the invariant precisely: *aggregate* cost totals (in `usage_aggregate` / a monthly cost rollup) are preserved forever; per-request `cost_ledger` rows are retained ≥ `min_trace_days`, then dropped by partition after their window is summarized. Confirm partition DROP is the sanctioned path and the DML trigger does not fire on it. Text in §15.H4. | Deterministic test: after compaction, monthly cost totals equal pre-compaction sums to the µ$; per-request `cost_ledger` older than the window is gone; footprint drops. |
| H5 | §13.1–§13.4; arithmetic in §8 of this review | The 500 MB default supports ~0.13–0.25 req/s sustained at the stated retention floors. Any real gateway fills the ceiling in hours-to-days; emergency shedding becomes the steady state; the product's core promise ("keep durable state under the ceiling without losing what matters") fails for its stated audience. | Publish a supported-capacity table (req/day at each ceiling and retention setting) and either scale the default ceiling with expected traffic or shorten the compaction horizon (reduce observations to hourly aggregates within hours, not 7 days). Text in §15.H5. | A load-to-steady-state test that runs at the documented supported rate for the documented retention and asserts the ceiling holds without entering emergency tier. |
| H6 | §6.9 `usage_aggregate.dims` = 7 dimensions; §13.4 hourly retained 14 d | The compaction *target* is itself unbounded: at 5,000 distinct dimension combinations, hourly aggregates alone are ~286 MB over 14 days (calc in §8) — more than half the ceiling — before any raw detail. High-cardinality tenants breach the ceiling via the very table meant to save them. | Bound aggregate cardinality: cap dimensions, collapse high-cardinality dims (offering_id, cost_center) at coarser grains, or shorten hourly retention. Add aggregate footprint to the forecast. Text in §15.H6. | Deterministic test seeding N dim-combos; assert hourly-aggregate footprint stays within its budgeted share of the ceiling. |
| H7 | §7.1 (keys in snapshot), §8.5 (revoke → expedited publish), §11 Keys (mint copy-once), ADR-0005 (zero DB) | A freshly minted virtual key lives only in Postgres until a config publish rebuilds the snapshot. Because auth is snapshot-only (zero DB), the new key returns `AUTH_KEY_UNKNOWN` until someone runs Publish. Self-serve key issuance is broken; the draft-then-publish model and instant-key UX contradict each other. | Decide and state: either key mint triggers an immediate scoped snapshot publish (decouple key publication from route/policy drafts), or the authenticator has a narrow, cached DB fallback for very-recently-minted keys. Text in §15.H7. | E2E: mint a key, immediately call the gateway with it, assert success within the stated activation SLA; assert route/policy drafts are not published by a key mint. |
| H8 | §2.6, §16.3 (reservation P99 ≤ 8 ms); Neon scale-to-zero default 5 min, cold start median 1.8 s / p95 2.6 s / worst 3.1 s (Neon docs); warm-ping cron hits the gateway, not Neon | After 5 minutes idle, the first enterprise hard-budget request waits ~1.8–3.1 s for Neon to wake — 200–400× the 8 ms SLO. Nothing in the design keeps Neon warm. Low-traffic enterprise installs (exactly the ones with hard budgets) hit this constantly. | Require scale-to-zero disabled (Launch+ plan) for any installation using hard budgets, or add a DB keep-warm cron that issues a trivial Neon query every < 5 min. State the plan dependency. Text in §15.H8. | An integration test that idles past the suspend threshold then measures first-reservation latency against the documented (warm) SLO with keep-warm enabled. |
| H9 | ADR-0017, §8.1 ("emit … after response starts"), §8.3 | `after()` is best-effort: if the instance dies after responding but before `after()` runs, the terminal event is lost unless the ledger write happened synchronously before the response completed. The spec's durability claim ("ingest sink down → after() still enqueues to job_ledger") does not hold if the enqueue itself lives inside `after()`. | Persist the terminal-event intent to `job_ledger` (or the reservation txn) synchronously at terminal, before releasing the response; `after()` becomes an optimization, not the durability boundary. Text in §15.H9. | Chaos test: SIGKILL the instance between last provider byte and `after()`; assert the observation still lands via the ledger. |
| H10 | §7.3 "verifies the signature against the installation's pinned public key"; §14.3 "pins the installation public key"; §19.3 single `MANIFOLD_SNAPSHOT_PUBLIC_KEY` env (control-plane signs, gateway verifies) | The snapshot signer identity is contradictory: is the snapshot signed by one control-plane keypair (env var, global) or per-installation? `gateway_installation.public_key` is separately the installation's *ingest* identity. Conflating them means either the wrong key verifies the snapshot (integrity bypass) or key rotation is undefined. | Separate the two keypairs explicitly: (1) snapshot-signing keypair owned by the control plane, gateway pins its public key; (2) installation-identity keypair for ingest. Define rotation for each. Text in §15.H10. | Signature-rejection test uses the snapshot-signing public key; a test asserts an installation-identity key cannot validate a snapshot and vice-versa. |

### Medium

| ID | §/evidence | Issue | Correction |
|---|---|---|---|
| M1 | §6.3–§6.7 | Forward/circular FKs make the "normative" straight-line DDL non-applicable: `provider_model_offering.active_price_revision_id` ↔ `provider_price_revision.offering_id` is a true cycle; `virtual_key → budget_account`, `gateway_ingress_profile → gateway_policy_revision` are forward refs. | State that FKs are added via `ALTER TABLE` after all `CREATE TABLE`s (Drizzle's default), or mark the cyclic FK `DEFERRABLE INITIALLY DEFERRED`. Declare which artifact is normative when SQL order and Drizzle output differ. |
| M2 | §6.16, §15.2 | `current_setting('manifold.workspace_id')` without the `missing_ok` second arg throws on an unset GUC; with PgBouncer transaction pooling, `SET LOCAL` only applies inside an explicit transaction, so "reads never open write transactions" leaves reads with no GUC (error or, worse, silent empty result → looks like data loss). | Use `current_setting('manifold.workspace_id', true)` and treat NULL as fail-closed; wrap every read in an explicit transaction that issues `SET LOCAL`; document the extra round-trip on the pooler. |
| M3 | §6.16, §6.4 | `provider_price_revision` holds both global (`workspace_id` NULL) and per-tenant override rows. RLS cannot be "disabled for global rows" of a table; a single policy governs all rows. As written, either overrides leak across tenants (RLS off) or global prices become invisible to tenants (RLS on without a NULL clause). | RLS policy must be `USING (workspace_id = current_setting('manifold.workspace_id', true) OR workspace_id IS NULL)`; global rows are read-only to the app role via grants, not via RLS-off. |
| M4 | §8.2 | Config apply commits the DB revision, then writes Edge Config; on store-write failure a followup job retries. During the window, DB says active=X, store serves X-1, and boot-fallback gateways (reading DB) disagree with Edge-Config gateways. For a key revoke / entitlement removal this is a security-staleness window across instances. | Add an explicit "published" state distinct from "db-active"; readiness/`applied_config_revision` must gate on store confirmation; define the max reconciliation SLA and alert if exceeded. |
| M5 | §0.2, §0.3, §10.3 | Reason codes and control-plane error codes are conflated. ~12 error codes in §10.3 (`DUPLICATE_ROUTE`, `OFFERING_NOT_FOUND`, `KEY_NOT_ACTIVE`, `ALREADY_APPROVED`, `ALLOCATION_EXCEEDS_PARENT`, `HOSTNAME_TAKEN`, `USER_CODE_INVALID`, `THRESHOLDS_UNORDERED`, `COMPACTION_IN_PROGRESS`, `REVISION_NOT_FOUND`, `VALIDATION`, `NOT_FOUND`) plus `INVALID_TRANSITION` and `IMMUTABLE_ROW` are absent from the §0.2 registry the CI drift-gate reads. | Either register all `code` values in `reason-codes.ts` (one enum, CI-generated table) or define two enums (`ReasonCode`, `ErrorCode`) and state which populates `error.code` vs `error.reason_codes[]`. The "generated from the enum" claim must be made true. |
| M6 | §6.8 (`capture_ref jsonb`) vs §13.5 ("`capture_ref` payloads stored compressed (zstd) in a `bytea`/TOAST column") | The capture column's type and meaning are inconsistent: JSON metadata/reference vs. inline compressed bytes. This changes whether captures count against the ceiling and whether they can live in an external object store. | Split concerns: `capture_meta jsonb` (mode, byte count, redaction ref) and `capture_blob bytea` (zstd payload, nullable), or `capture_ref` = external object key when exported. State which counts toward the ceiling. |
| M7 | §6.10 | The normative cost formula sums input, output, cache_read, reasoning — but omits `cache_write_per_mtok` and `audio_in/out_per_mtok`, which exist in the schema and registry. Prompt-caching writes and audio are undercounted → budget and billing drift. | Add the missing terms to the §6.10 formula and to the reservation estimate where applicable. |
| M8 | §6.3 (`action.source = 'discovered'`) vs §15.4 ("attribution resolved server-side, never caller-asserted") | If actions are auto-created ("discovered") from traffic, the identifier must come from the request — contradicting server-side-only attribution — and creates an unbounded, caller-influenced write path (cardinality, tenancy). | Define exactly what "discovered" reads, from where, under what rate limit and cap; or remove it. If it reads a request header/body field, reconcile with §15.4 explicitly (it is attribution *input*, validated and capped, not authority). |
| M9 | §10.3 (`providers/{id}/validate`, `routes/{id}/test` do egress from the control plane), §14.4 (SSRF policy specified for the gateway only) | The control plane fetches operator-supplied `base_url`s during validate/test with no stated SSRF policy — an SSRF/confused-deputy vector (`providers:write` can point validation at internal services). | Apply the §14.4 SSRF/egress policy to all control-plane egress; share one `Fetcher` port with the policy baked in. |
| M10 | §4.4 (`Crypto` port methods return `Uint8Array` synchronously) vs §3 (Cloudflare Workers) | Workers' SubtleCrypto is async; the synchronous `hmacSha256`/`sealAesGcm` port cannot be implemented on Cloudflare with WebCrypto. Node satisfies it (`crypto.createHmac`), Cloudflare cannot without a userland sync crypto impl (slower, higher audit surface) — a real crack in the "faithful adapter" claim. | Make the `Crypto` port async (`Promise<Uint8Array>`) and thread it through `gateway-core`'s hot path, or mandate a vetted sync crypto lib for the CF adapter and record the delta in §3.7. |
| M11 | §6.12 (`audit_event` has `before_hash`/`after_hash` = target-content hashes) vs §11 Audit / §9.1 (`AuditService.verifyChain`) | There is no column chaining audit rows to each other, so "the chain verifies" is unsupported: deleting or altering a row is not detectable by any chain. `before/after_hash` describe the mutated object, not a tamper-evident log. | Add `prev_hash`/`row_hash` (hash of this row incl. `prev_hash`) to build an append-only hash chain, or drop the tamper-evidence claim and call it a content-diff log. |
| M12 | §16.5 | Public-path rate limiting must add zero DB reads, but the bucket-state location is unspecified. In-memory per Fluid instance gives instances×bucket overshoot (not "regions×bucket"), and under autoscaling the limit barely bounds abuse. | Specify the store (regional KV / Durable-Object-per-key on CF; a bounded per-instance + periodic-reconcile scheme on Vercel) and restate the real overshoot bound as instances×bucket. |
| M13 | §16.3 | "Lock rows … leaf-to-root by id" conflates two orders. ULIDs are time-ordered, not depth-ordered, so leaf-to-root ≠ ascending-id; two transactions locking overlapping chains in traversal order can deadlock. | Mandate a single global lock order: collect all budget rows in the chain, sort by `id` ascending, lock in that order. |
| M14 | §16.3 | The reserve SQL shows only `SELECT … FOR UPDATE` + `UPDATE`; on the first request of a new window the `budget_window_state` row does not exist, so concurrent first-requests race to insert → oversell at every window boundary. | Use `INSERT … ON CONFLICT (budget_account_id, window_start) DO UPDATE … RETURNING` (upsert-then-check) or an advisory lock on `(budget, window_start)` to serialize creation. |
| M15 | §9.2 (apply takes `planHash`), §16.2 (precondition compares `baseConfigHash`), §10.3 (`GET /config/plan` marked read-only) | Apply-by-`planHash` requires the plan (with its `baseConfigHash`) to be persisted, but `GET /config/plan` is "read" (no txn/persist). Either the plan isn't stored (apply can't resolve the precondition) or the GET writes (contradiction). | Persist plans as first-class rows (or in `config_operation` with `outcome='planned'`) written by an explicit `POST /config/plan`; apply resolves `planHash → baseConfigHash`. Change the verb/txn column in §10.3. |
| M16 | §10.1 (idempotency store: request hash + first response, 24 h) | No idempotency table exists in §6; its storage cost (full stored responses for 24 h) and cleanup are unaddressed and count against the ceiling. | Add an `idempotency_key` table (key, request_hash, response_blob, workspace_id, created_at) with its own retention; include it in the storage forecast. |
| M17 | §22 | Storage-bounded mode (§13) is M4, but real provider traffic starts at M2 (base-URL swap). Any M2/M3 production deployment accumulates observations with no compaction for two milestones → Neon fills. | Land a minimal retention/partition-drop pass in M2 (even before full forecasting), or state that M2/M3 are non-production-traffic milestones. |
| M18 | §2.7, §13.9 | Per-workspace compaction is driven by one global cron; with many workspaces per control plane, a single `* * * * *`/hourly cron cannot compact them all within the interval. | Fan out compaction as per-workspace `job_ledger` jobs claimed by drainers with `SKIP LOCKED`; the cron enqueues, workers execute. |
| M19 | §8.4, §6.10 | The reservation estimate uses `max_output_tokens`; if the client omits `max_tokens`, the ceiling is the model's max output (e.g., 64k) → huge over-reservation that denies concurrent traffic though actual use is tiny. `expires_at` vs the 300 s max stream is unspecified (expiry mid-stream → double count at reconcile). | Define the default `max_output` when unset (model cap vs a policy default), cap reservation estimates, and set `expires_at ≥ overall_ms` so a reservation never expires mid-stream. |
| M20 | §3.3 | Workers KV write limit is ~1 req/s per unique key (CF docs). The `snapshot:<installation>:active` pointer is written on every publish; expedited revoke publishes + config applies can exceed 1 write/s/key → rejected/queued writes stall revocation on Cloudflare. | Shard the pointer or batch publishes; document the max publish rate per installation on CF; ensure expedited revoke has a path that does not depend on a >1 rps pointer write. |

### Low (condensed)

| ID | §/evidence | Issue |
|---|---|---|
| L1 | TOC (§lines 33–60) vs body; intro line 17 | Section numbering drifts: TOC lists §26 Unresolved / §27 DoD, but the body has §26 Clean-room, §27 Unresolved, §28 DoD. Intro says "§27 is where a new engineer starts" — that content is now §28.3. In a doc that declares every identifier normative, its own cross-refs are wrong. |
| L2 | §0.3, §10.2 | Manifold reason codes placed in OpenAI `error.code` may confuse strict OpenAI SDK clients that switch on known `code` values; consider `X-Manifold-Code` header and keep OpenAI-native codes in `error.code`. |
| L3 | §8.6, §11 Settings | Device-authorization approve-by-`user_code` is phishable (attacker's code approved by a logged-in admin); the approve screen must show requested scopes + origin and never auto-approve. |
| L4 | §6.5 (`gateway_target → provider_credential_id`) | Immutable route revisions reference a mutable credential that can later be revoked; publish/rollback must validate credential liveness or the snapshot points at a dead credential. |
| L5 | §6.7 | `budget_account` unique `(workspace_id, scope_type, scope_id, window)` with nullable `scope_id` allows duplicate workspace-level budgets (SQL NULL ≠ NULL). Use `COALESCE(scope_id,'')` in a partial unique. |
| L6 | §6.12 (`alert_rule`) | The alert *evaluation* engine (metric → threshold over window → dispatch) is unspecified; only `alert_dispatch` exists. Define who evaluates rules and how often. |
| L7 | §8.4, §2.6 | Input-token estimation for reservations requires in-gateway tokenization (tiktoken etc.), unbudgeted in the ≤8 ms path and absent from the snapshot data. |
| L8 | §2.5 | Per-PR ephemeral Edge Config stores compete for the 10-store account cap; a handful of open PRs exhausts it. Use one shared preview store with namespaced keys. |
| L9 | §3.1, §3.7 | OpenNext + Next.js 16 on Workers is called "some edge cases"; running the full control plane on Workers is a substantial parity risk that is understated. |
| L10 | §2.8, §14.4 | The header forward-allowlist is never enumerated ("safe headers"); engineers will guess. List the exact forwarded request headers and the injected provider headers. |
| L11 | §14.3, ProviderService.rotateSecret | Provider-credential/DEK cache invalidation on rotation/revoke is unspecified; a cached ciphertext can be used after revoke. Define TTL/invalidation. |

---

## 4. Requirements coverage matrix

Traced from the intended operating model as stated in the ADRs (§1), release gates (§14.1), and DoD (§28), since no separate product spec was provided. Status: **OK** (designed, located, tested, operable), **WEAKENED** (present but undermined by a finding), **CONTRADICTED**, **MISSING**.

| # | Requirement (source) | Design | Impl location | Test | Operational control | Status |
|---|---|---|---|---|---|---|
| R-01 | OpenAI-compatible data plane: chat, responses, embeddings, models; Responses ≠ Chat (ADR-0010) | §10.2, endpoint codecs | WP-020 | Conformance fixtures §21.6; capability matrix | Capability matrix published each release | OK |
| R-02 | Hot path reads one signed snapshot, zero DB reads (ADR-0005) | §7, §8.1 | WP-021/022 | "zero DB reads" assertion | — | **CONTRADICTED** by B3 (secret ciphertext) and H7 (key activation) |
| R-03 | Two ingress profiles bound to trusted host, pre-auth (ADR-0001) | §14.6, §15.4 | WP-045 | §15.5 negative set; `AUTH_PROFILE_MISMATCH` | Deployments readiness | OK |
| R-04 | Hard budgets reserve atomically, no oversell (ADR-0012, §16.3) | §8.4, §16.3 | WP-042 | Oversell test §21.7 | Budgets view; alerts | **WEAKENED** by H1 (lost commit), H2 (root contention), H3 (no ws_id / rolling / tokens), M14 (window race) |
| R-05 | Immutable content-addressed revisions; rollback = republish (ADR-0007) | §6.15, §8.2 | WP-025/026 | Immutability trigger tests | Publish view; audit | OK (note B1 affects partitioned neighbors, not config_revision) |
| R-06 | Durable state under a hard 500 MB ceiling, truth preserved (ADR-0014) | §13 | WP-050–053 | Deterministic storage §21.10 | Storage view; tiers | **CONTRADICTED** by B2 (measurement), H4 (cost_ledger), H5 (capacity), H6 (aggregate cardinality) |
| R-07 | Money is integer µ$; documented rounding (ADR-0008) | §6.10 | WP-011/043 | Exhaustive rounding §21.5 | — | **WEAKENED** by M7 (missing cache_write/audio terms) |
| R-08 | Provider secrets envelope-encrypted, never leak (§14.1.2) | §14.3 | WP-024 | Secret-leak gate §21.8 | — | **WEAKENED** by B3 (hot-path fetch), L11 (cache invalidation) |
| R-09 | Every non-reference row tenant-scoped; RLS + lint + filter (§15) | §15.2, §6.16 | WP-002/012 | Cross-tenant §15.5; RLS smoke | Query-lint CI | **WEAKENED** by H3 (`budget_window_state`), M2 (GUC/pooling), M3 (`provider_price_revision`) |
| R-10 | Async ingest is durable; never blocks provider path (ADR-0017) | §8.3, §17 | WP-027 | Chaos §21.12 | Ingest-lag banner; DLQ | **WEAKENED** by H9 (`after()` not crash-durable) |
| R-11 | Snapshot integrity via signing; fail-closed to last-good (§7.3) | §7.3, §14.3 | WP-026 | Tamper-rejection §21.8 | `snapshot_verify_fail` page | **WEAKENED** by H10 (signer identity contradiction) |
| R-12 | Bounded capture; flat streaming memory (ADR-0020) | §8.1, §14.5 | WP-023 | 1 GB flat-memory gate §21.7 | Capture policy | OK |
| R-13 | CLI is a stable human + agent contract (ADR-0013, §12) | §12 | WP-054/055 | §12.11 golden fixtures | — | **WEAKENED** by CLI-review items (partial-failure stream, exit-code taxonomy) |
| R-14 | Cloudflare is a faithful adapter, not a second architecture (ADR-0004) | §3 | WP-057 | Shared contract suite | §3.7 deltas | **WEAKENED** by M10 (sync crypto port), H2 (DO throughput), M20 (KV write cap) |
| R-15 | Vercel is the primary, fully deployable target (ADR-0004, §2) | §2 | WP-014/017 | Preview deploy | Rollback §2.9 | **WEAKENED** by B4 (Edge Config sizing), H8 (Neon warm) |
| R-16 | Registry from models.dev; hard budgets need verified prices (ADR-0009) | §11.6 | WP-015/016 | Mapping goldens; fidelity gate | Registry-sync PR | OK |
| R-17 | Migrations expand/contract, rollback-safe (§20) | §20 | WP-012 | Prod-size migration test | — | **WEAKENED** by B1 (initial partition DDL won't apply) |
| R-18 | Tamper-evident audit trail (§11 Audit, §9.1 verifyChain) | §6.12 | WP-044 | Chain verify | Audit view; SIEM export | **WEAKENED** by M11 (no chaining column) |
| R-19 | Observability of Manifold itself; ingest-lag honesty (§18) | §18 | WP-029 | — | SLOs, alerts, health | OK |
| R-20 | Per-user (public) budgets opt-in (U4) | schema flag | deferred | — | — | OK (explicitly deferred; keying undefined but out of v1) |

Silent scope expansions / duplications flagged: `action.source='discovered'` (M8) expands attribution into a caller-influenced write path beyond the "server-side only" requirement; the reason-code registry is duplicated/forked between §0.2 and §10.3 (M5).

---

## 5. Invariant ledger

Each invariant, where it is meant to hold, where it can break today.

| Invariant (source) | Enforced by | Holds? | Break condition |
|---|---|---|---|
| Every non-reference row carries `workspace_id` and is RLS-filtered (§0 conventions, §15.1) | column + RLS + lint | **No** | `budget_window_state` has no `workspace_id` (H3); `provider_price_revision` RLS can't be "off for global rows" (M3) |
| Profile is bound to trusted host pre-auth; no request input changes it (ADR-0001) | edge resolve, snapshot | Yes | — |
| Public and enterprise credential pools are disjoint (ADR-0001, §14.6) | mint-time + snapshot-build + authorizer | Yes | — |
| Zero DB reads on the routing/auth path (ADR-0005) | snapshot-only pipeline | **No** | Secret ciphertext not in snapshot (B3); newly-minted key not in snapshot (H7) |
| Hard budget cannot oversell (ADR-0012, §16.3) | `FOR UPDATE` window row; unique reservation | **Partially** | Lost commit under-counts (H1); window-rollover race (M14); rolling/total/token windows unmodeled (H3) |
| Reservation adds ≤ 8 ms P99 (§2.6) | one-row lock | **No** | Neon cold start 1.8–3.1 s (H8); root-budget contention serializes (H2) |
| Immutable revisions never mutate except whitelisted deltas (§6.15) | BEFORE UPDATE/DELETE trigger | Yes for DML | Trigger does not fire on partition DROP; interacts with H4 (cost_ledger) |
| Truth tables (cost/usage/budget/audit) never shed (§13.3) | retention design | **Contradicted** | `cost_ledger` cannot be both inviolable-per-row and bounded (H4); aggregates unbounded (H6) |
| Durable footprint stays < ceiling (ADR-0014) | measure/forecast/compact | **Unproven** | Measurement is DB-wide not per-workspace (B2); capacity infeasible at floors (H5) |
| Provider secret never in logs/snapshot/headers/metrics (§14.1.2) | envelope encryption, log redaction | Mostly | Hot-path ciphertext location undefined (B3); cache invalidation undefined (L11) |
| Streaming memory is flat regardless of response size (ADR-0020) | bounded ring tee | Yes | — |
| Snapshot is signed and verified; fail-closed to last-good (§7.3) | ed25519 sign/verify | **Ambiguous** | Signer keypair identity contradictory (H10) |
| Ingest is at-least-once + idempotent; provider path unaffected (ADR-0017) | dedup unique + ledger | **Partially** | `after()` not crash-durable (H9); dedup unique invalid under partitioning (B1) |
| Attribution ids resolved server-side, never caller-asserted (§15.4) | ingest derivation | **Partially** | `action.source='discovered'` implies caller-influenced creation (M8) |
| One active config revision per installation (§16.2) | partial unique `config_active_uq` | Yes | — |
| Audit is append-only and chain-verifiable (§9.1) | trigger + verifyChain | **No** | No chaining column exists (M11) |

---

## 6. Unresolved contradiction list

Direct internal contradictions an engineer cannot resolve from the text:

1. **Zero-DB hot path vs. secret storage.** ADR-0005 (no DB reads) vs. §7.6 (decrypt secret from the credential store, which is Postgres) — B3.
2. **Zero-DB hot path vs. key issuance.** Auth is snapshot-only (§7.1) but keys are minted to Postgres and only enter the snapshot on publish (§8.5) — H7.
3. **`cost_ledger` inviolable vs. compacted vs. undeletable.** §13.1 "never compacted away" vs. §13.4 "rows past window summarized" vs. §6.15 DELETE forbidden — H4.
4. **`capture_ref` type.** `jsonb` (§6.8) vs. zstd `bytea`/TOAST payload (§13.5) — M6.
5. **Snapshot signer identity.** "installation's pinned public key" (§7.3, §14.3) vs. single control-plane env key (§19.3) — H10.
6. **Attribution authority.** "resolved server-side, never caller-asserted" (§15.4) vs. `action.source='discovered'` (§6.3) — M8.
7. **Edge Config capacity/propagation.** "~5 MB/store, < 1 s" (§2.3, §7.4, §8.2) vs. documented 512 KB / up to 10 s — B4.
8. **Reason-code single source.** §0.2 "generated from the enum, drift fails the build" vs. §10.3 error codes absent from that enum — M5.
9. **Per-workspace ceiling vs. DB-wide measurement.** `workspace.storage_ceiling_bytes` (§6.2) vs. `pg_total_relation_size` over the whole schema (§13.2) — B2.
10. **`GET /config/plan` read-only vs. apply-by-planHash.** §10.3 (read) vs. §9.2/§16.2 (apply needs a persisted plan) — M15.
11. **Reservation latency claim vs. hierarchy.** "one row lock, sub-8 ms" (§16.3) vs. "check the chain leaf-to-root in one transaction" (N locks incl. a shared root row) — H2.
12. **Section numbering.** TOC/intro vs. body (§26/§27/§28) — L1.

---

## 7. Quantitative storage proof — the 500 MB ceiling fails at stated floors

The prompt demands a quantitative budget proving the durable footprint stays under the ceiling during steady operation, spikes, delayed compaction, failed jobs, index bloat, migrations, and recovery — or an explicit supported-capacity limit. The design provides neither; here is the failure analysis with the arithmetic.

Per-request durable cost is dominated by the mandated minimum retention (§13.1, §13.4): `min_detail_hours` = 24 h (journal grows to 72 h) and `min_trace_days` = 7 d (reduced observations). Using conservative per-row estimates (heap + index; ULID text ids ≈ 27 B; Postgres row header 24 B; 3 events/request; metadata-only payloads):

- journal (`observation_event`, 3 events, ~930 B each incl. indexes) retained 72 h,
- reduced `observation` (~900 B incl. 5 indexes) + `usage_record` (~260 B) + `cost_ledger` (~370 B) + `trace_summary` (~200 B) retained 7 d,
- enterprise adds `policy_decision` (~220 B) retained 90 d.

Effective data ceiling = 500 MB − 15% headroom (index growth + 8% migration reserve, §13.2) ≈ **446 MB**.

Sustained request rate the ceiling can hold at defaults:

| Profile | Per-request steady footprint | Sustained capacity |
|---|---|---|
| Indie, metadata-only capture | ~20.0 KB | **~21,800 req/day ≈ 0.25 req/s** |
| Indie, redacted capture kept 24 h | ~21.2 KB | ~20,600 req/day ≈ 0.24 req/s |
| Enterprise (adds 90 d policy_decision) | ~39.3 KB | **~11,100 req/day ≈ 0.13 req/s** |

Ceiling required to sustain real gateway load (indie, metadata-only):

| Sustained load | Durable needed | Multiple of 500 MB |
|---|---|---|
| 1 req/s | ~2.1 GB | 4.0× |
| 10 req/s | ~20.8 GB | 39.7× |
| 100 req/s | ~208 GB | 397× |

Separately, the compaction *target* is unbounded (H6): `usage_aggregate` hourly, retained 14 days, at 5,000 distinct dimension combinations = 1.68 M rows × ~170 B ≈ **286 MB** — over half the ceiling before any raw detail exists.

Conclusion: at the 500 MB default and the spec's own retention floors, steady-state capacity is ~0.13–0.25 req/s, and a moderately dimensioned tenant's aggregates alone can consume half the ceiling. Delayed compaction, a failed compaction job, index bloat, or a traffic spike all push the crossing earlier, not later. The design cannot hold 500 MB at any interesting traffic level. Required correction (H5/H6): publish a supported-capacity table (req/day per ceiling and retention setting), compact reduced observations to hourly aggregates within hours rather than 7 days, bound aggregate cardinality, and scale the default ceiling with expected traffic. Estimates are engineering approximations (±30%); the conclusion — two-to-three orders of magnitude short for "enterprise egress" — is robust to that band. Reproduce with the script embedded in the review notes (per-row constants are the tunable inputs).

---

## 8. Platform feasibility review

Verified against current vendor docs (2026). The core question: is the all-Vercel path genuinely deployable at the claimed behavior, and is Cloudflare a faithful adapter?

**Vercel — Edge Config (B4, HIGH).** The spec's foundation number is wrong. Documented max store size is **512 KB** (Enterprise; 64 KB Pro, 8 KB Hobby), not "~5 MB." Propagation is **up to 10 s**, not "< 1 s." Limits are **10 stores/account, 3/project**, and the docs explicitly say "avoid Edge Config for frequently updated data." Consequences: the §7.4 capacity budget is 10× too high; sharding tops out at 3×512 KB = 1.5 MB/project; the snapshot-per-mint/rotate/revoke churn (§8.5) fights the platform's stated purpose and incurs per-write cost. This converts Edge Config from "the hot path" into "an accelerator that overflows to boot-fallback for any non-trivial tenant." The all-Vercel path is still deployable — but only via boot-fallback as the real default, which changes the SLOs. Re-baseline §2.3/§7.4 to 512 KB and 10 s, and make boot-fallback first-class.

**Vercel — Fluid Compute (OK).** `maxDuration = 300 s` is the current default across plans (up to 800 s Pro/Enterprise), so §2.2 is within limits. `after()`/`waitUntil` exist as described — but are best-effort, which is the basis of H9, not a limit violation.

**Vercel — Cron (MEDIUM, feeds H-set).** `* * * * *` minute crons are supported on paid plans, but delivery is at-least-once with delays and minute granularity. The 1-minute `job_ledger` drain means the fallback ingest path has ≥60 s latency, incompatible with the 5 s ingest-lag SLO whenever `after()` fails (the SLO is met only on the happy path). Advisory locks correctly guard overlap. State that the SLO applies to the `after()` path and define the degraded SLO for the ledger path.

**Neon (H8, MEDIUM).** Scale-to-zero defaults to 5 min idle; cold start median 1.8 s / p95 2.6 s / worst 3.1 s. Nothing keeps Neon warm (the warm-ping hits the gateway). The ≤8 ms reservation SLO is violated by 200–400× after any idle period. Require scale-to-zero disabled (Launch+ plan) for hard-budget installs or add a DB keep-warm cron. PgBouncer transaction pooling (the functions' path) does not support session-level advisory locks or persistent `SET` — the spec correctly routes the compactor/migrations to the direct URL, but the RLS GUC via `SET LOCAL` forces every read into an explicit transaction (M2). `max: 1` per invocation under Fluid in-instance concurrency means concurrent streams each hold a pooled client connection; at high concurrency verify against Neon's pooler client-connection ceiling.

**Cloudflare — Durable Objects (H2).** A single DO sustains ~500–1,000 req/s then returns "overloaded." One `BudgetReservationDO` per budget makes a workspace-root hard budget a ~1k-rps global ceiling for that workspace's enterprise traffic. `RateLimitDO` per key is fine. Document the per-budget throughput ceiling.

**Cloudflare — KV (M20, security-relevant).** Eventual consistency up to 60 s (matches §3.7) and a ~1 write/s per-key limit. The active-pointer key written on every publish can exceed 1 rps under expedited revokes + applies, stalling revocation. The 60 s propagation is a real key-revocation exposure window on CF — acceptable for additive config, sharper for a leaked key; consider a DO-checked revocation list for enterprise profiles.

**Cloudflare — Queues (OK, note).** Up to ~5,000 msg/s per queue; a >5k-rps gateway needs queue sharding. DO SQLite storage 10 GB is ample for counters.

**Cloudflare — crypto (M10).** SubtleCrypto is async; the synchronous `Crypto` port (§4.4) is not implementable on Workers without a userland sync crypto lib. This is the one place the "same core, packaging change not rewrite" claim cracks — the port signature must change (async) or the CF adapter takes a documented crypto delta.

Net: Vercel is deployable but the Edge Config numbers and the Neon warm-path must be corrected before the SLOs are truthful. Cloudflare is a faithful adapter on contracts but has three real deltas (DO throughput, KV write/propagation, async crypto) that must be documented in §3.7 rather than implied away.

---

## 9. Database review (hostile)

Beyond B1 (partition-key PKs — the dominant defect) and the tenancy items (H3, M2, M3):

- **Partition key vs. event time.** Tables partition by `created_at` (ingest time) while queries and retention are about `occurred_at` (traffic time). Late/backfilled data lands in the wrong month; "last 7 days of traffic" and "drop partitions older than 7 days" diverge. Partition on `occurred_at` (bounded skew) or state that retention is by ingest time and accept the skew.
- **Cross-partition upsert.** The ingest `UPSERT observation ON CONFLICT (workspace_id, trace_id)` (§8.3) assumes a unique that (a) is invalid without `created_at` (B1) and (b) once fixed becomes per-partition; a late event for a trace whose month rolled can create a second observation row. Pin the observation's partition to the trace's first-seen month deterministically.
- **FK cycle (M1).** `provider_model_offering.active_price_revision_id` ↔ `provider_price_revision.offering_id` cannot be created in one pass; needs a deferred/`ALTER` FK. The spec must say which artifact (SQL vs. Drizzle output) is normative when ordering differs.
- **Immutable revision → mutable credential (L4).** `gateway_target` (immutable set) references `provider_credential` (revocable). Rollback can resurrect a revision pointing at a revoked credential. Publish/rollback must validate credential liveness.
- **Reservation column coverage (H3).** No `reserved_tokens` for token-unit budgets; `reserved_microusd` only. Token hard budgets cannot reserve.
- **Growth/cardinality.** High-volume tables (`observation`, `observation_event`, `usage_record`, `cost_ledger`, `audit_event`) have explicit partitioning and drop paths (good), but no representative row-size or per-tenant volume assumptions, no query plans, and no bounded-index budget beyond the 5-index `observation` set (which roughly doubles that table's footprint). The prompt's requirement — every high-volume table has volume assumptions, a plan, and bounded indexes — is unmet. Add per-table volume assumptions and `EXPLAIN` plans for the Logs list query (`obs_ws_time_idx`), the cost-by-cost-center query (`cost_ledger_cc_idx`), and the reservation `FOR UPDATE`.
- **`budget_account` NULL-scope duplicate (L5).** Nullable `scope_id` defeats the unique; use `COALESCE`.
- **Audit chain (M11).** No `prev_hash` — "chain verifies" is unsupported.
- **RLS GUC (M2).** `current_setting` needs the `missing_ok` form and transaction-wrapped reads.

Representative correct DDL for the highest-volume table is in §15.B1.

---

## 10. API review (contracts)

The control-plane surface is unusually complete: per-endpoint scope, idempotency, transaction, error codes, and audit are tabulated (§10.3), the envelope is stable (§0.3), pagination is cursor-based and stable-under-insert (§10.1), and unknown-field policy is opposite by design on the two planes (§10.6). That is real contract discipline. Gaps that will cause independent implementers to diverge:

- **Plan persistence (M15).** Apply-by-`planHash` needs a persisted plan; `GET /config/plan` is marked read-only. Make plan creation a `POST` that persists, or pass `baseConfigHash` in the apply body.
- **Reason/error code registry (M5).** The wire's `code` values in §10.3 are not all in the §0.2 registry the CI gate reads; agents that branch on `code` will hit unregistered values. Unify the enums.
- **Idempotency store (M16).** Defined behaviorally (§10.1) with no table, retention, or size accounting.
- **Config apply atomicity (M4).** "1+store" is two systems; define the intermediate state and the reconciliation SLA so clients know when "active" is truly serving.
- **Partial-success / batch semantics.** The ingest batch (`observation-events:batch`) dedups per event, but the response shape for a batch where some events dedup and some insert is unspecified — agents need per-item results or a documented all-or-count contract.
- **Money/date formats.** Money is µ$ integers everywhere (good); confirm every wire field carrying money is typed as string-or-int consistently (JS number loses precision above 2^53 — µ$ of $9,007+ per line is fine, but budget `limit_amount` of billions of µ$ is within range; document that money crosses the wire as a JSON number in µ$ and is safe below 2^53 µ$ ≈ $9.0e9, else use strings).
- **List ordering.** Cursors encode `(created_at, id)` (stable) — good; assert every `list` has a total order including the tiebreak `id`.

Every control-plane view in §11 has an API mapping and the destructive-safeguard/empty/loading/error states are specified per view — the console is implementable against these contracts once M4/M15 are closed.

---

## 11. CLI review (human + agent protocol)

The CLI is the strongest single section: schema-versioned envelope with `kind`, stdout/stderr discipline, stable exit codes, auto-idempotency keys, keyring-only tokens, JSONL streaming, golden agent fixtures (§12.4, §12.11). It is close to a good agent protocol. Sharp edges an agent will hit under load:

- **Partial-failure in streamed output.** `observation export`/`usage query --all` stream JSONL to stdout as they page; if page 3 fails, stdout already holds pages 1–2 then an error object of a different shape. A line-by-line JSONL consumer sees valid data lines then a differently-shaped `kind:"error"` line. Specify: on mid-stream failure, emit the error to stderr and exit non-zero, leaving stdout as valid (if truncated) JSONL; never interleave an error object into the data stream.
- **Exit-code taxonomy collision.** §12.10 maps `BUDGET_PRICE_UNKNOWN` (a valid command rejected by a business rule) to exit 2 (documented as "usage/validation: bad flags/body"). An agent branching on exit 2 cannot distinguish a malformed command from a well-formed one rejected by policy. Give business-rule rejections a distinct code (e.g., 5 or a new 10) and reserve 2 for argument/body errors.
- **`config apply --plan-hash` vs. server plan.** Depends on M15; the CLI contract is fine once the server persists plans.
- **Determinism claim.** "byte-identical output given identical server state" (§12.11) requires the server to return fields in stable order and the CLI to sort — assert both; today only the CLI side is stated.
- **Destructive confirm in automation.** `--yes` required for destructive verbs, refuses without it in `--non-interactive` — correct; add that a prompt can never appear on stdin in `--non-interactive` even for auth refresh (return exit 3), which §12.5 states — good.

Required CLI examples the spec should add (the prompt's list): success, validation failure, authz failure, conflict (`CONFIG_PRECONDITION_FAILED`), timeout, interrupted `--all` export, partial batch, stale revision, destructive approval, compaction, export, deployment, rollback. §12.10 covers ~5 of these; add the rest as golden fixtures.

---

## 12. Security review (exploit-minded)

The release-gate invariants (§14.1) are the right seven, wired as CI gates (§21.8), and the trust-boundary table (§14.2) is sound. Real exposure:

- **Credential ciphertext on the hot path (B3).** The one unresolved security-critical seam: where the gateway reads `encrypted_secret` without a DB read, and how the cache invalidates on rotate/revoke (L11). Until specified, either ADR-0005 is violated or a use-after-revoke window exists.
- **Snapshot signer confusion (H10).** If the verifying key is ambiguous (installation vs. control-plane), an attacker who can write Edge Config/KV might present a snapshot signed by the wrong-but-accepted key. Nail the keypair identity and rotation.
- **Control-plane SSRF (M9).** `validate`/`test` egress from the control plane has no stated SSRF policy — a `providers:write` holder can aim validation at internal services. Apply §14.4 to all egress.
- **Confused-deputy via `allowed_hosts` (L-note).** Operator `allowed_hosts` intentionally bypasses the RFC-1918 block for private deployments; therefore `providers:write` is a sensitive scope (can define a credential whose host is internal). State this and gate it.
- **Ingest attribution (good).** §10.7/§15.4 derive workspace/app server-side and ignore asserted ids, with a negative test — correct. But `action.source='discovered'` (M8) reopens a caller-influenced write path; close it.
- **Device-code phishing (L3).** Standard device-flow risk; require scopes+origin on the approve screen.
- **KV revocation window on CF (M20).** Up to 60 s to propagate a revoke; for enterprise egress consider a DO-checked deny-list.
- **Audit tamper-evidence (M11).** Without a hash chain, a DB-level actor can alter audit rows undetectably; the SIEM export mitigates but the "chain verifies" claim must be made true or dropped.

Negative tests exist for tenancy and profile isolation (§15.5) — the highest-value set — and are release gates. Add negative tests for: control-plane SSRF, use-after-revoke credential, wrong-signer snapshot, and audit-row tamper detection.

---

## 13. Test-gap review

The strategy (§21) is broad and mostly traceable: property tests for policy parity, reducer determinism, aggregate additivity, and money; deterministic real-Postgres storage tests; a 1 GB flat-memory gate; cross-tenant negatives as gates. Gaps that let a defect through:

- **The schema can't apply (B1)** — WP-012's "DDL applies" test is the one that should catch it; make it a real Testcontainers apply and assert `created_at` in every partitioned PK.
- **Per-workspace storage measurement (B2)** — no test provisions two workspaces in one DB and asserts isolated footprint; add it (it will fail today, which is the point).
- **Lost-commit under kill (H1)** — chaos suite kills ingest, not the invocation between provider-bytes-and-reconcile; add that exact kill and assert `committed` reconciles.
- **`after()` durability (H9)** — add a SIGKILL between last byte and `after()`.
- **Root-budget contention (H2)** — the oversell test is single-budget; add a hierarchy with a workspace-root cap and measure P99 + overload behavior.
- **Neon cold path (H8)** — no test idles past suspend and measures first-reservation latency.
- **Config DB/store split (M4)** — no test injects a store-write failure after DB commit and asserts convergence + no security staleness beyond SLA.
- **Rolling/total/token budgets (H3)** — reserve tests cover fixed windows only.
- **Mid-stream CLI failure (CLI review)** — streaming test asserts flat memory, not partial-failure stream integrity.

Release gates are named and non-overridable (§21.9) — good. Add the above to the gate set for the milestones that ship each subsystem.

---

## 14. Implementation-sequencing review

The DAG (§24) and WBS (§23, §28.2) are dependency-ordered and mostly buildable in ID order. Issues:

- **Storage lags traffic (M17).** Compaction/retention is M4; real traffic is M2. Any M2/M3 production deploy grows Neon unbounded. Pull a minimal partition-drop/retention pass into M2, or label M2/M3 non-production-traffic.
- **CLI dep mislabeled.** WP-054 "CLI foundation" lists dep "WP-011 (API stable)," but WP-011 is the `domain` package; the control API (E11) lands in M2. The CLI foundation cannot target a stable API at M1. Repoint the dep to the M2 API milestone.
- **First vertical slice.** M2 (WP-030 base-URL swap) is a coherent slice for the indie/logging product — auth, tenancy, routing, snapshot, observability, publish, rollback — but not for "enterprise governed egress," which needs budgets/policies/audit (M3) and storage bounding (M4). State that the first *enterprise* production milestone is M3+M4, not M2, so no one ships enterprise egress on M2.
- **Critical path.** E1→E2→E3→{E8,E9,E10}→E11→E12/E13→E18 is correct; E11 (control API) is the true bottleneck feeding both UI and CLI. B1/B2 sit in E3 (database) — the critical path's second node — so they block everything downstream and must be fixed first.
- **Resequencing recommendation.** Move the storage measurement/retention primitive (subset of E14) to right after E3 so every later milestone runs against a bounded DB; move the credential-ciphertext decision (B3) into E4/E6 (ports + gateway-core) since it changes the snapshot schema and the `Crypto`/`SnapshotStore` ports.

---

## 15. Replacement specifications (for every BLOCKER and HIGH)

Drop-in text to remove the ambiguity from the spec. Identifiers match §6/§7/§10.

### §15.B1 — Partitioned-table keys include the partition key

Replace every partitioned table's PK/unique to include `created_at`. Canonical example (`observation_event`), and apply the same pattern to `observation`, `trace_summary`, `policy_decision`, `usage_record`, `cost_ledger`, `audit_event`, `budget_reservation`:

```sql
CREATE TABLE observation_event (
  id            text NOT NULL,                 -- oe_… (ULID)
  workspace_id  text NOT NULL REFERENCES workspace(id),
  -- … unchanged columns …
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),                                    -- partition key included
  CONSTRAINT observation_event_dedup_uq
    UNIQUE (workspace_id, producer_id, idempotency_key, created_at)
) PARTITION BY RANGE (created_at);
```

Because uniqueness is now per-(key,created_at), cross-partition dedup is not guaranteed by the constraint; make the reducer authoritative for dedup within a trace (it already sorts by `(seq, occurred_at)` and is idempotent), and pin an observation to the partition of its trace's first event so late events upsert into the same partition:

```sql
-- observation is written into the month partition of the trace's first-seen occurred_at,
-- not now(); the reducer computes partition_ts = date_trunc('month', first_event.occurred_at).
CREATE TABLE observation (
  id text NOT NULL, workspace_id text NOT NULL REFERENCES workspace(id),
  -- … columns …
  created_at timestamptz NOT NULL,           -- = trace first-seen; drives partition
  PRIMARY KEY (workspace_id, trace_id, created_at),
  CONSTRAINT observation_trace_uq UNIQUE (workspace_id, trace_id, created_at)
) PARTITION BY RANGE (created_at);
```

Acceptance: WP-012 applies the full schema on Testcontainers-Postgres and asserts, for every relation with `relispartition`, that the PK column set contains the partition key.

### §15.B2 — State tenancy cardinality; make storage measurement match it

Add ADR-0021: "**Storage-bounded mode operates per database, and each workspace that enables a hard ceiling runs in its own database (Neon project/branch).** The multi-workspace console is an operator plane over many single-workspace databases; it never shares one database across ceilinged workspaces." Then §13.2 stands as written (DB-wide `pg_total_relation_size` == the workspace's footprint).

If instead multi-tenant-per-database is required, replace §13.2 measurement with per-workspace accounting: maintain `workspace_storage_bytes` counters updated at write/compaction time (add row-width deltas), or measure via `SELECT workspace_id, sum(pg_column_size(t.*)) …` sampled per table — and state that catalog sizes are not usable for per-workspace ceilings. Pick one; the spec must not leave it implicit.

### §15.B3 — Provider-secret ciphertext on the hot path

Add to §7.1 `credmap` and §7.6: "The snapshot `credmap` carries the AES-256-GCM **ciphertext** and `dek_id` for each referenced credential (never plaintext). The gateway decrypts in-process with the DEK unwrapped by the cached KEK; no Neon read occurs on the dispatch path. Rotating or revoking a credential is a config change that republishes the snapshot; a gateway instance uses a credential's ciphertext only from the active snapshot, so revocation takes effect within the publish/propagation window (Edge Config ≤ 10 s, KV ≤ 60 s). DEKs are cached in-process keyed by `dek_id` with invalidation on snapshot revision change." This keeps ADR-0005 true (zero DB reads) and defines invalidation (closes L11). Update the ER/snapshot schema (§7.2 `SnapshotTarget`) to add `secretCiphertext: bytes` and `dekId`. Note the size impact against B4's 512 KB budget (ciphertext ~100–500 B/credential; few credentials, acceptable).

### §15.B4 — Re-baseline Edge Config numbers

Replace §2.3: "Edge Config store cap is **512 KB** (Vercel Enterprise; 64 KB Pro), write propagation **up to 10 s** globally, **10 stores/account, 3/project**. Edge Config is an in-region accelerator, not the system of record; the signed snapshot in Postgres (`gateway_config_revision.snapshot`) is authoritative and the boot-fallback fetch (§7.4) is the default hot-path loader for any installation whose snapshot exceeds one store." §7.4: size-gate warns at 80% of **512 KB**, errors at 95%; realistic pre-shard capacity ≈ 400 keys / 200 routes / 200 offerings; beyond 1.5 MB (3 shards) the installation runs boot-fallback with in-isolate caching. Fix every "< 1 s" propagation reference (§2.3, §3.7, §8.2, §16.7) to "≤ 10 s (Edge Config) / ≤ 60 s (KV)" and recompute delete-grace windows as `grace ≥ max(10 s, 60 s) + safety`. Preview environments share one namespaced store, not one store per PR (§2.5).

### §15.H1 — Reconcile from durable ingest, not `after()`

Replace §8.4 reconciliation: "Reconciliation is driven by the durable terminal `ObservationEvent`, not by in-request `after()`. On terminal, the gateway enqueues a `reconcile` job (`job_ledger`, idempotent on reservation id) carrying the actual usage/cost. The reconciler moves `reserved→committed` by the actual amount and writes `cost_ledger`. The expiry sweep only applies when **no** terminal event exists for the reservation by `expires_at`; if a terminal event exists, the sweep reconciles to actual rather than releasing to zero. A billed-but-unreconciled request therefore always debits committed spend once ingest catches up." Add the H1 chaos test to §21.12.

### §15.H2 — Budget throughput ceiling and root fan-out

Add to §16.3: "A single `budget_window_state` row (or Cloudflare `BudgetReservationDO`) serializes all reservations against that budget; supported throughput is ≤ ~1,000 reserve/s per budget subtree (DO overloaded above that). Where a workspace-root hard cap would serialize all enterprise traffic, use **sharded sub-counters** (`budget_window_state_shard(budget_account_id, shard, window_start)`, N shards) that each hold `limit/N` and reconcile to the root asynchronously; the reserve path locks one shard, not the root. Document the chosen N and the resulting overshoot bound." Add the H2 load test to §21.7.

### §15.H3 — Fix `budget_window_state`

```sql
CREATE TABLE budget_window_state (
  workspace_id      text NOT NULL REFERENCES workspace(id),     -- ADD: tenancy + RLS
  budget_account_id text NOT NULL REFERENCES budget_account(id),
  window_start      timestamptz NOT NULL,       -- fixed windows; for rolling_30d/total see below
  committed_microusd bigint NOT NULL DEFAULT 0,
  reserved_microusd  bigint NOT NULL DEFAULT 0,
  committed_tokens   bigint NOT NULL DEFAULT 0,
  reserved_tokens    bigint NOT NULL DEFAULT 0,  -- ADD: token-unit hard budgets
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_account_id, window_start)
);
-- RLS as every tenant table (§15.2). Enable and add ws_isolation policy.
```

Add to §16.3: "For `rolling_30d`, headroom = `limit − (Σ cost_ledger over [now−30d, now]) − reserved`; the reserve path uses a materialized trailing-sum refreshed each measure cycle plus live `reserved`. For `total`, `window_start` is a fixed sentinel (`epoch`) and the counter is lifetime. Token-unit budgets check `committed_tokens + reserved_tokens + est_tokens ≤ limit`."

### §15.H4 — `cost_ledger` invariant, stated precisely

Replace the §13.1/§13.4 language: "The preserved-forever truth is **aggregate cost** (`usage_aggregate.cost_microusd` at monthly grain, and a `monthly_cost_rollup` per budget/cost-center). Per-request `cost_ledger` rows are retained ≥ `min_trace_days`, then their window is summarized into the monthly rollup and the `cost_ledger` monthly partition is **dropped** (DDL DROP, which does not fire the DML immutability trigger). `cost_ledger` is immutable to `UPDATE`/`DELETE` at the row level (audit integrity) but is subject to partition-level retention like other high-volume tables. No design claims per-request cost rows survive forever; the financial invariant is that summed cost per (period, budget, cost-center) is exact and permanent." Add a deterministic test: monthly rollup equals pre-drop `sum(cost_ledger.amount_microusd)` to the µ$.

### §15.H5 / §15.H6 — Publish capacity; bound aggregates

Add §13.12 "Supported capacity": a table of sustained req/day per ceiling × retention setting (compute with the §7 model), and set defaults so the *default* ceiling matches the *default* audience (e.g., raise the default ceiling, or cut reduced-observation retention to `min_trace_days` = 24 h and roll to hourly aggregates within 6 h). Bound `usage_aggregate`: cap `dims` cardinality per workspace (e.g., top-K offerings, cost-center rolled to depth-1), shorten hourly retention to 72 h, and include aggregate bytes in the forecast (`storage_stat` already has per-table `table_bytes`). Acceptance: a steady-state test at the published rate holds the ceiling without entering emergency tier.

### §15.H7 — Key activation

Add to §8.5: "Minting or revoking a virtual key triggers an **immediate, scoped snapshot publish** that updates only the `keys` section for the affected installation, independent of pending route/policy drafts (key publication is decoupled from config drafts). A minted key is serving within the publish/propagation window (≤ 10 s Edge Config / ≤ 60 s KV); the Keys UI shows 'activating' until the installation's `applied_config_revision` reflects the key. Key mint never publishes unrelated draft config." This keeps ADR-0005 (no DB fallback) while making self-serve keys work.

### §15.H8 — Keep Neon warm for hard budgets

Add to §2.4/§19.3: "Any installation using hard budgets MUST run Neon with scale-to-zero disabled (Launch plan or higher). Additionally, a `db_keepwarm` cron (`*/4 * * * *`) issues `SELECT 1` on the direct connection to bound cold starts. The ≤ 8 ms reservation SLO (§2.6) applies only to a warm compute; a cold-start addendum (≤ 3 s) is documented and excluded from the reservation SLO, surfaced on the `p99_ttfb` panel." 

### §15.H9 — Durable terminal enqueue

Replace ADR-0017 consequence: "The terminal-event enqueue to `job_ledger` (or the reconcile job insert) happens **synchronously before the response stream is released** — a single indexed insert on the reservation's transaction or a dedicated durable write — so instance loss after response cannot lose the terminal. `after()` is used only to *reduce/project* already-durable events, not to persist them. Provider latency is still independent of ingest because the durable write is one local insert, not the full reduction."

### §15.H10 — Two keypairs, named

Replace §7.3/§14.3 signing text: "Two ed25519 keypairs exist and never overlap. (1) **Snapshot-signing keypair**: private key held only by the control plane (`MANIFOLD_SNAPSHOT_SIGNING_KEY`), public key pinned in every gateway (`MANIFOLD_SNAPSHOT_PUBLIC_KEY`); the gateway verifies each snapshot against this public key and fails closed to last-good. (2) **Installation-identity keypair** (`gateway_installation.public_key`): used only to authenticate the installation to the ingest endpoint. Snapshot rotation = publish new public key to gateways (env), then rotate the signing key; installation-identity rotation is independent. §19.3's single public-key env is keypair (1); it is not per-installation."

---

## 16. Operational-readiness review

Runbooks exist for pepper/KEK/signing-key rotation (§19.4) and rollback is independent across code/config/schema (§2.9, §19.5) — good. `GET /api/v1/health` surfaces DB, snapshot store, last drain, ingest lag, storage tier (§18.5). Gaps for incident response:

- **No runbook for the config DB/store split (M4).** When DB-active ≠ store-serving, on-call needs a documented "force republish / verify all instances at revision X" procedure.
- **No runbook for storage emergency (tier=emergency).** §13.3 defines automated behavior, but not the human procedure when automation cannot recover (e.g., a stuck compactor holding the advisory lock). Add: how to break the lock safely, how to raise the ceiling live, how to force export-before-delete.
- **No supported-capacity SLA (H5).** On-call cannot tell a customer "you exceeded supported throughput" without a published number.
- **Neon cold-start incidents (H8).** Add the keep-warm dependency to the deploy checklist.
- **DLQ drain.** `manifold job retry`/`drain` exist (§12), but the runbook for a growing `job_ledger(dead)` (root-cause, bulk-retry, poison quarantine) is not written.
- **Break-glass.** No documented break-glass path (e.g., disable a runaway installation, revoke all keys for a workspace, freeze publishes) — enterprise buyers will ask.

---

## 17. Blocking-change checklist

Engineering may not begin the production build until all of these are true in the spec:

- [ ] **B1** Every RANGE-partitioned table's PK and UNIQUE constraints include `created_at`; dedup semantics restated (reducer-authoritative); WP-012 applies the full schema on real Postgres and asserts partition-key inclusion.
- [ ] **B2** Tenancy cardinality stated as an ADR; §13.2 measurement matches it (one-workspace-per-DB, or per-workspace accounting replaces catalog sizes); two-workspace isolation test defined.
- [ ] **B3** Provider-secret ciphertext location on the hot path specified (in-snapshot ciphertext + cached DEK) with rotation/invalidation; zero-DB-read assertion extended to cover the secret fetch.
- [ ] **B4** All Edge Config numbers re-baselined to 512 KB / ≤10 s / 3 stores-per-project; boot-fallback made the default for over-cap tenants; grace windows recomputed; preview stores shared.
- [ ] **H1** Reconciliation driven by durable terminal event; expiry reconciles-to-actual-if-terminal-exists; lost-commit chaos test defined.
- [ ] **H2** Per-budget throughput ceiling published; root-cap fan-out (sharded sub-counters) specified; hierarchy load test defined.
- [ ] **H3** `budget_window_state` gains `workspace_id` (+RLS) and `reserved_tokens`; rolling/total window enforcement defined.
- [ ] **H4** `cost_ledger` invariant restated (aggregate totals forever; per-request rows retained-then-partition-dropped); reconciliation test defined.
- [ ] **H5/H6** Supported-capacity table published; default ceiling/retention aligned to the default audience; `usage_aggregate` cardinality bounded and forecast-included.
- [ ] **H7** Key mint/revoke triggers an immediate scoped publish, decoupled from config drafts; activation SLA + test defined.
- [ ] **H8** Scale-to-zero-disabled requirement + `db_keepwarm` cron for hard-budget installs; reservation SLO scoped to warm compute.
- [ ] **H9** Terminal event persisted synchronously before response release; `after()` demoted to reduction only; SIGKILL test defined.
- [ ] **H10** Snapshot-signing and installation-identity keypairs separated and named; rotation defined for each.

Medium items (M1–M20) are not merge-blockers for the spec but are milestone-blockers for the subsystems they touch and must be scheduled into the owning WPs (E3 for M1–M3, M6; E8/E11 for M4/M15/M16; E10 for M13/M14/M19; E15 for M10/M20; E9 for M18; E12/E13 for the CLI/API items).

---

## 18. Definition of ready — what must be true before engineering begins

Engineering may start when, in addition to the §17 checklist:

1. The database schema applies cleanly on Testcontainers-Postgres from a single `drizzle-kit` run, including all partitions, RLS policies, and immutability triggers, with the partition-key assertion green. (Today it does not — B1.)
2. The storage model has a written supported-capacity table and a stated tenancy cardinality, and the deterministic storage suite (§21.10) includes the two-workspace isolation test and the H4/H5/H6 tests. (Today the ceiling is unproven — B2/H4/H5/H6.)
3. The hot-path pipeline has a single, testable statement of what it reads (snapshot only, including secret ciphertext) and a zero-DB-read assertion that covers auth, routing, policy, credential fetch, and key activation. (Today two of these read or fail — B3/H7.)
4. The Vercel platform numbers in the spec match vendor documentation (Edge Config 512 KB / 10 s; Neon warm requirement), so the SLOs are truthful. (Today they are 10× off — B4/H8.)
5. The money path has one consistent statement of reservation, reconciliation, oversell bound, and per-budget throughput ceiling across Vercel and Cloudflare, with the lost-commit and root-contention tests defined. (Today reconciliation is best-effort and the root row/DO is a bottleneck — H1/H2/H3.)
6. The reason-code/error-code registry is a single generated source that includes every `code` on the wire (M5), and the config plan/apply lifecycle is unambiguous about plan persistence (M15) — because these two are the contracts the CLI and every agent bind to first.

Meet those six and the remaining work is the ordinary, well-sequenced build this spec already describes. The bones are good; the durable-state layer and the platform numbers are what stand between this document and a production approval.

---

### Sources (platform-limit verification)

- Vercel Edge Config limits (512 KB store, ≤10 s propagation, 10/3 stores, "avoid frequently updated data"): [vercel.com/docs/edge-config/edge-config-limits](https://vercel.com/docs/edge-config/edge-config-limits)
- Vercel Functions / Fluid Compute duration (300 s default, up to 800 s): [vercel.com/docs/functions/limitations](https://vercel.com/docs/functions/limitations), [vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute](https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute)
- Neon scale-to-zero (5 min default) and cold-start latency (1.8–3.1 s) and PgBouncer transaction-mode constraints: [neon.com/docs/connect/connection-latency](https://neon.com/docs/connect/connection-latency), [neon.com/blog/using-neons-auto-suspend-with-long-running-applications](https://neon.com/blog/using-neons-auto-suspend-with-long-running-applications)
- Cloudflare Durable Objects throughput/limits, Workers KV eventual consistency (~60 s) and ~1 rps/key write, Queues throughput: [developers.cloudflare.com/durable-objects/platform/limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [developers.cloudflare.com/workers/platform/storage-options](https://developers.cloudflare.com/workers/platform/storage-options/)
- Postgres rule that unique/PK on a partitioned table must include all partition-key columns: PostgreSQL documentation, "Table Partitioning" (§5.11) — a fixed constraint since v11.
