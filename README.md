# Manifold

An OpenAI-compatible, self-hostable AI gateway that is also its own logging and
governance product. One runtime-agnostic core serves two front doors — an indie
developer's own gateway-plus-logs (`public_app`) and an enterprise's governed
internal model exit (`enterprise_egress`). Vercel + Edge Config + Neon is the
first-class target; a Cloudflare edition ships from the same core.

- **Owner:** github.com/0xsmw · **License:** Apache-2.0 · **Schema:** `manifold.v1`
- **Not a Klu product.** Nothing here is created, deployed, or stored under any
  Klu account, Vercel scope, or GitHub org. The gateway core is written fresh
  (no legacy `ai-gateway` import).
- **Spec:** [`SPEC.md`](./SPEC.md) is normative (§0–§29). §29 is the live
  review-resolution log and working notes.

## Repository layout

```
apps/
  control-plane/   Next.js 16 — UI + /api/v1 + ingest (deployable to Vercel)
  cli/             Go `manifold` CLI (module github.com/0xsmw/manifold/cli)
packages/
  contracts/       Zod wire schemas, reason/error codes, error envelopes, SCHEMA_VERSION
```

More packages (`domain`, `gateway-core`, `database`, `config`, `observability`,
`ports`, `adapters-*`, `provider-registry`) are specified in SPEC §4 and land per
the §28 backlog.

## Develop

```bash
npm install            # workspaces: contracts + control-plane
npm run typecheck      # tsc -b (project references)
npm run build          # build all JS workspaces

# Control plane
npm run dev:control-plane        # http://localhost:3000  ·  /api/v1/health

# CLI (Go 1.24+)
cd apps/cli && make build        # -> ./bin/manifold
./bin/manifold --help
bash scripts/walk_help.sh        # exercises every command (--help, exit 0)
```

## Deploy (Vercel)

The control plane deploys standalone (self-contained `package.json`):

```bash
vercel link  --cwd apps/control-plane --project manifold --scope <team> --yes
vercel deploy --cwd apps/control-plane --scope <team>
```

Test deploys use the `ai-marketing` team. Never the `klu` scope.

## Status

Skeleton (M0/M1). The control plane serves a landing page and a `/api/v1/health`
endpoint (checks report `skipped` until wired to Neon/Edge Config — honest, not
fabricated). The CLI has the full §12 command tree with correct exit codes; leaf
commands print structured stub output. Real routing, auth, budgets, observation
ingest, and storage-bounded mode are specified in SPEC and not yet implemented.
