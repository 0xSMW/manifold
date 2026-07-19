# Manifold — Build Spec

An OpenAI-compatible, self-hostable AI gateway that is also its own logging and usage product. It runs on Vercel with Vercel Edge Config for the zero-latency hot path and Neon Postgres for durable state. One codebase serves two customers through two front doors: an indie developer's own gateway-plus-logs, and an enterprise's governed internal model exit.

This document is the build spec for a fresh monorepo. It reuses the Pulse Uptime stack and design system, imports Klu's own `ai-gateway` as the gateway core, and stays clean of the reverse-engineered Braintrust snapshot. See `CLEAN_ROOM.md` for the source rules; nothing here authorizes copying Braintrust code.

Status: pre-Phase-0 spec. Name "Manifold" is a working name pending a trademark and npm check.

---

## 1. What Manifold is

Manifold is three things bundled behind one control plane:

1. A gateway. An OpenAI-compatible data plane (`/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`) with virtual keys, provider routing, weighted targets, retries, and fallback. Adoption is a base-URL change.
2. Logging. Every request produces an immutable observation with trace ID, provider attempt spans, usage, cost, latency, and errors, written durably off the request path.
3. Governance. Model entitlements, hard and advisory budgets, cost centers, deny-first policy, and an audit trail — the controls an enterprise needs to let its own services through.

### The two front doors

The whole design turns on one decision: the same gateway core answers on two hostnames, each with its own trust model. This is the difference between Manifold and every routing library.

| Profile | Caller | Identity | Default posture |
|---|---|---|---|
| `public_app` | An indie's app, web, mobile, device clients | Short-lived end-user or device token | Narrow route allowlist, aggressive abuse limits, bounded capture, no embedded long-lived secret |
| `enterprise_egress` | A company's services, CI, agents, employee tools | Workload identity or scoped virtual key | Team and cost-center attribution, model entitlements, enforceable budgets, audit, optional network restrictions |

A deployment may run both. Each uses a separate hostname, token audience, key material, policy revision, capture policy, and default route set. The gateway picks the profile from the trusted host binding before authentication. No header, query parameter, token claim, or body field can select or upgrade the trust mode. Public and enterprise credentials are never interchangeable.

### Non-goals for v1

No prompt editor, playground, or hosted prompt execution. No datasets, evaluations, or fine-tuning — that is a separate product and the place the Braintrust contamination is worst. No proprietary query language. No realtime collaboration. No Brainstore, ClickHouse, Redis, or Supabase until a measured need exists. Postgres is authoritative for everything durable.

---

## 2. Positioning

- LiteLLM (MIT, Python) is the self-host default: routing, virtual keys, budgets. Manifold's edge is being a TypeScript/Vercel-native product with its own dashboard and logging, not a proxy you bolt observability onto.
- OpenRouter is a hosted aggregator. Manifold is self-hosted; you own the keys, the logs, and the bill.
- Portkey open-sourced its gateway (Apache-2.0, March 2026) with guardrails. Manifold overlaps on gateway features and differentiates on the two-profile model and first-class logging on your own Neon.
- Vercel AI Gateway is a closed, hosted, pay-as-you-go key. It shares the "AI Gateway" name — reason enough to ship as Manifold — and cannot be self-hosted or run as an enterprise's internal egress with its own budgets and audit.

The white space: a self-hostable gateway that is also its own logging and governance product, one binary for both the indie and the enterprise, running on the Vercel + Edge Config + Neon stack the builder already knows.

---

## 3. Architecture

### Topology

Two deployables plus two managed services.

- Control plane: a Next.js app on Vercel. Management UI, control API (`/api/v1`), and the observation ingest endpoint. Stateless functions, pooled Postgres connections, colocated with the database region.
- Data plane (gateway): the OpenAI-compatible ingress. Vercel-first for v1 as a Node/Fluid function; the core stays runtime-agnostic so Cloudflare Workers can host it later without a rewrite.
- Neon Postgres: authoritative durable state — tenants, config revisions, virtual keys, provider credentials, routes, budgets, observations, usage, audit.
- Vercel Edge Config: the read-mostly hot-path snapshot. Preloaded into the runtime, synchronous reads under 15 ms P99 and often under 1 ms.

### The hot path: zero database reads

The gateway resolves a request without touching Postgres by reading one signed snapshot from Edge Config:

- route lookup: client `model` string to a `GatewayRoute.public_name` for the endpoint kind
- key verification: match the presented key against a keyed hash held in the snapshot (never a plaintext key)
- model to provider and offering resolution, including adapter and price revision
- static policy: model entitlements and data-handling constraints that do not need live counters

That is routing, authentication, and static policy with zero database reads, which is the no-latency tier requested. Edge Config caps at roughly 5 MB per store, so the snapshot holds compact records and hashes, not high-cardinality data or logs. Large tenants shard across stores or fall back to a boot-time snapshot fetch (the portable path).

### What must not use Edge Config

Two things need strong consistency or durability and therefore hit Neon, neither on the latency-critical read path:

1. Hard budgets. Spend caps need atomic reservation. Edge Config is eventually consistent and will oversell a limit. Enterprise-egress requests reserve against a Neon transaction before dispatch and reconcile at completion. Enterprise egress tolerates one round-trip; the public-app path stays DB-free unless it opts into per-user budgets.
2. Observation writes. Logs are written asynchronously after the response starts streaming, via `after()` or a durable queue, never blocking provider traffic.

### Config distribution — reuse Pulse directly

Pulse already implements the exact publisher this needs. Reuse it:

- `lib/config`: `canonical.ts` (canonical JSON + `sha256:` content hashing), `plan.ts` / `apply.ts` (diff and precondition-checked apply), `tripwire.ts` (destructive-change approval gate), `acceptance.ts`, `validation.ts`, `schema.ts`.
- `lib/api/config-service.ts`: writes items to Edge Config through the Vercel API (`https://api.vercel.com/v1/edge-config/{id}/items`), captures the returned `x-vercel-edge-config-version`, and records a `config_operations` row (`written | accepted | rejected | failed`) with `baseConfigHash`, `targetConfigHash`, `planHash`, `diffJson`, and `edgeConfigVersion`.

Manifold's control plane publishes a `GatewayConfigRevision` the same way: build the snapshot, hash it, plan against the active revision, gate destructive changes (route deletions, entitlement removals) through the tripwire, write to Edge Config, and record the immutable operation. Rollback is republishing a prior content-addressed revision. The gateway reads the active pointer; the DB keeps the full revision history.

---

## 4. Request flow

```
OpenAI-compatible client
  → gateway ingress (Vercel function)
  → trusted-hostname → ingress profile (public_app | enterprise_egress)
  → authenticate: short-lived token | workload identity | scoped virtual key
  → resolve principal, Team, App, Action, cost center   [Edge Config]
  → deny-first model/data policy evaluation             [Edge Config]
  → hard budget reservation (enterprise only)           [Neon txn]
  → resolve route revision, target, provider credential  [Edge Config]
  → provider codec + credential injection
  → upstream provider (stream passthrough, Web Streams)
  → terminal usage/cost reconciliation                   [Neon]

In parallel, off the response path:
  accepted event → provider-attempt span(s) → terminal event
  → bounded usage/content capture (redacted per policy)
  → durable async sink → control-plane ingest → Neon
```

Every request creates or propagates W3C `traceparent`, returns a stable `x-trace-id` before the body streams, and records the routing revision, provider offering, adapter revision, and price revision. Retries and failover are child spans, so latency, error, and cost attribution survive per upstream call. Token chunks are not persisted as events. Provider credentials decrypt only inside the gateway process and never enter logs, headers, snapshots, or telemetry.

---

## 5. Data model (control plane, Neon)

Drizzle `pg-core`, mirroring Pulse's schema style (`timestamptz` helper, `bytea` custom type, string-union enums, `check` constraints). Grouped by pillar.

Identity and keys:

```
Workspace(id, slug, ...)
Team(workspace_id, id, slug, cost_center_id?)
GatewayInstallation(workspace_id, id, public_key|workload_identity, applied_config_version, last_seen_at)
GatewayIngressProfile(workspace_id, id, installation_id, hostname,
  mode: public_app|enterprise_egress, network_exposure, auth/network/policy revision ids)
VirtualKey(workspace_id, profile_id, display_prefix, keyed_hash, scopes,
  allowed_app_ids, default_app_id, default_action_id,
  principal_id?, team_id?, cost_center_id?, budget_account_id?,
  rate_limit?, expires_at, revoked_at, last_used_at)   -- store keyed hash only
ApiToken(...)  -- reuse Pulse token-service: keyed hash, scopes, revocation
```

Providers, routes, registry:

```
ProviderCredential(workspace_id, provider, encrypted_secret_ref, status, last_validated_at)
GatewayRoute(workspace_id, installation_id, public_name, endpoint_kind, active_revision_id,
  attribution_app_id, default_action_id)
GatewayRouteRevision(id, mode, ordered|weighted targets, retry/timeout policy,
  capture-policy override, content_hash, created_by, created_at)   -- immutable
GatewayTarget(provider_credential_ref, provider_model_offering_id, adapter_revision,
  base_url|deployment, region, weight, priority, health_state)
CanonicalModel / ProviderModelOffering / ProviderPriceRevision / RegistryFieldEvidence
  -- see §6; pricing in integer micro-units, never binary float
```

Logging (observations):

```
App(workspace_id, id, slug, status, default_capture_policy)
Action(app_id, id, slug, source: explicit|route_default|discovered)
ObservationEvent(...)      -- append-only journal, idempotency key, producer sequence
Observation(...)           -- deterministic reduction of events; trace/span hierarchy
TraceSummary(...)          -- root pagination
Annotation / FeedbackEvent -- mutable, separate from immutable observations
ProjectionCheckpoint(...)  -- per-projection lag, resumable
UsageRecord / CostLedger   -- exact | estimated | unknown kept separate
```

Governance:

```
GatewayPolicy → GatewayPolicyRevision → { ModelEntitlement, RequestConstraint,
  DataHandlingConstraint, PolicyApproval }
BudgetAccount(scope_type, scope_id, parent?, unit: cost_microunits|tokens,
  currency, window, limit, enforcement: advisory|hard, pricing_catalog_revision_id)
BudgetAllocation(parent, child, reserved_allowance, window)
BudgetReservation(budget_account_id, request_id, estimated_input, max_output,
  reserved_amount, status, expires_at, reconciled_amount)
PolicyDecision(request_id, outcome: allow|clamp|deny, reason_codes, policy_revision_id)
AuditEvent(actor, action, target, before_hash, after_hash, request_ref, created_at)
AlertRule(scope, metric, threshold, window, destinations)
```

Invariants: virtual keys and API tokens store keyed hashes only. Provider secrets are application-layer encrypted or held in an external secret store. App and Action slugs are unique per tenant and delete soft while telemetry or budgets reference them. Immutable revisions (route, policy, pricing) are content-addressed and never mutated in place.

---

## 6. Provider and model registry

One package, `packages/provider-registry`, is the only source of provider and model metadata used by route validation, `/v1/models`, usage normalization, and budget enforcement. Keep it independent of provider codecs: discovering a model never implies the gateway can route to it.

Sources, all MIT and imported through a pinned, reviewed transform (see `CLEAN_ROOM.md`):

- LiteLLM's catalog data for broad model, provider, capability, context-window, deprecation, and price discovery. Import the data; never run the Python proxy.
- The public braintrust-proxy repository's `model_list.json` and approved-provider sync — MIT, actively maintained, distinct from the unlicensed extracted snapshot.
- Official provider APIs and pricing pages for field-level verification. Provider-native sources outrank aggregators for hard-budget eligibility.
- Versioned operator overrides for negotiated prices and private deployments.

Refresh is an offline supply-chain workflow: a scheduled job fetches pinned inputs, validates licenses and hashes, transforms through an allowlisted Zod schema, and opens a pull request with a field-level diff. The gateway never fetches a third-party catalog on the request path. Capabilities are tri-state `supported | unsupported | unknown`; an absent upstream boolean cannot mean false. Hard monetary budgets may use only a `provider_verified` or `operator_override` price with matching units and region; unknown pricing stays visible for observability and fails closed for hard cost enforcement.

---

## 7. API surface

Gateway data plane (v1):

```
POST /v1/chat/completions   endpoint-specific codec, streaming SSE
POST /v1/responses          typed output items; not translated to chat completions
POST /v1/embeddings
GET  /v1/models             active routes visible to the principal under the profile
```

Endpoint-specific codecs, no universal request union. Unknown request and response fields preserved within size limits. Unsupported endpoint or feature combinations fail with an OpenAI-shaped `400` before any provider call. Every release publishes an endpoint-by-provider capability matrix generated from adapter metadata. Realtime, image, audio, and batch stay out of v1 until their security and telemetry contracts are explicit.

Control plane (`/api/v1`) — extend Pulse's existing surface and `lib/api` kit (middleware, principal, scopes, rate-limit, idempotency, pagination):

```
/api/v1/routes            CRUD + revisions, plan/apply against the snapshot
/api/v1/keys              virtual-key create (copy-once), rotate, revoke, scope
/api/v1/providers         provider credential create + validate (secret hidden after submit)
/api/v1/policies          entitlements, data-handling, deterministic simulation
/api/v1/budgets           accounts, allocations, hard/advisory, forecasts
/api/v1/observations      list, trace drilldown, export (JSONL)
/api/v1/observation-events:batch   ingest (installation-authenticated)
/api/v1/cli-auth          device authorization (reuse Pulse verbatim)
/api/v1/audit             searchable policy-decision and audit timelines
```

Ingest derives workspace and App identity from the installation, virtual-key scopes, and signed snapshot; it ignores caller-asserted tenant IDs. A negative test must prove a compromised key cannot attribute events outside its scopes.

---

## 8. Console (management UI)

The console is the control plane's UI — the Next.js app at `apps/control-plane` where a human configures the gateway, reads its logs, and governs its spend. One binary serves both front doors; what a user sees is gated by which ingress profiles the workspace runs. An indie with a single `public_app` profile sees a gateway and its logs. An admin with an `enterprise_egress` profile also sees policies, budgets, cost centers, and audit. Nothing reaches the gateway until it is published as a `GatewayConfigRevision`; the console's spine is the draft-then-publish loop from Pulse's config engine.

### Design system — reuse Pulse, extend for the gateway

Manifold inherits Pulse's system whole: the `globals.css` dark and light tokens, Geist Sans for words and Geist Mono with tabular figures for every number, id, URL, and timestamp, one 1px border weight, 6px controls / 12px panels / 9999px pills, card / popover / modal shadows only, and density over whitespace — 13px tables, 44–60px rows, separation by border not by surface tint. Dark is default, light is toggled and persisted. Components carry over unchanged: the five-variant Button, Input and Select, Switch, chips, StatusDot, StatusBadge, TimelineBar, the data table with its 3px inset state bar, the right Sheet for create and edit, the type-to-confirm Dialog for destructive actions, the ⌘K palette, and bottom-right toasts.

One rule bends. Pulse ships a top-nav-only shell for four destinations. Manifold has eleven across two concern groups, so the shell becomes a persistent top bar plus a left rail. The top bar holds the workspace switcher, an ingress-profile filter (`public_app` | `enterprise_egress` | all), the publish indicator, ⌘K, and the user menu. The left rail holds two groups, Gateway and Governance, the second present only when an `enterprise_egress` profile exists.

Color still means state and nothing else. Pulse's four states map onto gateway life directly:

| Pulse state | Manifold meaning |
|---|---|
| up (green) | 2xx response, healthy target, spend under limit, policy `allow` |
| verifying (amber) | retry or failover in flight, advisory budget near limit, `estimated` cost, policy `clamp` |
| down (red) | error or timeout, unhealthy target, hard budget `deny`, policy `deny` |
| idle (gray) | revoked or paused key, disabled route, no traffic in range |

Three gateway-specific encodings extend the same grammar without adding a hue: cost fidelity (`exact` in `--fg`, `estimated` amber, `unknown` faint with a badge), price source (`provider_verified` up-dot, `operator_override` neutral chip, `aggregator` amber, `unknown` faint), and capability tri-state (`supported` up, `unsupported` faint dash, `unknown` amber).

### Information architecture

```
Top bar   workspace ▾   profile: public_app ▾        ◆ Publish · 3     ⌘K   user ▾
Left rail
  GATEWAY
    Overview      traffic, spend, errors, health at a glance
    Routes        the model strings clients call and where they resolve
    Providers     provider credentials and their model offerings
    Keys          virtual keys — mint, scope, rotate, revoke
    Logs          every request as an immutable observation; trace drilldown
    Models        the provider registry — capabilities, pricing, routability
  GOVERNANCE                              (enterprise_egress present)
    Policies      deny-first entitlements, data-handling, simulator
    Budgets       cost centers, hard and advisory caps, forecasts
    Audit         policy decisions and the mutation trail
  ─────
    Deployments   installations and ingress profiles — the two front doors
    Settings      workspace, teams, cost centers, members, tokens, CLI auth
```

Every config-touching screen — Routes, Providers, Keys, Policies, Budgets, Models overrides, Deployments — edits Postgres as a draft and accumulates a diff against the active `GatewayConfigRevision`. The top-bar publish indicator counts unpublished changes; opening it is the Publish screen. The gateway reads only what has been published.

| Screen | Path | API (§7) | Profile |
|---|---|---|---|
| Overview | `/` | `/observations`, `/budgets` | both |
| Routes | `/routes` | `/routes` | both |
| Providers | `/providers` | `/providers` | both |
| Keys | `/keys` | `/keys` | both |
| Logs | `/logs` | `/observations` | both |
| Models | `/models` | registry (§6) | both |
| Policies | `/policies` | `/policies` | enterprise |
| Budgets | `/budgets` | `/budgets` | enterprise |
| Audit | `/audit` | `/audit` | enterprise |
| Deployments | `/deployments` | installations, profiles | both |
| Publish | `/publish` | config-service | both |
| Settings | `/settings` | `/keys`, `/cli-auth` | both |

### Screens

Overview — one screen answers whether the gateway is healthy and what it is costing. A range control (1h / 24h / 7d / 30d) and the profile filter sit at top; a mono KPI row shows requests, tokens in and out, spend, P50 and P95 latency, error rate, and fallback rate; a traffic chart stacks requests over time by final provider in Pulse's `--fg` stroke over an 8% fill; a spend sparkline and a provider-health strip of StatusDots sit beside it; a Recent traces table (time, model, provider, status, latency, cost, key prefix) links into Logs; and under an enterprise profile a budget-burn card appears per top cost center. Empty: no traffic yet — show the gateway base URL and a copyable curl that swaps `base_url`, the same call the first-run flow ends on. Loading: skeleton KPIs and chart shimmer. Error: an amber ingest-lag banner when the observation projection checkpoint trails live past a threshold, because the numbers are then behind.

Routes — define each `GatewayRoute.public_name` clients call and where it resolves. A toolbar (search + New Route) sits above a table with columns public_name, endpoint_kind, mode (ordered | weighted), targets summary, active revision (short content hash), 24h traffic, and status. The editor opens full-page: a header (public_name, endpoint_kind, attribution `App` and `Action`); a targets editor where each `GatewayTarget` is a provider credential plus a `ProviderModelOffering` plus weight, priority, region, and a health StatusDot; retry and timeout policy; a capture-policy override; and a revision list, every `GatewayRouteRevision` immutable and content-addressed with a diff and a roll-back that republishes it. A Test route panel sends one synthetic request and shows the resulting trace. Editing stages a draft — a banner reads "unpublished changes · review in Publish." Empty: create your first route, prefilled from a connected provider's offerings.

Providers — hold `ProviderCredential`s and surface what each can serve. A card or table view shows provider, status (valid | invalid | unvalidated) as a StatusBadge, last validated, offerings count, and regions. Add: pick provider, paste secret, Validate against the live upstream, done; the secret is copy-once at entry, stored as `encrypted_secret_ref`, and never shown again — only a display prefix. Detail shows the offerings this credential serves, the price revision, base_url or deployment (Azure), regions, and Rotate and Revoke. Empty: the provider catalog to pick from. Error: validation failure surfaces the provider's own message verbatim.

Keys — mint the credentials clients present; store keyed hashes only. The table shows display_prefix, profile, scopes, attribution (App, Team, cost center), rate limit, budget account, last used, expires, and status. Create in a Sheet: choose profile, scopes (allowed apps, default app and action), attribution, rate limit, expiry. On create, a copy-once Dialog shows the full key exactly once. Rotate mints a successor with a grace window; Revoke is immediate and uses the danger-outline button. Public-profile keys foreground rate limit, route allowlist, and short expiry; enterprise keys foreground Team, cost center, and budget account. Empty: mint your first key.

Logs — every request as an immutable `Observation`; find one and read its whole story. A dense virtualized table shows time, trace id, route and model, final provider, status, latency, tokens in and out, cost (colored by fidelity), App, Action, and key prefix; a filter bar spans time range, model, provider, status, App, Action, key, cost center, minimum latency, errors-only, and free text on trace id; Export streams the current filter as JSONL. The trace drilldown opens a right panel: a span waterfall — accepted, provider attempt(s), terminal — each attempt showing provider, offering, adapter revision, latency, status, and retry reason as child spans, so a failover reads at a glance; a usage and cost panel with the `exact | estimated | unknown` badge; request and response capture, redacted and bounded per the route's capture policy, with that policy named on the row; the `PolicyDecision` (`allow | clamp | deny` plus reason codes); and a link to the matching `AuditEvent`. Token chunks never appear as events because they are never stored. Empty: no requests match. Error: the same ingest-lag banner as Overview.

Models — the `provider-registry` made visible: what exists, what it can do, what it costs, and whether it is routable. `CanonicalModel`s list with their `ProviderModelOffering`s; a capability matrix reads in tri-state (`supported | unsupported | unknown`, never a false for a missing boolean); context window, deprecation, and price show with a source badge; a routable column is true only when a route and target exist. Operator overrides — a negotiated price or a private deployment — are set here and versioned as `ProviderPriceRevision`s. A `/v1/models` preview shows what a principal sees under a chosen profile. Unknown pricing is highlighted: visible for observability, ineligible for a hard budget.

Policies (enterprise) — deny-first entitlements and data-handling, proven before they ship. A `GatewayPolicy` holds `GatewayPolicyRevision`s; a revision holds `ModelEntitlement`s (which scopes may call which models), `RequestConstraint`s (token and parameter ceilings), `DataHandlingConstraint`s (capture, redaction, region), and `PolicyApproval`s. The editor centers on a simulator: enter a request shape — profile, key, model, params — and see `allow | clamp | deny` with reason codes evaluated against the draft revision by the same deny-first evaluator the gateway runs, so a change is tested before publish. Revisions are immutable and content-addressed; removing an entitlement trips the publish tripwire.

Budgets (enterprise) — cost centers and spend caps, advisory and hard. The `BudgetAccount` tree (workspace → Team → App or cost center) shows unit (cost microunits | tokens), window, limit, enforcement (advisory | hard), current spend, forecast, and burn rate; detail shows `BudgetAllocation`s to children, live `BudgetReservation`s for hard budgets, the pricing catalog revision in force, and `AlertRule`s. Create sets scope, unit, window, limit, and enforcement. A hard cap requires a `provider_verified` or `operator_override` price with matching units and region; the form blocks a hard cap on a model whose price is `unknown` and says why — hard cost enforcement fails closed. Over-budget rows are red and link to the denied requests in Logs by reason code.

Audit (enterprise) — the searchable record of decisions and mutations. An interleaved timeline of `PolicyDecision`s (`allow | clamp | deny` plus reason codes) and `AuditEvent`s (actor, action, target, before and after hash, request ref) filters by actor, action, target, outcome, and time; each row links to the trace or the config revision it concerns. Export configures SIEM and webhook destinations. The list is append-only; content hashes are shown for verification.

Deployments — configure the two front doors. `GatewayInstallation`s and their `GatewayIngressProfile`s show hostname, mode, network exposure, applied config version, and last seen. A profile wizard binds a hostname, sets the mode, and configures auth — a short-lived token audience for `public_app`, OIDC/SAML or workload identity for `enterprise_egress`. The screen states the invariant plainly: the profile is bound to the trusted hostname, and no header, query parameter, token claim, or body field can select or upgrade it. Empty, before a gateway connects: deploy instructions — stand up the gateway function and point it at this control plane.

Publish — the plan, apply, and rollback surface for the Edge Config snapshot; the top-bar indicator opens it. The plan is the diff of the pending snapshot against the active revision (routes, entitlements, prices added, changed, removed) with content hashes (baseConfigHash → targetConfigHash, planHash); a tripwire gate holds destructive changes — route deletions, entitlement removals — behind an explicit approval; Apply writes to Edge Config, captures the returned version, and records a `config_operations` row (`written | accepted | rejected | failed`). History lists prior revisions, each content-addressed with a diff; rollback republishes one. A rejected apply — a precondition failed — returns to re-plan.

Settings — workspace (name, slug, region), members and roles, Teams, cost centers, API tokens (Pulse's token-service, copy-once), CLI device authorization (reuse Pulse `/cli-auth` verbatim), alert destinations, and a danger zone.

### Task flows

First call, the base-URL swap: Providers ▸ Add, paste a key, Validate → Routes ▸ New, pick one offering as the target, name the route → Publish ▸ review plan ▸ Apply → Keys ▸ Mint, copy the key once → Overview shows the curl; swap `base_url` to the gateway host, send, watch the first row land in Logs with a trace.

Add a provider: Providers ▸ Add ▸ pick provider ▸ paste secret ▸ Validate; offerings populate, the secret is hidden after submit, only the prefix remains.

Mint a key: Keys ▸ Mint ▸ choose profile ▸ set scopes and attribution ▸ set rate limit and expiry ▸ create ▸ copy the full key from the once-only Dialog.

Set a hard budget: Budgets ▸ New ▸ scope to a cost center ▸ unit cost-microunits ▸ window monthly ▸ enforcement hard. If a targeted model's price is `unknown` the form blocks it and links to Models to set an operator override. Publish to enforce.

Trace an error: Logs ▸ filter errors-only ▸ open the red row ▸ read the waterfall — the failed attempt, its retry reason, the failover or terminal error, the policy decision and reason codes, and the linked audit event.

Publish a revision: edit across Routes, Policies, Budgets ▸ the indicator counts the changes ▸ Publish ▸ read the diff and hashes ▸ approve any tripwire item ▸ Apply ▸ the active version advances and the gateway serves it.

Stand up an enterprise front door: Deployments ▸ New profile ▸ bind the enterprise hostname ▸ mode `enterprise_egress` ▸ wire OIDC/SAML or workload identity ▸ attach entitlements in Policies and a hard budget in Budgets ▸ Publish ▸ send a disallowed request and watch it deny with a reason code and write an audit event. The Governance group appears in the rail once the profile exists.

### Cross-screen conventions

Draft then publish: no edit reaches the gateway until published, and the indicator is always truthful about what is pending. Copy-once for every secret — keys and tokens show plaintext exactly once, prefixes everywhere after. Reason codes are load-bearing: every clamp or deny names its codes and links policy decision, trace, and audit event. Time range and profile are global filters on every telemetry screen. Number formatting follows Pulse verbatim — integer milliseconds with unit, cost in mono, relative time then HH:MM UTC. Empty states teach the next action rather than apologize for the blank.

---

## 9. Repo layout (fresh monorepo)

npm workspaces, one root lockfile. Copy the Pulse design system and config engine; import Klu's `ai-gateway` as the gateway core.

```
apps/
  control-plane/     Next.js: UI + /api/v1 + ingest. Seeded from Pulse (app/, components/, lib/).
  gateway/           Vercel Node/Fluid function. Core imported from ai-gateway, cleaned.
  cli/               Go `mfctl`, from Pulse's pulsectl (device auth, scoped tokens, keyring).
packages/
  contracts/         Zod schemas + generated types (gateway + ingest, versioned separately).
  application/       Shared service layer (no HTTP), from Pulse lib/api + lib/*.
  database/          Drizzle schema + migrations (Neon), from Pulse lib/db style.
  gateway-core/      Runtime-agnostic: config store, authorizer, policy, budget, codecs.
  gateway-policy/    Deny-first evaluator, reason codes.
  provider-registry/ Catalog schema, importers, capability matrix (§6).
  observability/     Observation events, reducers, projection checkpoints.
  ui/                Design system: tokens (globals.css), components/ui, charts.
  config/            Snapshot publisher, from Pulse lib/config + config-service.
deploy/
  vercel/            Control-plane + gateway project config, region, env contracts.
  compose/           Portable self-host: Node gateway + Postgres + Graphile worker.
  cloudflare/        Optional later: Worker + Wrangler bindings (KV, DO, Queues).
```

What to copy from Pulse (yours, MIT): the token/design system (`globals.css` dark and light tokens, `components/ui`, charts), `lib/config`, `lib/api/config-service.ts`, `lib/api` kit, `lib/auth` (argon2 credentials, sessions), `lib/db` conventions, the Go CLI with device authorization, onboarding and readiness flows, and the `/api/v1` control-plane pattern.

What to import from `ai-gateway` (yours): the edge adapter model, provider selection and base-URL resolution, OpenAI passthrough and provider codecs, and the Web Streams / SSE utilities. Strip on import: the hard-coded `https://api.klu.ai/v1/data/` logging endpoint, the forward-all-headers behavior, the in-memory full-response tee, and the stale model-to-provider tables (replace with the registry).

Concepts to reference from `klu-gateway_DEPRECATED` and `proxy` (yours): weighted selection, ordered fallback, retry status and attempt-header contracts, and Azure multi-endpoint failover.

---

## 10. Stack and dependencies

Pin to Pulse's versions so the two projects stay in step: Next.js 16, React 19, Drizzle ORM with the `postgres` driver (keeps Neon portable to any Postgres), `@vercel/edge-config`, Tailwind v4, Base UI + Radix, `class-variance-authority` + `clsx` + `tailwind-merge`, `lucide-react`, Recharts, Resend + react-email, `argon2`, Zod v4, SWR. Go for the CLI. Node ≥ 22.

Note on Neon: it is Databricks-owned since May 2025 and has since cut storage price and grown. Drizzle plus the plain `postgres` driver keeps Manifold portable to Supabase, Aurora, or self-managed Postgres; the provider must support pgvector if related-observation detection ships later.

---

## 11. Security invariants (must hold before the gateway ships)

Keyed hashes for every virtual key and token, never plaintext. Provider credentials encrypted at the application layer, decrypted only in the gateway process, excluded from logs, headers, snapshots, crash reports, and metrics. A gateway header allowlist and an SSRF/URL policy before any provider code is imported. Body, stream, and timeout budgets enforced. Bounded capture as a release invariant: streaming must not grow memory proportional to the full response. Deny-by-default policy evaluated before credential resolution, explicit deny wins. Cross-workspace negative tests on every control-plane route. Public and enterprise credential pools isolated; public routes cannot reach enterprise-only targets without an explicit grant.

---

## 12. Phased plan

Phase 0 — Analyze `ai-gateway`, `klu-gateway_DEPRECATED`, `proxy`, and Pulse. Choose Manifold's license and add repository LICENSE and NOTICE files. Analyze the Braintrust snapshot; Analyze LiteLLM and braintrust-proxy.

Phase 1 — Monorepo foundation. Stand up the workspace layout. Seed `apps/control-plane` from Pulse. Import cleaned `ai-gateway` into `packages/gateway-core`. Add the provider-registry importer, lockfile, and golden tests. Wire Vercel projects, pooled Neon connectivity, and the Postgres job ledger. Exit: one install type-checks and tests every workspace; control plane and gateway deploy to Vercel previews.

Phase 2 — Gateway and logging. Implement `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` with endpoint codecs and conformance fixtures. Add virtual keys, provider credentials, routes and immutable revisions, and the Edge Config publisher. Add the append-only observation journal, reducer, trace summaries, and async ingest. Exit: a base-URL swap routes and logs a real provider call end-to-end with a trace and usage, zero DB reads on the routing path.

Phase 3 — Governance. Add the deny-first policy evaluator, model entitlements, data-handling constraints, budget accounts with transactional reservation and reconciliation, cost centers, policy decisions, and the audit trail. Add the `enterprise_egress` profile wizard, OIDC/SAML and workload identity, and SIEM/webhook export. Exit: an enterprise egress hostname enforces a hard budget and entitlement, denies with a reason code, and writes an audit event.

Phase 4 — Polish and OSS packaging. `mfctl` parity, `manifold init` and `manifold doctor`, the portable Compose deployment with Graphile Worker, capability matrix generation, docs, and the OSS release with NOTICE and attribution. Exit: a clean-room, self-hostable release a stranger can deploy from the README.

---

## 13. Open decisions

- Name: clear "Manifold" against trademarks and npm before committing the brand.
- License: MIT (matches Pulse) or Apache-2.0 (patent grant, matches Portkey/Bifrost). Recommend Apache-2.0 for an enterprise-facing gateway.
- Cloudflare: keep `gateway-core` runtime-agnostic; only add the Workers + Durable Objects path if globally-atomic budgets at scale become a real requirement. Do not build for it now.
- Responses vs Chat Completions: both are release requirements; do not translate Responses into Chat Completions internally.
