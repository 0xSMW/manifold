# Manifold

Manifold is an OpenAI-compatible AI gateway and operations control plane for teams
that need one place to route model traffic, issue client keys, enforce policy and
spend controls, and investigate usage.

The production edition runs as a Vercel Fluid gateway with a Next.js control plane
and Neon Postgres. Its request pipeline is runtime-agnostic, and a local Node.js
harness is included for development and testing.

**Protocol schema:** `manifold.v1`

## Key capabilities

### Route AI traffic

- Present stable public model names while routing to provider-specific models.
- Select targets by trusted ingress profile, endpoint, route, priority, weight,
  and health.
- Retry transient failures, fail over to healthy targets, and skip open circuits.
- Preserve OpenAI-compatible request and response shapes while changing only the
  configured provider model and authentication.
- Stream responses with bounded observation memory.

### Control access and governance

- Mint, scope, rotate, and revoke copy-once virtual keys.
- Separate developer-facing `public_app` traffic from governed
  `enterprise_egress` traffic through trusted-host bindings.
- Apply deny-first model entitlements and request parameter constraints.
- Enforce fleet-wide concurrency, RPM, TPM, and burst limits through strict
  Postgres admission.
- Reserve and reconcile hard budgets before and after provider execution.
- Stage, review, approve, publish, reconcile, and roll back immutable
  configuration revisions.

### Observe and operate

- Investigate requests through traces, provider attempts, retries, failovers,
  latency, usage, cost, and stable reason codes.
- Preserve cost fidelity as `exact`, `estimated`, or `unknown`.
- Persist terminal accounting through an idempotent job ledger with retry,
  stale-claim recovery, and dead-letter state.
- Search append-only audit events and verify their hash chain.
- Monitor deployment readiness, provider health, snapshot freshness, and
  configuration convergence.
- Measure storage pressure, configure retention, and compact durable telemetry
  into bounded rollups.

### Manage the product through the control plane

The control plane includes working screens and APIs for:

- providers and encrypted credentials;
- routes and immutable route revisions;
- model discovery, capabilities, price provenance, and overrides;
- virtual keys and access scopes;
- configuration planning, approval, publication, history, and rollback;
- request logs, trace details, usage, and cost;
- enterprise policies and budgets;
- audit destinations and verification;
- gateway installations, ingress profiles, diagnostics, and readiness;
- storage, retention, thresholds, and compaction;
- workspace members, teams, cost centers, applications, actions, and CLI
  authorization;
- first-party human access: owner activation, email/password sign-in, password
  reset, invitations, session control, personal tokens, and service accounts.

Enterprise governance areas appear when an `enterprise_egress` profile is
configured.

## Supported providers

| Provider | Chat Completions | Responses | Embeddings |
|---|:---:|:---:|:---:|
| Google Gemini | ✅ | — | — |
| OpenAI | ✅ | ✅ | ✅ |
| Azure OpenAI | ✅ | ✅ | ✅ |
| Anthropic bridge | ✅ | — | — |

A checkmark means the provider and endpoint combination has explicit repository
support or test coverage. The models.dev catalog contains additional providers
for discovery and pricing; catalog presence does not constitute gateway support.

## Supported OpenAI-compatible API surface

| Endpoint | Method | Purpose |
|---|:---:|---|
| `/v1/models` | `GET` | List models available to the authenticated key and ingress profile |
| `/v1/chat/completions` | `POST` | OpenAI-compatible chat, including streaming |
| `/v1/responses` | `POST` | OpenAI Responses-compatible requests |
| `/v1/embeddings` | `POST` | OpenAI-compatible embeddings |

`/v1/models` is assembled from the active signed Manifold configuration. It is a
profile-scoped gateway capability rather than a provider-specific endpoint.
Gateway errors use OpenAI-shaped envelopes and return a trace ID before the body
streams.

## How it works

```text
Client or application
        |
        | OpenAI-compatible request + Manifold virtual key
        v
Vercel Fluid gateway
        |-- authenticate and resolve trusted ingress profile
        |-- route public model to a healthy provider target
        |-- enforce policy, admission, and hard budgets
        |-- decrypt and inject the provider credential
        |-- relay the response and persist terminal accounting
        |
        +------> upstream provider
        |
        +------> Neon Postgres
                   admission, budgets, observations, usage, cost, job ledger

Control plane
        |-- manage providers, routes, keys, policy, budgets, and retention
        |-- publish signed immutable snapshots
        +------> gateway verified last-known-good configuration
```

Authentication, routing, and static policy read from a verified signed snapshot.
Short Postgres transactions remain authoritative for distributed admission, hard
budget reservations, and durable terminal reconciliation.

## Quickstart

### Prerequisites

- Node.js 22
- Corepack and pnpm 10
- Docker for database-backed development and test workflows
- Go 1.24 or newer only when working on the experimental CLI

### Install and verify

```bash
corepack enable
corepack pnpm install --frozen-lockfile

pnpm run typecheck
pnpm run build
```

### Run the local gateway harness

```bash
pnpm --filter @manifold/gateway start
# listening on http://127.0.0.1:8787
```

The local harness loads `apps/gateway/snapshot.example.json` by default. It is a
development fixture with local key material and must never be used as production
configuration. Production loads installation-authenticated signed snapshots from
the control plane and does not depend on a writable local filesystem.

See [`apps/gateway/README.md`](./apps/gateway/README.md) for gateway environment,
snapshot, and adapter details.

### Run the control plane

The control plane requires a Postgres 16+ database with the repository migrations
applied in lexical order. Migrations use a direct owner connection; the running
application uses a pooled, non-superuser `manifold_app` connection.

After configuring `DATABASE_URL` and the required development values from
[`.env.example`](./.env.example):

```bash
pnpm run dev:control-plane
# http://localhost:3000
# http://localhost:3000/api/v1/health
```

Use [`Docs/DEPLOY.md`](./Docs/DEPLOY.md) for the migration procedure, environment
contract, installation bootstrap, and production topology.

Human-access rollout, recovery, and production acceptance are documented in
[`Docs/HUMAN_AUTH.md`](./Docs/HUMAN_AUTH.md). It covers the first-owner activation
email, invitations, sessions, API-token ownership, and CLI device authorization.

## Production deployment

Production uses two separately configured Vercel projects:

- a Next.js control plane under `apps/control-plane`;
- a Node.js 22 Fluid gateway under `apps/gateway`.

The gateway uses Fluid Compute with literal rewrites for the four supported API
paths, readiness and liveness routes, and durable terminal accounting. One
durable Postgres database is bound to one workspace. Runtime connections use the
restricted application role; owner credentials are reserved for migrations and
break-glass operations.

See [`Docs/DEPLOY.md`](./Docs/DEPLOY.md) for deployment topology, environment
configuration, and installation bootstrap.

## Security and durability

- Provider credentials are envelope-encrypted and carried only as ciphertext in
  signed snapshots.
- The gateway decrypts credentials in-process, strips inbound authorization, and
  injects provider authentication only after target selection.
- Signed snapshots are tenant-bound, freshness-checked, and activated atomically
  with a verified last-known-good fallback.
- Trusted host bindings select the ingress profile before authentication; request
  headers, claims, query parameters, and bodies cannot upgrade it.
- Outbound provider traffic validates DNS answers, rejects private targets, pins
  the approved address, retains TLS SNI, and validates redirects.
- Workspace-scoped database access uses explicit transaction context plus FORCE
  RLS as defense in depth.
- Route, policy, price, and published configuration revisions are immutable and
  content-addressed.
- Completed provider responses wait for durable terminal handoff before settling.

## Repository layout

```text
apps/
  control-plane/       Next.js operations console and /api/v1 control API
  gateway/             Vercel Fluid handlers and local Node.js harness
  cli/                 Experimental Go CLI; API backing is still partial

packages/
  budget/              Hard-budget reservation and reconciliation
  config/              Snapshot build, plan, publish, reconcile, and rollback
  contracts/           Wire schemas, error envelopes, and reason codes
  crypto/              Envelope encryption and key handling
  database/            Drizzle schema, migrations, RLS, and typed access
  domain/              Money, hashes, state machines, and core vocabulary
  gateway-core/        Runtime-agnostic request pipeline
  gateway-policy/      Deny-first policy evaluator and simulator
  ids/                 Shared identifiers and ULID handling
  observability/       Observation reduction and usage/cost projection
  ports/               Runtime adapter interfaces and in-memory fakes
  provider-registry/   models.dev catalog and price importer
  storage/             Retention, object export, compaction, and pressure policy

scripts/               Repository, database, and security utilities
tools/conformance/     Provider adapter fixtures and capability matrix
tools/load/            k6 and flat-memory tooling
```

The Node workspace is defined by `pnpm-workspace.yaml`. The Go CLI is built
separately:

```bash
cd apps/cli
make build
./bin/manifold --help
```

## Testing

Run the usual local checks before contributing:

```bash
pnpm run typecheck
pnpm run test:packages
pnpm run test:control-plane
pnpm run test:playwright
```

Run the checks relevant to the packages and apps you change. The repository
scripts list additional focused test commands.

## Project boundaries

- Exact provider-reported usage is preserved when present. Missing usage remains
  visibly `estimated` or `unknown` and is never silently treated as exact.
- The Cloudflare edition remains planned behind the runtime adapter boundaries.
- The Go CLI exposes the intended command tree, but several commands still return
  structured stub output.
- The repository includes a local Node.js harness; a turnkey Compose deployment
  is not currently included.
- The intended project license is Apache-2.0; see `SPEC.md`.

## Documentation

- [`SPEC.md`](./SPEC.md): product, security, data, and architecture specification
- [`Docs/DEPLOY.md`](./Docs/DEPLOY.md): deployment and operations
- [`apps/gateway/README.md`](./apps/gateway/README.md): gateway development guide
