# Manifold deployment and operations runbook

This runbook describes a reusable Vercel control-plane and gateway deployment procedure. Keep
credential material, virtual keys, and one-time installation keys out of this document. The dated
checkpoint below may record only non-secret deployment, source, snapshot, and health evidence.

## Runtime and readiness

Deploy the gateway as a Vercel Node.js 22.x Fluid Compute function in the selected region, with a
gateway duration appropriate to the platform and workload. Configure Preview and Production
independently for signed installation snapshots and an OpenAI-compatible provider.

- The control-plane `GET /api/v1/health` checks its runtime and `DATABASE_URL`; `200` with
  `checks.db = "ok"` is control-plane health proof only.
- `/health` and `/api/health` are liveness-only and return `Cache-Control: no-store`.
- `/ready` and `/api/ready` are the operational readiness gate; require 200 before a promotion.
- Public provider traffic is limited to the explicitly supported OpenAI-compatible paths listed
  below.

### Current internal-dogfood checkpoint

An earlier 2026-07-28 check found control-plane health and gateway liveness at 200 while gateway
readiness returned 503. After applying migrations through `0035`, repairing the runtime-role
privilege/readiness checks, and configuring the gateway Vercel project Root Directory as
`apps/gateway`, immutable candidates from source revision
`cba8abf5f99e7ca992f954bdff4ab2316dc6d469` passed the public promotion gate:

- control plane `dpl_75Pjr3B6yeSZfJL8wauchcUoxUMB`: `GET /api/v1/health` returned 200 with
  `checks.db = "ok"`, `/login` returned 200, and activation status returned
  `{"required":false,"configured":true}`;
- gateway `dpl_5zN7QMoYBnfFEwRX8URDaasPFWLh`: `GET /health` returned 200 with `no-store`, and
  `GET /ready` returned 200 with verified snapshot revision
  `cfgrev_01KYDZRH2BF6YHT2G79QS3FGM0`;
- both provenance responses matched the immutable Vercel deployment ID and exact source revision;
- the verified candidates were assigned to `manifold-puce.vercel.app` and
  `manifold-gateway.vercel.app`, and alias-mode health acceptance passed.

This evidence establishes database-backed control-plane health, public login-route availability,
gateway liveness, signed-snapshot readiness, runtime database privileges, and immutable release
provenance. The authenticated provider/observation diagnostic was not run because dedicated live
diagnostic credentials were unavailable. Email delivery, Cron execution, object-store permissions,
provider billing, load/soak, rotation, and recovery gates still require their separate acceptance
checks before customer traffic.

Choose a supported Fluid memory class and verify its limits against the current
[Vercel function memory](https://vercel.com/docs/functions/configuring-functions/memory)
documentation before deployment.

## Topology

### Workspace scheduler deployment

ADR-0021 binds one durable Postgres database to one workspace. Deploy the control-plane storage
Cron routes once for each workspace-bound control-plane deployment, with that deployment's
`DATABASE_URL`, `DATABASE_URL_DIRECT`, and `CRON_SECRET` scoped to the same database. The routes
intentionally discover only that database's single `workspace` row; they never enumerate a
directory database or synthesize cross-workspace connection URLs. Installations are scheduled by
their own deployment/trigger binding. A database with zero or more than one workspace row fails
closed before storage measurement, enqueue, or compaction.

The storage drainer has a dedicated 60-second function duration and starts at most one durable
compaction job per fire, with a 50-second admission budget. Compaction persists its seal/export
state before destructive work and resumes that state from the durable job ledger on later fires.

```text
CLI / console
    |
    v
Control plane deployment
    |  signs immutable installation snapshots
    |  authenticates installation requests
    v
Gateway deployment, Node 22 Fluid
    |  verified isolate LKG snapshot cache
    |  DNS-pinned provider egress
    |  durable terminal job ledger + waitUntil + Cron
    +----> upstream providers
    |
    +----> pooled Neon manifold_app connection
             budget reservations, usage/cost projections, job ledger
```

Authentication and routing read only the verified signed snapshot. A short Postgres transaction
remains authoritative for distributed admission, hard monetary reservations, and durable
terminal reconciliation.

## Immutable runtime configuration

The checked-in gateway settings are in `apps/gateway/vercel.json`:

- `fluid: true`
- region `iad1`
- `api/gateway.ts` maximum duration 300 seconds
- job drainer maximum duration 60 seconds
- `/health` and `/ready` aliases
- literal rewrites for `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and
  `/v1/embeddings` to the Web Request/Response gateway handler
- one-minute `/api/internal/jobs/drain` Cron
- workspace-aware install/build command

Project settings must remain:

| Setting | Required value |
|---|---|
| Team | designated deployment team |
| Project | designated gateway project |
| Root Directory | `apps/gateway` |
| Node.js | `22.x` |
| Fluid Compute | enabled |
| Region | `iad1` |
| Function duration | 300 seconds |
| Memory | Standard |
| Files outside root | enabled |

Verify before every production promotion:

```bash
vercel project inspect <gateway-project> --scope <team>
vercel pull --yes --environment=preview --scope <team>
vercel build --standalone
jq . .vercel/output/functions/api/gateway.func/.vc-config.json
du -sh .vercel/output
```

The emitted gateway runtime must be `nodejs22.x`; every emitted relative import must use `.js`.

## Database and migrations

Use two Neon URLs:

- direct owner URL for migrations and break-glass repair;
- pooled `manifold_app` URL for both Vercel runtimes.

In the commands below, `MANIFOLD_MIGRATE_URL` is an operator-local shell variable for the direct
owner URL. Do not configure it as an application runtime variable.

Apply numbered migrations in lexical order. On a fresh database, apply the complete chain. On an
existing database, reconcile the operator migration receipt against the checked-in list and apply
only the verified unapplied suffix; these SQL files are not a replay-every-release mechanism.
Never hard-code an ending migration number:

```bash
corepack pnpm run check:migrations
printf '%s\n' packages/database/migrations/[0-9][0-9][0-9][0-9]_*.sql

# Fresh database only, or begin this loop at the first verified unapplied file.
for migration in packages/database/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  psql "$MANIFOLD_MIGRATE_URL" -v ON_ERROR_STOP=1 -q -f "$migration" || exit 1
done
```

Gateway launch requires both `0021_gateway_distributed_admission.sql` and
`0022_gateway_target_health.sql`. The second migration adds append-only provider-attempt facts,
the durable target-health projection, and due-workspace discovery for the rollup/publication
worker.

The application role must be non-superuser with `rolbypassrls = false`. Verify from the pooled
URL and run the repository's real-Postgres/RLS suites before promotion.

Migration procedure:

1. record the current code deployment, schema migration list, database branch/backup, operator,
   and maintenance window;
2. prove the currently deployed code is compatible with the additive target schema;
3. apply migrations from the direct owner URL with lock and statement timeouts appropriate to the
   production-size rehearsal;
4. record each applied filename and completion time, then verify `manifold_app` remains
   non-superuser, FORCE RLS is enabled, and cross-workspace reads return no rows;
5. run gateway readiness, strict-admission, durable-ledger, and target-health checks before
   promotion;
6. on failure, freeze promotion and choose the documented forward fix or prior-code redeploy.
   Never run an unreviewed destructive down migration against production.

Contracting migrations follow expand → backfill → switch → observe through the rollback window →
contract. Retain the migration record, rehearsal result, and recovery decision with the release
record.

### Human-auth rollout (`0032_human_auth.sql`)

`0032_human_auth.sql` is an additive rollout. Apply it in lexical order with the other migrations
from the direct owner connection; do not attempt a down migration. It preserves legacy member,
token, and browser-session rows while adding human identity, password, activation/reset,
invitation, service-account, and subject metadata. A bad human-auth record is repaired by
revoking it or issuing a successor credential, never by restoring plaintext material or weakening
the hash/RLS boundary.

Before applying it, record the one enabled owner and confirm that its existing email is deliverable.
The first activation is intentionally constrained to exactly one enabled owner. After deployment,
that owner requests activation, receives the activation email, chooses a password, and signs in.
Do not create a second owner to work around this bootstrap gate. Existing members are retained as
legacy accepted records by the migration; they are not silently bound to a human identity by email.

Postflight:

1. Confirm `0032_human_auth.sql` is recorded and the application role can use only the approved
   security-definer auth operations; it must not receive direct access to global auth tables.
2. Complete the initial owner activation and a normal email/password login from the production
   origin. Confirm the activation link is one-time.
3. Create, accept, resend, revoke, and expire a test invitation. Direct member provisioning is
   retired; create people only through Invitations.
4. Exercise password reset and confirm existing human sessions are invalidated. Exercise
   single-session and “other sessions” revocation, then revoke a personal and a service token.
5. Confirm a sole active owner cannot be disabled or demoted. Create a second accepted owner
   before any planned owner offboarding.

If the code deploy must be rolled back after `0032`, leave the additive schema in place and redeploy
the previous compatible application. For an email-provider outage, do not bypass activation or
invent credentials: preserve the committed owner/invitation state, restore a verified Resend
configuration, then resend or request a fresh action link. Rotate/revoke affected tokens or
sessions through the product controls if a credential is suspected exposed.

## First-workspace bootstrap

The internal seed route creates the first workspace, owner, API token, installation identity,
trusted hostname/profile, default app, and seed catalog entry. It requires both
`MANIFOLD_SEED_SECRET` and the privileged direct `MANIFOLD_SEED_DB_URL`; the application-role
connection cannot safely determine whether a workspace already exists before selecting an RLS
workspace.

Send an explicit deployable gateway hostname:

```bash
umask 077
seed_receipt="$(mktemp)"
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "x-seed-secret: $MANIFOLD_SEED_SECRET" \
  --header "content-type: application/json" \
  --data '{"slug":"internal","name":"Internal","email":"owner@example.com","region":"us-east-1","hostname":"gateway.example.com"}' \
  --output "$seed_receipt" \
  "https://<control-plane-origin>/api/v1/admin/seed"
```

Treat `seed_receipt` as copy-once secret material. Move its `apiToken` into the operator secret
store and its `MANIFOLD_INSTALLATION_PRIVATE_KEY` into the gateway project's secret environment,
then record only the non-secret workspace, installation, profile, and public-key identifiers.
The stored installation key is SPKI public material; the private PKCS#8 value exists only in the
successful response. A repeated request for the same explicit slug returns `already_seeded` with
stable identifiers and null copy-once secrets. If the first response is lost, create replacement
credentials through normal product controls; never regenerate or overwrite the recorded
installation identity by guessing.

When an explicit hostname is operationally unavailable, `MANIFOLD_SEED_GATEWAY_DOMAIN` can derive
`<slug>.<domain>`. `.local` hostnames are rejected. Remove the seed secret, privileged seed URL,
and optional seed domain from steady-state Vercel environments after bootstrap.

## Gateway environment

Set the following separately for Preview and Production. Secret values must come from the
password manager or the control plane's one-time installation-key response.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | pooled Neon URL using `manifold_app` |
| `MANIFOLD_INSTALLATION_ID` | installation bound to this gateway project |
| `MANIFOLD_WORKSPACE_ID` | workspace owning that installation |
| `MANIFOLD_CONTROL_PLANE_URL` | bare HTTPS control-plane origin |
| `MANIFOLD_INSTALLATION_PRIVATE_KEY` | base64 PKCS#8 Ed25519 installation identity |
| `MANIFOLD_SNAPSHOT_PUBLIC_KEY` | legacy single pinned snapshot-signing public key |
| `MANIFOLD_SNAPSHOT_PUBLIC_KEYS` | preferred rotation keyring: strict JSON `signingKeyId → public key` map, maximum four |
| `MANIFOLD_KEY_PEPPER` | legacy single key-hash pepper, matching the control plane |
| `MANIFOLD_KEY_PEPPERS` | preferred rotation overlap: strict JSON `[new, old]`, maximum two |
| `MANIFOLD_DATA_KEK` | legacy KEK for ID-less snapshots, matching the control plane |
| `MANIFOLD_DATA_KEKS` | preferred rotation keyring: strict JSON `kekId → base64 KEK` map, maximum four |
| `CRON_SECRET` | exact Bearer secret for the Vercel Cron drainer |
| `MANIFOLD_ADMISSION_MODE` | must be `postgres_strict` |

Recommended explicit controls:

| Variable | Default |
|---|---:|
| `MANIFOLD_SNAPSHOT_FRESH_MS` | 5000 |
| `MANIFOLD_SNAPSHOT_MAX_STALE_MS` | 60000 |
| `MANIFOLD_SNAPSHOT_TIMEOUT_MS` | 2000 |
| `MANIFOLD_SNAPSHOT_MAX_BYTES` | 1048576 |
| `MANIFOLD_ADMISSION_LEASE_TTL_MS` | 330000 |
| `MANIFOLD_MAX_REQUEST_BYTES` | 4000000 |
| `MANIFOLD_MAX_KEY_CONCURRENCY` | 16 |
| `MANIFOLD_MAX_CONCURRENCY` | 128 |
| `MANIFOLD_CONCURRENCY_MAX_KEYS` | 10000 |
| `MANIFOLD_CIRCUIT_FAILURE_THRESHOLD` | 5 |
| `MANIFOLD_CIRCUIT_WINDOW_MS` | 60000 |
| `MANIFOLD_CIRCUIT_RESET_MS` | 30000 |
| `MANIFOLD_CIRCUIT_MAX_TARGETS` | 10000 |

Optional snapshot accelerator variables are documented in `.env.example`. Its bearer token is
separate from installation authentication and must never be sent to the control-plane origin.

List environment names without printing values:

```bash
cd apps/gateway
vercel env ls preview
vercel env ls production
```

Configure Preview and Production independently; never copy Production secret values into Preview
or into release artifacts.

## Control-plane environment

Set control-plane variables independently in Preview and Production. Use `.env.example` as the
name/source-of-truth inventory; do not treat this table as authority to reuse values between
environments.

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | required pooled `manifold_app` runtime URL |
| `DATABASE_URL_DIRECT` | required when the checked-in storage compaction Crons are enabled; direct unpooled URL |
| `CRON_SECRET` | required exact Bearer secret for every checked-in Vercel Cron route |
| `MANIFOLD_DATA_KEK` | required production credential-encryption KEK; must match the gateway's active KEK material |
| `MANIFOLD_DATA_KEK_ID` | required stable identifier stamped on newly sealed credentials |
| `MANIFOLD_KEY_PEPPER` | required production virtual-key pepper; must overlap/match the gateway configuration |
| `MANIFOLD_SNAPSHOT_SIGNING_KEY` | required base64 Ed25519 private seed used to sign snapshots |
| `MANIFOLD_SNAPSHOT_SIGNING_KEY_ID` | required when the gateway uses the preferred keyed public-key ring |
| `MANIFOLD_MUTATION_REPLAY_KEY` | required base64 32-byte key for copy-once sensitive response replay |
| `MANIFOLD_INVITATION_DELIVERY_KEY` | required base64 32-byte key for encrypted, crash-safe invitation delivery recovery |
| `MANIFOLD_STORAGE_COMPACTION_SECRET` | required only when using the separately authenticated storage compaction worker route |
| `MANIFOLD_OBJECT_STORAGE_ENDPOINT`, `MANIFOLD_OBJECT_STORAGE_REGION`, `MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID`, `MANIFOLD_OBJECT_STORAGE_SECRET_ACCESS_KEY` | required before production object-storage retention deletion can become eligible |
| `MANIFOLD_OBJECT_STORAGE_SESSION_TOKEN` | optional temporary-credential session token |
| `MANIFOLD_EDGE_CONFIG_*` | optional snapshot accelerator write configuration |
| `MANIFOLD_GATEWAY_DIAGNOSTICS_URL`, `MANIFOLD_GATEWAY_DIAGNOSTICS_TOKEN` | optional; both required for gateway diagnostics |
| `MANIFOLD_SEED_DB_URL`, `MANIFOLD_SEED_SECRET` | required by the bootstrap seed route; remove from steady-state deployments after seeding |
| `MANIFOLD_SEED_GATEWAY_DOMAIN` | optional bootstrap-only fallback when the seed request omits its explicit deployable hostname |
| `MANIFOLD_AUDIT_DELIVERY_SECRET` | optional direct worker credential; Vercel Cron uses `CRON_SECRET` |

The object-storage credentials must be scoped to immutable `PutObject`/`HeadObject` operations for
the configured archive prefix, without delete permission. Production retention deletion stays
blocked until export configuration and verification succeed.

List names without printing values, then prove behavior separately:

```bash
cd apps/control-plane
vercel env ls preview
vercel env ls production
```

The checked-in control-plane Crons are:

| Route | Schedule |
|---|---|
| `/api/v1/internal/audit-delivery/cron` | every minute |
| `/api/v1/internal/keys/grace-expiry` | every minute |
| `/api/v1/internal/target-health/cron` | every minute |
| `/api/v1/internal/config-publication-recovery` | every minute |
| `/api/v1/internal/mutation-cleanup` | every 5 minutes |
| `/api/v1/internal/storage/drain` | every minute |
| `/api/v1/internal/storage/measure` | every 15 minutes |
| `/api/v1/internal/storage/compact/hourly` | hourly |
| `/api/v1/internal/storage/compact/daily` | daily at 00:10 UTC |
| `/api/v1/internal/storage/compact/monthly` | monthly on day 1 at 00:30 UTC |

Vercel Cron supplies `Authorization: Bearer $CRON_SECRET`; a route appearing in `vercel.json` does
not prove delivery or authorization. For each route, retain one production execution with a 2xx
response and expected bounded summary, plus queue age/retry/dead evidence where applicable.

## Control-plane human-auth environment

Set these **control-plane** variables independently in Preview and Production:

| Variable | Required | Purpose |
|---|---:|---|
| `RESEND_API_KEY` | yes | Resend API credential for activation, invitation, and password-reset email |
| `RESEND_FROM_EMAIL` | yes | From address on a Resend-verified domain |
| `MANIFOLD_AUTH_ORIGIN` | yes | Canonical absolute control-plane origin used in action links; HTTPS in production |
| `MANIFOLD_AUTH_TOKEN_PEPPER` | yes in production | HMAC pepper for opaque human action/session credentials |
| `MANIFOLD_CONSOLE_ORIGIN` | normally unset | Optional separate origin for CLI device approval; uses the same HTTPS/origin-only validation |

There are no human-auth TTL environment flags in this release. Expiry is enforced by the stored
credential records; CLI device authorization currently expires after 10 minutes and polls at a
server-supplied interval. Do not add undocumented TTL or legacy compatibility variables to a
deployment. `MANIFOLD_KEY_PEPPER` is for gateway/API-key hashing and is not a substitute for
`MANIFOLD_AUTH_TOKEN_PEPPER`.

CLI device authorization uses `MANIFOLD_AUTH_ORIGIN` for its verification URL by default, so a
separate console-origin setting is normally unnecessary. Set `MANIFOLD_CONSOLE_ORIGIN` only when
device approval is intentionally hosted at a different canonical control-plane origin. It must be
an absolute HTTPS origin in production, with no credentials, path, query, or fragment; an invalid
override fails closed rather than falling back to another origin.

Before setting `RESEND_FROM_EMAIL`, verify its sending domain in Resend. A successful deployment
does not prove delivery: send a non-sensitive activation test and inspect the resulting sender and
link origin. Pulse's Vercel Resend variables are project-local Sensitive variables; they cannot be
read or link-shared. Enter a securely supplied Manifold-specific key, or create a new key, directly
in the Manifold project. Never paste a secret or private email into this repository, a ticket, or a
release artifact.

## Snapshot publication and revocation SLA

The control plane is the authoritative snapshot source. A gateway refresh:

1. optionally tries the accelerator;
2. signs the control-plane request with the installation Ed25519 identity;
3. caps response time and bytes;
4. verifies installation ID, content hash, schema, and Ed25519 snapshot signature;
5. atomically replaces isolate LKG only after all checks pass;
6. serves LKG only through `MANIFOLD_SNAPSHOT_MAX_STALE_MS`, then fails closed.

The configured revoke/rotation propagation objective is:

```text
freshness poll 5 seconds + one 2-second fetch window;
absolute stale ceiling 60 seconds during dependency failure.
```

Before production traffic, prove against Preview:

- revoked virtual key is rejected by every warmed instance inside the stated SLA;
- rotated provider credential is adopted inside the SLA;
- old snapshot signature, wrong installation, tampering, oversize, and rollback revisions cannot
  replace verified LKG;
- once LKG exceeds the maximum stale age, readiness and dispatch fail closed.

## Build, test, and deploy

Run from the repository root:

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run check:migrations
corepack pnpm run check:environment-isolation
npm run build -w packages/ports
npm run build -w packages/gateway-core
npm test -w packages/gateway-core
npm run typecheck -w apps/gateway
npm test -w apps/gateway
```

The control plane and gateway are separate Vercel projects. Confirm the project name and configured
Root Directory before invoking the CLI. The control-plane project configures `apps/control-plane` and
the gateway project configures `apps/gateway` as their Root Directories. Invoke the CLI from the
repository root for both projects: running from either application directory applies the remote root
a second time, uploads an incomplete workspace, and loses Vercel's immutable Git provenance. Use a
clean checkout or an explicit project link for each command; do not relink or deploy from an ambiguous
project binding.

Control-plane repository gates include:

```bash
corepack pnpm run typecheck
corepack pnpm run test:control-plane
corepack pnpm run test:security
corepack pnpm run test:pg
```

The real-Postgres gate requires its local container/runtime prerequisites. A passing local gate is
repository evidence; it does not prove the production migration, database role, Vercel
configuration, Cron delivery, email delivery, or live gateway behavior.

Control-plane Preview, from a clean repository root linked to the control-plane project:

```bash
vercel project inspect <control-plane-project> --scope <team>
vercel pull --yes --environment=preview --scope <team>
vercel build --standalone
vercel deploy --prebuilt --target=preview --scope <team>
```

Before building, confirm the inspect/pull output still reports Root Directory
`apps/control-plane` and the intended Node.js runtime. Repeat with
`--environment=production`, `vercel build --prod --standalone`, and
`vercel deploy --prebuilt --prod` only after Preview acceptance passes.

Gateway Preview:

```bash
vercel pull --yes --environment=preview --scope <team>
vercel build --standalone
vercel deploy --prebuilt --target=preview --scope <team>
```

Use authenticated Vercel curl when Preview Deployment Protection is enabled:

```bash
vercel curl /health --deployment <preview-deployment-id> -- --include
vercel curl /ready --deployment <preview-deployment-id> -- --include
```

Production:

```bash
vercel deploy --prod --skip-domain --scope <team>
vercel inspect <immutable-candidate-url> --scope <team> --json
vercel curl /health --deployment <immutable-candidate-url> -- --include
vercel curl /ready --deployment <immutable-candidate-url> -- --include
```

Run this source deployment from the repository root. A locally prebuilt gateway artifact is useful
for package validation, but a prebuilt CLI deployment does not provide the Git source metadata
required by the immutable-candidate provenance gate. Never assign the production alias unless the
candidate's readiness, deployment ID, exact source revision, and every applicable gate below pass.

For the control-plane project, use the same source-deploy → immutable-candidate inspection
progression against its own Vercel project and environment. After deployment, require
`GET /api/v1/health` to return 200 with `checks.db = "ok"`, then run the human-auth acceptance in
`Docs/HUMAN_AUTH.md` and verify the Cron routes above. A Ready Vercel deployment or a 200 health
response alone is insufficient.

## Smoke and billing checks

The tracked `.github/workflows/live-acceptance.yml` workflow runs hourly alias health separately
from its callable production-promotion gate. The deployment workflow must pass its immutable
control-plane and gateway candidate URLs and their Vercel deployment IDs to the callable workflow,
then make alias assignment depend on
`production-alias-promotion-gate`. The diagnostic probes require each responding service to emit
the Vercel-derived `x-manifold-deployment-id` and `x-manifold-source-revision` headers; absent or
mismatched headers fail the gate. Gateway `/ready` is recorded with its verified snapshot revision.
Do not use a mutable production alias or operator-supplied labels as provenance.

Configure the `live-acceptance` GitHub environment with:

- variables `MANIFOLD_LIVE_CONTROL_PLANE_URL`, `MANIFOLD_LIVE_GATEWAY_URL`,
  `MANIFOLD_LIVE_DIAGNOSTICS_MODEL`, and optional `MANIFOLD_LIVE_DIAGNOSTICS_ENDPOINT`;
- dedicated secrets `MANIFOLD_LIVE_DIAGNOSTICS_TOKEN` and
  `MANIFOLD_LIVE_CONTROL_PLANE_TOKEN`.

The tracked manual `Production promotion` workflow additionally requires GitHub secrets
`MANIFOLD_VERCEL_TOKEN`, `MANIFOLD_VERCEL_ORG_ID`,
`MANIFOLD_VERCEL_CONTROL_PLANE_PROJECT_ID`, and `MANIFOLD_VERCEL_GATEWAY_PROJECT_ID`. It deploys
both projects with `--skip-domain`, derives the candidate URLs and deployment IDs from Vercel,
waits for the callable diagnostic gate, and only then assigns the explicit aliases supplied at
dispatch. Do not promote aliases outside that dependency chain.

Candidate diagnostics send one bounded request, require a valid gateway trace ID, then poll the
control-plane observation endpoint until the matching observation and cost projection are durable.
Use narrowly scoped, revocable tokens and never reuse a customer credential.

Required Preview checks:

1. `/health` returns 200 and `no-store`.
2. `/ready` returns 200 with only safe snapshot revision/verified-at/age metadata and a live
   Postgres admission check.
3. invalid virtual key returns OpenAI-shaped 401 without provider egress.
4. `/v1/models` returns only active public names for the resolved profile.
5. one non-streaming provider call writes one terminal trace, one usage row, one cost row, and
   commits its reservation at provider-reported actual cost.
6. one SSE call relays bytes unchanged, withholds the `[DONE]` frame until durable terminal
   enqueue, records final provider usage, and commits the exact actual cost.
7. an aborted/incomplete SSE call records `PROVIDER_STREAM_ABORTED` and reconciles the hold.
8. one transient failure emits a `provider_attempt`, safely retries/fails over, and exposes the
   attempt waterfall in tracing.
9. DNS changes between validation and connection cannot reach a private address.
10. Cron retries a forced ingest failure, stale claims recover, and exhausted work reaches DLQ.

## Load, soak, and platform limits

Run the load harness from a protected Preview deployment using synthetic provider endpoints.
Capture deployment ID, git SHA, snapshot revision, test command, and raw result artifact.

Health/load example:

```bash
VERCEL_AUTOMATION_BYPASS_SECRET='<preview-bypass-secret>' \
npm run load:smoke -w apps/gateway -- \
  --url https://<preview-deployment-url> \
  --endpoint /health \
  --concurrency 16 \
  --requests 1000 \
  --expect-status 200
```

Authenticated provider/soak example (the virtual key is accepted as an argument or through
`MANIFOLD_VIRTUAL_KEY`, and is never emitted in the JSON artifact):

```bash
VERCEL_AUTOMATION_BYPASS_SECRET='<preview-bypass-secret>' \
MANIFOLD_VIRTUAL_KEY='<preview-key>' \
npm run load:smoke -w apps/gateway -- \
  --url https://<preview-deployment-url> \
  --endpoint /v1/chat/completions \
  --body-file ./fixtures/load-chat.json \
  --concurrency 16 \
  --duration-s 900 \
  --expect-status 200
```

Minimum gates:

- payload: exact request limit accepted; limit + 1 rejected before egress;
- memory: long SSE stream has a flat bounded heap profile;
- duration: streams near 300 seconds close cleanly; no test exceeds the platform cap;
- FD/socket: concurrency does not exhaust the Vercel function's file-descriptor allowance;
- Neon: pooled connections remain within project limits under Fluid concurrency;
- rate/concurrency: strict Postgres admission admits exactly the configured fleet-wide caps under
  burst; measure admission latency and Neon pool utilization independently from hard-budget work;
- interruption: kill/deploy after provider final usage and before drain, then prove the ledger
  recovers exactly once;
- soak: sustained traffic has no growth in heap, open sockets, stale claims, reservation age, or
  snapshot age.

Record these capacity artifacts for both Preview and the production canary:

| Workload | Minimum run | Pass threshold |
|---|---:|---|
| health baseline | 1,000 requests, concurrency 16 | zero unexpected status/transport errors |
| strict admission burst | configured cap plus one from separate clients | exactly cap admitted; cap+1 denied; zero overshoot |
| authenticated provider soak | 15 minutes, concurrency 16 | gateway 5xx <1%; no monotonic heap/socket/job-age growth |
| streaming memory | 1 GiB synthetic SSE | bounded parser memory; no response buffering or FD exhaustion |
| long stream | 290 seconds | clean completion and terminal reconciliation before the 300-second cap |
| Neon admission/reservation | peak planned rate | pool <80%; reservation errors <0.1%; admission and reservation P99 recorded separately |
| ingest | sustained planned event rate | terminal-to-queryable P99 ≤5 seconds |

Record the results for each load, soak, and capacity check. Validate platform memory, FD/socket,
and duration behavior with the chosen observability tooling.

The production Neon compute must remain warm for strict admission and hard budgets. Record its
autosuspend setting, pool ceiling, observed connection peak, and cold-start probe; scale-to-zero
invalidates the latency gate.

Production requires `MANIFOLD_ADMISSION_MODE=postgres_strict`. One short, RLS-scoped Postgres
transaction serializes each installation/key admission, so RPM/TPM and concurrency have zero
overshoot at the database boundary. The gateway fails closed when that authority is unavailable.
An expiring 330-second lease recovers capacity after an isolate crash and outlives the function's
300-second maximum duration. Local development may omit the distributed adapter and use bounded
per-process guards. Circuit state remains per-isolate; hard budgets remain authoritative in
Postgres through their separate transaction.

## Observability, dashboards, and alerts

`@vercel/otel` registers OpenTelemetry for the gateway. The request lifecycle emits:

- `manifold.gateway.request` spans;
- `manifold.gateway.provider_attempt` child spans;
- request/attempt duration histograms and counters;
- cardinality-bounded structured completion logs;
- durable accepted/provider-attempt/terminal observation events.

Configure a Vercel Trace/Log Drain or standard `OTEL_EXPORTER_OTLP_*` destination. Create one
gateway dashboard with:

- request rate, error/deny rate, p50/p95/p99 duration;
- provider attempts, retries, failovers, status, and duration;
- snapshot age/revision divergence and heartbeat age;
- terminal queue pending/retry/dead count and oldest age;
- reservation failures, reserved age, released/committed counts;
- exact/estimated/unknown cost fidelity;
- circuit open/half-open target count;
- function memory, duration, FD/socket, and Neon pool utilization.

Page on:

- readiness non-200 for 2 consecutive minutes;
- snapshot age above 30 seconds warning, above 60 seconds critical;
- active vs applied revision divergence above 60 seconds;
- terminal queue oldest pending/retry above 2 minutes or any new dead job;
- target-health rollup/publication oldest pending above 2 minutes or any new dead job;
- durable target health remaining unhealthy/unknown beyond its route SLO;
- hard-budget reconciliation failure or reservation age above 5 minutes;
- provider 5xx/timeout above 5% for 5 minutes;
- gateway 5xx above 1% for 5 minutes;
- p99 latency above the route SLO for 10 minutes;
- Neon connection utilization above 80%;
- any unexpected production config/signature/authentication failure.

No dashboard, alert, or paging control is considered configured until it has an owner,
destination, query, and verified test delivery.

The operator dashboard and alerts must implement these exact SLIs:

| SLI | Target | Warning / page |
|---|---|---|
| successful gateway requests / eligible gateway requests | 99.9% monthly | multi-window error-budget burn freezes non-critical releases |
| gateway-added request overhead P99 | public ≤15 ms; proxied TTFB overhead ≤20 ms | warn on 10-minute breach; page on sustained customer SLO impact |
| terminal-to-queryable ingest lag P99 | ≤5 seconds | warn above 5 seconds; page above 60 seconds |
| reservation transaction errors / reservation attempts | <0.1% | page at or above 0.1% for 5 minutes |
| snapshot verification failures | 0 | page immediately on any production failure |
| terminal/health job DLQ | 0 new dead jobs | page on any new dead job |
| Neon pool utilization | <80% | warn at 80%; page if saturation causes admission/readiness failures |

Every alert definition needs the metric/query, denominator, evaluation window, dashboard link,
owner, notification destination, runbook anchor, and verified test delivery.

## Durable target-health publication

Provider attempts enter the same RLS-scoped durable observation transaction as terminal usage and
cost. The control-plane minute Cron drains `target_health_rollup`, reduces a five-minute evidence
window, and publishes a signed health-only snapshot revision through `target_health_publish`.
Targets become unhealthy after at least five transient failures at a 50% or greater failure
ratio, recover after the three literal newest qualifying attempts succeed, and expire to unknown
after 120 seconds without evidence. Permanent failures are neutral for recovery.

Set the same `CRON_SECRET` on the control-plane project and its target-health Cron caller. Before
launch, prove the complete chain in Preview: force target A to fail, observe a newly signed
unhealthy snapshot, confirm the gateway skips A, then record three consecutive successes and
confirm a newly signed healthy snapshot makes A eligible again. Capture rollup/publish job age,
retry, stale-claim recovery, and DLQ evidence.

## Canary, rollback, and rotations

Canary:

1. record the candidate deployment ID, source revision, snapshot revision, baseline window, owner,
   and rollback deployment;
2. deploy Preview and complete all gates;
3. deploy Production with `--skip-domain`, then smoke the immutable deployment through authenticated
   `vercel curl`;
4. send synthetic and operator traffic to that artifact for 30 minutes;
5. promote the alias only when gateway 5xx is below 1%, reservation errors are below 0.1%,
   snapshot verification failures and new dead jobs are zero, readiness is continuously 200, and
   latency/ingest targets above hold;
6. observe the promoted alias for another 30 minutes. Any threshold breach freezes promotion and
   invokes code or snapshot rollback. Vercel aliasing provides a gated full cutover, so a percentage
   canary requires a separately configured traffic controller.

The canary record contains start/end timestamps, request volume, deployment and snapshot IDs,
dashboard links, decision, approver, and any rollback timestamp.

Code rollback:

```bash
vercel rollback <known-good-production-deployment-url> --scope <team>
```

Snapshot rollback uses the control-plane rollback operation and republishes a signed immutable
revision. Verify gateway heartbeats converge before declaring rollback complete.

Credential rotation:

1. create and validate the replacement credential;
2. publish a snapshot referencing the replacement;
3. wait for all gateway heartbeats/readiness to report the new revision;
4. smoke the provider;
5. revoke the old credential;
6. prove old material is rejected and no stale gateway uses it.

Snapshot-signing-key rotation requires an overlap deployment: first deploy gateways that trust
both old and new key IDs, then publish snapshots signed by the new private key, verify every
heartbeat has converged, and only then deploy a trust set without the old key and destroy the old
signer. Abort by restoring the overlap trust set and the last old-key-signed revision.

Pepper rotation requires dual-read support: deploy gateways with `[new, old]`, configure the
control plane to hash newly published virtual-key records with `new`, republish, prove old and new
virtual keys across warmed instances, then remove `old`. Never switch the control plane first.

KEK rotation requires an overlap keyring: create a versioned new KEK, re-wrap each active DEK
without decrypting provider ciphertext, publish targets carrying the new KEK ID, prove live
decrypt/provider smoke across warmed instances, then remove and destroy the old KEK. Abort by
republishing the prior wrapped-DEK snapshot while both KEKs remain trusted.

Each rotation record identifies the owner, old/new key IDs, affected snapshot revisions,
heartbeat convergence, smoke result, retirement time, and recovery test. Complete and retain the
corresponding keyring and live-validation checks before using these procedures.

## Incident actions

Declare severity and an incident commander before mutation: SEV-1 for credential/signing
compromise, cross-tenant exposure, billing corruption, or broad gateway outage; SEV-2 for degraded
provider routing, queue lag, or capacity loss with a safe fallback. Record detection time, affected
deployment/snapshot/workspaces, frozen changes, every operator action, and customer/status
communications. Preserve deployment logs, safe metric exports, config operations, audit rows,
job IDs/statuses, and migration records without copying secrets or request bodies.

Gateway 5xx or readiness failure:

1. freeze production promotion and config changes;
2. inspect `/health`, `/ready`, deployment logs, snapshot age, heartbeat, queue age, and Neon;
3. identify code, snapshot, provider, database, or credential boundary;
4. rollback code or snapshot independently;
5. keep dispatch failed closed if signature, tenant binding, credentials, or hard-budget
   reconciliation is uncertain.

Provider outage:

1. confirm provider-attempt spans and circuit state;
2. disable unhealthy targets in a signed snapshot;
3. publish and verify heartbeat convergence;
4. monitor retry amplification and deadline exhaustion.

Terminal/DLQ incident:

1. stop promotions and preserve job rows;
2. restore the dependency;
3. drain bounded batches;
4. verify idempotent projections and reservation reconciliation;
5. manually replay dead work only after payload and failure cause review.

Credential or signing compromise:

1. freeze code/config publication and page SEV-1;
2. disable the affected credential/key or signer and publish a signed revocation with an unaffected
   trusted signer;
3. verify every heartbeat converges inside the stale ceiling and old material fails on every warmed
   instance;
4. rotate dependent credentials/keys, inspect audit/config operations, and restore traffic only
   after a clean live smoke and zero snapshot verification failures.

Neon saturation or admission outage:

1. keep strict admission and hard budgets failed closed;
2. inspect pool utilization, transaction latency, active/expired leases, reservation age, and
   oldest ledger work;
3. stop load, restore/warm Neon, drain bounded work, and prove lease recovery plus exact budget
   reconciliation before restoring traffic.

Alert-delivery failure:

1. declare the dashboard/alert channel impaired and establish a human watch on readiness, 5xx,
   queue age, reservation errors, snapshot failures, and Neon;
2. repair the destination and send a labeled test alert;
3. verify delivery and end manual watch only after the configured owner acknowledges it.

Recovery exit criteria are readiness continuously 200, the active/applied snapshot converged,
no new dead work, reservations reconciled, provider smoke green, affected SLOs stable for 30
minutes, and the incident commander recording the close/next actions.

Never copy credentials, virtual keys, prompts, provider bodies, DSNs, or installation private
keys into logs, tickets, or chat.

## Launch gates

Production customer traffic remains blocked until all are true:

- required Preview and Production environment-variable names are present and their values/scopes
  have been functionally verified without exposing them;
- signed snapshot readiness is 200;
- live non-streaming and SSE provider billing checks pass;
- revoke and credential-rotation SLA passes across warmed instances;
- crash/deploy interruption recovery passes;
- Neon/Fluid health load, authenticated soak, payload, and local bounded-memory gates pass;
- canary and independent code/snapshot rollback rehearsals pass;
- launch evidence records direct, complete proof for every applicable gate.

Complete dashboard and paging controls before using their signals as customer-traffic SLO or
automated-promotion inputs.
