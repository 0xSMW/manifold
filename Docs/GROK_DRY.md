# DRY Analysis Report — Manifold Monorepo

## Method

| Slice | Scope | Sub-agent |
|-------|--------|-----------|
| **1** | `packages/domain` | Domain machines + value objects |
| **2** | `gateway-core`, `gateway-policy`, `apps/gateway` | Hot-path + adapters |
| **3** | `packages/config`, `packages/contracts` | Snapshot lifecycle |
| **4** | database, crypto, observability, ports, budget, provider-registry | Infra |
| **5** | `apps/control-plane` | API routes + lib |
| **6** | `apps/cli` | Go command tree |

After collection, I re-opened the cited files, grepped usage, and **proved or rejected** each claim. Below: only findings that survive adversarial review, plus explicit false positives.

---

## Verdict summary

| Tier | Count | Meaning |
|------|------:|---------|
| **Proven — fix** | 11 | Real duplication with evidence; safe consolidation path |
| **Proven — with caveat** | 6 | Real, but intentional layering or future-only |
| **Rejected** | 8 | Agents correctly flagged as non-targets, or over-claimed |

---

## Proven high-value opportunities

### 1. Dual HTTP status maps in gateway-core  
**Slice 2 · Impact: High · Verdict: PROVEN (also a correctness hazard)**

`shapeForCode` in `errors.ts` and private `shapeStatus` in `handleRequest.ts` map the same codes to statuses independently. `shapeStatus` **omits** `SSRF_BLOCKED`, `CREDENTIAL_UNAVAILABLE`, `ROUTE_ENDPOINT_UNSUPPORTED`. Call sites paper over that with hard-coded `403` / `502` while the client body still goes through `errorResponse` → `shapeForCode`.

**Evidence:** auth path uses `shapeStatus(auth.reason)` for emit and `errorResponse(...)` for the body — two sources of truth for the same code.

**Consolidate:** delete `shapeStatus`; always use `shapeForCode(code).status`. Optionally fold hard-coded emit statuses into the same helper and always populate `reasonCodes`.

---

### 2. AES-256-GCM reimplemented in `NodeCrypto` while `@manifold/crypto` owns production  
**Slice 2 · Impact: High · Verdict: PROVEN (security-sensitive)**

`apps/gateway/src/adapters.ts` implements `sealAesGcm` / `openAesGcm` with raw `createCipheriv`/`createDecipheriv`. Same packing layout (`iv | ct | tag`) as `@manifold/crypto`, but **without** key-length asserts, short-blob checks, optional AAD, or `authTagLength`. Production secret path in `server.ts` imports `@manifold/crypto` directly and **bypasses** the port.

**Caveat (not a rejection):** ports stay platform-agnostic; the fix is a **thin Node adapter wrap**, not pulling Node crypto into `gateway-core`.

---

### 3. Two different types named `ObservationEvent`  
**Slice 4 · Impact: High · Verdict: PROVEN with caveat**

| Package | Shape |
|---------|--------|
| `@manifold/ports` | Flat: `traceId`, `kind`, `status: number`, `profileId`, `keyId`, … |
| `@manifold/observability` | Journal: `BaseEvent` + kind-specific `payload` (tokens, price, cost dims) |

Same name, incompatible structures. Gateway emits the ports shape.

**Adversarial note:** dual representation is **intentional** (minimal hot-path vs ADR-0011 journal). Merging into one type would be wrong. Real DRY debt is **name collision + missing adapter**, not identical logic.

**Consolidate:** rename (`HotPathObservationEvent` / `JournalObservationEvent`), share kind enum + base ids, one map function at the ingest boundary.

---

### 4. Postgres attack-test harness copy-pasted (database ↔ budget)  
**Slice 4 · Impact: High · Verdict: PROVEN**

`packages/budget/test/budget-attacks.test.ts` **documents** that it mirrors `isolation.test.ts`. Shared: `docker` / `waitForReady` / random `HOST_PORT` / `postgres:16` / migrations `0000`+`0001` / teardown. ~150 lines of harness each (~380–400 line files).

**Consolidate:** `@manifold/database/testkit` or `packages/database/test/pg-harness.ts` with options (pool size, seed hooks).

---

### 5. Token/price class list multi-homed  
**Slices 1 + 4 · Impact: High · Verdict: PROVEN**

Seven billing classes appear in:

- domain `TokenCounts` + `PriceMicroUsd` + hand-paired `computeCost`
- provider-registry `PriceFields` / snake_case DTOs
- database `providerPriceRevision` + observation / usage_record token columns
- observability terminal `price?: PriceMicroUsd`

**Evidence in `computeCost`:** seven parallel `term(...)` lines that must stay aligned with both interfaces and schema.

**Consolidate:** canonical term table in domain (or contracts); schema column fragment `tokenCountColumns()`; registry maps snake→canonical. Do **not** force one casing across all packages.

---

### 6. Config depends on `@manifold/contracts` but never imports it  
**Slice 3 · Impact: High · Verdict: PROVEN**

`packages/config/package.json` lists the dependency; source only uses the bare string `"CONFIG_PRECONDITION_FAILED"`. Reason codes type-check as free strings (`reasonCode: string | null`).

**Consolidate:** import `ReasonCode` / const values; type `ConfigOperation.reasonCode`. Package already pays the dep cost.

---

### 7. Control-plane plan/apply pipeline + installation ownership  
**Slice 5 · Impact: High · Verdict: PROVEN**

Both routes run the same sequence:

```ts
buildSnapshot → signSnapshot → planApply
```

Installation check is `assertInstallation` on plan and an inlined twin on apply (same SQL + 404 message).

**Consolidate:** `buildSignedPlan(installationId)` + `requireInstallation(ws, id)` in `lib/`. Hash determinism cannot diverge between plan and apply.

---

### 8. CLI resource scaffolding + isomorphic org nouns  
**Slice 6 · Impact: High · Verdict: PROVEN**

`orgnouns.go` header already says the file exists “to avoid four near-identical files” — but still copies `list`/`get`/`create`/`archive` for app vs action (team/cost-center variants are near-isomorphic). Same list/get pattern across provider, route, key, budget, model, installation, job, policy.

**Consolidate:** `leafList` / `leafGet` / table-driven `nounSpec` factory. Stubs today; this pays off as real handlers land.

---

### 9. `apply()` Plan→operation field bags  
**Slice 3 · Impact: Medium · Verdict: PROVEN**

Three branches in `apply.ts` (reject / no-op / accept) and rollback copy the same plan identity fields; only outcome / revision / reasonCode vary.

**Consolidate:** `opFromPlan(plan, patch)`.

---

### 10. Budget release path: commit / rollback / sweepExpired  
**Slice 4 · Impact: Medium · Verdict: PROVEN**

Shared skeleton: `lockReservation` → GUC → require `reserved` → domain transition → subtract held from `reserved_microusd` → update reservation. Commit alone adds `committed_microusd` + `reconciled_microusd`.

**Consolidate:** internal `releaseReservation(sql, id, event, { actual? })`.

---

### 11. Workspace GUC string scattered  
**Slices 3 + 4 + 5 · Impact: Medium · Verdict: PROVEN**

Identical:

```sql
SELECT set_config('manifold.workspace_id', ${id}, true)
```

in budget (4×), config apply, control-plane `lib/db.ts`, database isolation tests.

**Consolidate:** `setWorkspaceGuc(sql, workspaceId)` on `@manifold/database` (or shared helper).

---

## Proven medium opportunities (abbreviated)

| # | Finding | Slice | Adversarial note |
|---|---------|-------|------------------|
| 12 | `toHex` in gateway-core, ports/testing, crypto | 2, 4 | Real triple; keep pure util off Node-only crypto so core stays portable |
| 13 | SSRF scheme/policy check duplicated in core `ssrfCheck` and `EgressFetcher` | 2 | Post-DNS private-IP recheck is intentional defense-in-depth — only dedupe pure scheme/policy |
| 14 | Terminal emit boilerplate + empty `reasonCodes` on SSRF/credential fails | 2 | Proven; emit helper improves observability completeness |
| 15 | Gateway test fixtures duplicated (`gateway.test` vs `credentials.test`) | 2 | Proven; fixtures already drift on key shape |
| 16 | Domain `*_STATES` arrays dual-define type unions; **never imported** (only `*_TERMINAL_*` used in tests) | 1 | Proven via repo-wide grep; `as const` + derive type is clean |
| 17 | Domain machine test assert boilerplate | 1 | Proven; test helpers only — don’t meta-test all machines in one file |
| 18 | CP HMAC reimplementation vs `@manifold/crypto` `hmacKeyHash` | 5 | Same primitive, different pepper encoding (string vs bytes); thin adapter is correct |
| 19 | CP routes bypass `baseHeaders` (health, config/active) | 5 | Health deliberately public; still missing `X-Request-Id` vs kit — real header drift |
| 20 | CP body parsing hand-rolled; zod dep unused | 5 | Proven pattern; optionalString/array helpers or zod schemas |
| 21 | Policy/entitlement shapes: config vs gateway-policy vs DB rows | 3 | Parallel fields proven; **not wired into hot path yet** — impact is when integrate |
| 22 | Snapshot meta stamping: `build` vs `keyOnlyPublish` | 3 | Proven local refactor |
| 23 | Schema token columns repeated observation/usage_record | 4 | Proven; aggregate intentionally thinner |
| 24 | CLI `StubResult` / `CLIError` / quiet-JSON branching outside `writeResult` | 6 | Proven hygiene for specials |

---

## Rejected or deliberately non-DRY (adversarial wins)

| Claim | Why rejected |
|-------|----------------|
| Generic FSM engine for domain machines | Graphs differ; shared `ok`/`invalidTransition` already enough. Agents + review agree. |
| Merge `REASON_CODES` and `ERROR_CODES` | SPEC-documented split (data-plane vs control-plane). |
| Collapse registry `Fidelity` with cost `CostFidelity` | Different enums / semantics. |
| Unify half-even in domain vs provider-registry price parse | Different domains (bigint ratio vs decimal×10⁶); naive merge high risk. |
| Generic CRUD framework for CP mutate routes | Skeleton similarity only; domain SQL/audit must stay explicit. |
| Domain machines “unused by CP” as pure DRY | Lifecycle integration gap, not copy-pasted logic today. |
| `okIf` / contentHash error helper / `hasBody` duplex helper | Too small; abstraction cost ≥ savings. |
| Force one type for config policy vs evaluator | Transport (string bounds, offeringId) vs pure numeric evaluator — need mappers, not identity. |
| Merge health / ping / installation.health into one command | Product aliases; only share flag/spec builder. |
| Extract config signing test fixture with one consumer | Premature. |
| Merge ports SnapshotStore with config publish store without API design | Intentional load-only hot path vs publish lifecycle. |
| CLI dual login/whoami registration | Intentional surface aliases; handlers already shared. |

---

## Cross-cutting themes (after review)

1. **Status / reason-code maps that can drift** — gateway `shapeStatus`/`shapeForCode`; config bare strings vs contracts; CP `EnvelopeCode = string` vs contracts `ERROR_CODES`.
2. **Crypto primitives reimplemented at app boundaries** — gateway `NodeCrypto`, CP `keyedHash`, while `@manifold/crypto` holds attack-tested implementations.
3. **Billing class cardinality (7)** — domain cost formula, registry import, schema columns must move together.
4. **Hot-path vs journal observation** — dual shapes need an explicit map, not a forced single type.
5. **Tenant GUC + PG test harness** — operational/infra duplication that every new money/RLS suite will re-copy.
6. **CLI declarative surface** — `buildLeaf` is good; resource scaffolding still sprawls.

---

## Recommended consolidation order

| Priority | Work | Why first |
|----------|------|-----------|
| **P0** | Unify gateway status map (`shapeStatus` → `shapeForCode`) | Correctness, small diff |
| **P0** | Wrap `NodeCrypto` AES via `@manifold/crypto` | Security consistency |
| **P1** | Wire contracts reason codes into config | Dep already paid |
| **P1** | CP `buildSignedPlan` + `requireInstallation` | Plan/apply drift risk |
| **P1** | Shared PG test harness | Blocks copy-paste growth |
| **P2** | Canonical token/price term table + schema fragments | Billing evolution |
| **P2** | Observation event rename + ingest adapter | Before full reduce path |
| **P2** | Budget `releaseReservation` + GUC helper | Money-path DRY |
| **P3** | CLI leaf/noun factories; CP body/header kit; domain const states + test helpers | Maintainability |

---

## Process note

Six explore agents covered disjoint slices in parallel (~100–120s each). Adversarial review was orchestrator-side: file reads, cross-package greps, and direct comparison of the cited maps/functions. Highest-confidence items are those with **byte-level dual implementations** or **documented self-admission of mirroring** (budget harness, orgnouns header, incomplete `shapeStatus`).

I can turn any P0/P1 item into an implementation PR next if you want that.
