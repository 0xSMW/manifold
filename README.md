# Manifold

An OpenAI-compatible, self-hostable AI gateway that is also its own logging and
governance product. One runtime-agnostic core serves two front doors — an indie
developer's own gateway-plus-logs (`public_app`) and an enterprise's governed
internal model exit (`enterprise_egress`). Designed to run on Vercel + Postgres
(Neon) first; a Cloudflare edition is planned from the same core.

**License:** Apache-2.0 · **Schema:** `manifold.v1`

## Repository layout

```
apps/
  control-plane/   Next.js 16 — UI + /api/v1 (Vercel-friendly)
  gateway/         Node passthrough gateway (local / self-host)
  cli/             Go `manifold` CLI (module github.com/0xsmw/manifold/cli)
packages/
  contracts/           Zod wire schemas, reason/error codes, SCHEMA_VERSION
  domain/              Money (µ$), content hashes, state machines
  database/            Drizzle schema, migrations, typed DB access
  ports/               Platform-adapter interfaces + in-memory fakes
  gateway-core/        Pure request pipeline (no platform imports)
  gateway-policy/      Deny-first policy evaluator + simulator
  budget/              Hard-budget reserve / commit / rollback
  config/              Snapshot builder + plan/apply/rollback
  crypto/              Envelope encryption (AES-GCM, KEK-wrapped DEKs)
  observability/       Observation reduce + usage/cost projection
  provider-registry/   Offline models.dev → offerings/prices importer
```

## Develop

Requires **Node 22+**. The CLI needs **Go 1.24+**.

```bash
npm install            # workspaces: packages/* + control-plane + gateway
npm run typecheck      # tsc -b (project references)
npm run build          # build all JS workspaces

# Control plane
npm run dev:control-plane        # http://localhost:3000  ·  /api/v1/health

# Gateway (passthrough; loads apps/gateway/snapshot.example.json)
cd apps/gateway
export ANTHROPIC_API_KEY=sk-ant-...   # provider secret for the example route
npm start                             # http://127.0.0.1:8787
# Test key in the example snapshot: sk-manifold-localtest-key

# CLI
cd apps/cli && make build        # -> ./bin/manifold
./bin/manifold --help
bash scripts/walk_help.sh        # exercises every command (--help, exit 0)
```

## Deploy

The control plane is a standalone Next.js app under `apps/control-plane`:

```bash
vercel link  --cwd apps/control-plane --yes
vercel deploy --cwd apps/control-plane
```

Point it at a Postgres 16+ database (Neon works well) and set the connection
string via your host's env config. The gateway can run anywhere Node 22 runs;
see [`apps/gateway/README.md`](./apps/gateway/README.md) for local and
self-host details.

## Status

Early but real — a working vertical slice, plus stubs for the rest.

**Working today:**
- `@manifold/domain` — integer-`µ$` Money (banker's rounding, multi-term cost incl.
  cache-write/audio) + state machines · 37/37 tests.
- `@manifold/database` — full schema (47 tables, partitioned + RLS), applied and
  attack-tested against real Postgres 16 (composite-PK partitions, immutability
  triggers, fail-closed tenant isolation).
- `@manifold/crypto`, `budget`, `config`, `gateway-policy`, `observability`,
  `provider-registry` — implemented libraries with unit/integration coverage.
- `packages/ports` + `gateway-core` + `apps/gateway` — passthrough gateway (key
  auth, SSRF, header allowlist, flat-memory streaming). Proven end-to-end with a
  live provider call routed through the gateway.
- `apps/control-plane` — Next.js app with `/api/v1/health` plus early
  providers/keys/routes/config endpoints.
- `apps/cli` — full command tree (153 invocations), correct exit codes; most
  commands still stub output. `manifold ping` hits `/api/v1/health` for real.

**Still rough / not finished:** console UI, full control-plane CRUD, snapshot
publish wired end-to-end from DB → gateway, envelope-encrypted credentials on
the hot path (gateway currently takes provider secrets from env), observation
ingest/reduce in production, budget reservation on the live request path,
storage-bounded compaction, and the Cloudflare edition.
