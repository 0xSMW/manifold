# @manifold/gateway

A **real, runnable passthrough gateway** — the thin Node entry that implements the platform
ports (SPEC §4.4) and delegates the request pipeline to `@manifold/gateway-core`.

It authenticates the client's virtual key, decodes OpenAI-compatible chat, Responses,
embeddings, and models requests, resolves `(profile, endpoint, public model)`, selects a healthy
target, substitutes the provider model, injects provider auth, pins egress to a validated DNS
answer, and streams the response with bounded observation memory.

## Architecture

```
apps/gateway (this)          Vercel Web handlers + local node:http harness + durable Neon adapters
  └─ @manifold/gateway-core   pure pipeline: handleRequest() — ZERO platform imports
       └─ @manifold/ports     platform-adapter interfaces + in-memory fakes (./testing)
            └─ @manifold/contracts  SCHEMA_VERSION, ReasonCode, error envelopes
```

`gateway-core` never imports `next`, `@vercel/*`, `@cloudflare/*`, or `node:*`; every platform
touchpoint arrives by dependency injection through `@manifold/ports` (ADR-0004, §4.2).

## Run it

```bash
# from the repo root, once:
npm install
npm run build            # builds contracts + ports + gateway-core to dist/

# start the local node:http harness (loads ./snapshot.example.json by default):
cd apps/gateway
npm start                             # → manifold gateway listening on http://127.0.0.1:8787
# npm run dev                         # same, with --watch
```

Local-harness environment:

| var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `MANIFOLD_SNAPSHOT` | `./snapshot.example.json` | snapshot file to load |
| `MANIFOLD_KEY_PEPPER` | `dev-pepper-not-for-production` | HMAC pepper for key hashing (§14.3) |
| `MANIFOLD_KEY_PEPPERS` | unset | strict `[new, old]` overlap array; takes precedence during rotation |
| `MANIFOLD_DATA_KEK` | development KEK outside production | unwraps the snapshot credential DEK |
| `MANIFOLD_DATA_KEKS` | unset | strict `kekId → KEK` keyring for versioned snapshot targets |

The example snapshot has: profile `localhost` → `public_app`; one virtual key
(**plaintext test key: `sk-manifold-localtest-key`**, stored as its HMAC hash); one route
`/v1/messages` → `https://api.anthropic.com` with Anthropic auth injection.

## Vercel Fluid function

`api/gateway.ts` is the production Web `Request`/`Response` entrypoint. `vercel.json` enables
Fluid Compute, pins `iad1`, sets a 300-second gateway duration, exposes `/health` and `/ready`,
rewrites the four supported public endpoints (`/v1/models`, `/v1/chat/completions`,
`/v1/responses`, and `/v1/embeddings`), and schedules the durable job-ledger drain every minute. Production loads
installation-authenticated signed snapshots through `MANIFOLD_CONTROL_PLANE_URL`, atomically
activates verified last-known-good state, and fails closed after the configured maximum staleness.
It never relies on a writable runtime filesystem.

See the root `.env.example` for the Vercel gateway variables. The gateway project requires the
pooled `manifold_app` database URL, its installation/workspace binding, the snapshot public key,
the shared pepper/KEK, the installation Ed25519 private key, and `CRON_SECRET`.

Terminal accounting is a durable `job_ledger` write keyed by trace, followed by an immediate
`waitUntil` drain and a once-per-minute Cron safety net. Claims use `FOR UPDATE SKIP LOCKED`,
stale claims recover, failures back off to a bounded retry count, and exhausted work becomes DLQ
state. Every completed provider response waits for durable terminal handoff before it settles.
SSE holds its completion frame until final usage and terminal intent have been persisted.

The Vercel runtime requires strict Postgres admission: one short RLS-scoped transaction atomically
enforces fleet-wide per-key/global concurrency and RPM/TPM/burst, with a 330-second crash-recovery
lease and fail-closed behavior. Request size and circuit state remain bounded per isolate. Provider
attempts are durable observation events and OpenTelemetry child spans. DNS-pinned Undici egress
keeps TLS SNI on the approved hostname and manually validates redirects.

## Proxy a real provider request

Once a signed active snapshot contains a sealed provider credential, the client authenticates
with the Manifold **virtual key**. The gateway decrypts and injects the provider key in-process:

```bash
curl -N http://localhost:8787/v1/messages \
  -H "authorization: Bearer sk-manifold-localtest-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "max_tokens": 1,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

The gateway strips the inbound `Authorization`, decrypts the credential envelope, injects the
provider authentication headers, SSRF-checks the destination, and streams the response.
`X-Trace-Id` is returned before the body. The local harness can append JSONL; the Vercel function
hands complete traces to the durable Postgres job ledger.

Guard failures return OpenAI-shaped error envelopes (SPEC §0.3), e.g. a wrong key:

```bash
curl -s -X POST http://localhost:8787/v1/messages \
  -H "authorization: Bearer wrong" -H "content-type: application/json" -d '{}'
# {"error":{"message":"api key not recognized","type":"authentication_error","param":null,"code":"AUTH_KEY_UNKNOWN"}}
```

## Test (spends zero external tokens)

```bash
cd apps/gateway && npm test
```

The suite covers codecs/model collisions, retry/failover/circuit behavior, provider-attempt
ordering, rate/concurrency/request caps, byte-transparent SSE accounting, hard-budget terminal
gating, signed snapshot freshness/LKG behavior, DNS pinning/rebinding/redirect attacks, durable
job-ledger retry/DLQ/RLS behavior, and real Postgres billing reconciliation.

## Current deployment state

The production gateway runs on Vercel Fluid with the signed installation runtime configured. A
protected Preview and Production deployment have exercised provider validation, model discovery,
streaming and non-streaming chat, exact usage/cost projection, key revocation, credential rotation,
deploy-interruption recovery, DLQ behavior, payload limits, signed-snapshot rollback, and restore.
A 15-minute Production soak completed 638/638 authenticated Gemini requests with exact usage and
cost rows for every trace while Neon peaked at 2 of 112 connections. `/health` is liveness-only;
`/ready` remains the required release-promotion gate.

Vercel-hosted metrics, dashboards, and alert delivery are explicitly deferred to a later
follow-up. The gateway continues to emit OpenTelemetry and durable observation events; the
deferred platform memory, FD, duration, SLO, paging, and automated-promotion panels must be
configured before those hosted controls are relied upon.
