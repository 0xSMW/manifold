# Manifold — Deployment Runbook

Test/production deploy of Manifold: the **control plane** (Next.js 16, Vercel) plus the
**gateway** (long-running `node:http` service, a container/VM — **not** Vercel serverless).

> **Vercel target: the `ai-marketing` team.** The repo's `apps/control-plane/.vercel/project.json`
> is already linked to team `ai-marketing` (`team_DfQFR8t3PzmQgeiSf4waLFrx`), project `manifold`.
> **Never** target any `klu` scope. GitHub org: `github.com/0xsmw`.
>
> Every step tagged **`RUN MANUALLY — requires the confirmed target`** is outward-facing
> (creates cloud resources, pushes secrets, or deploys). The maintainer runs these **after**
> confirming the Neon project and the `ai-marketing` Vercel project are the intended targets.
> This document does not run any of them.

## Topology

```
 CLI (manifold) ──HTTPS──►  Control plane (Vercel, ai-marketing)  ──►  Neon Postgres (role: manifold_app, pooled)
                                    │ signs config snapshots (ed25519 private seed)
                                    ▼
                            GET /api/v1/config/active  ──►  signed snapshot.json
                                    │
 API clients ──HTTPS──►  Gateway (container/VM, node:http :8787)  ──►  Neon (budget reservations)
                                    │ verifies snapshot (ed25519 public key), decrypts credmap (KEK)
                                    ▼
                            upstream provider (e.g. api.anthropic.com)
```

## Shared-secret invariants (get these wrong and it fails closed)

| Env var | Must match across | Why |
|---|---|---|
| `MANIFOLD_KEY_PEPPER` | control plane **and** gateway | gateway key hashes are `HMAC(pepper, key)`; mismatch → every key `AUTH_KEY_UNKNOWN` |
| `MANIFOLD_DATA_KEK` | control plane **and** gateway | gateway decrypts the provider credmap sealed by the control plane |
| `MANIFOLD_SNAPSHOT_PUBLIC_KEY` (GW) | = public half of `MANIFOLD_SNAPSHOT_SIGNING_KEY` (CP) | gateway verifies the snapshot signature; mismatch → refuses to load |

---

## Prerequisites (local, safe)

```bash
# From repo root. Installs the workspace and builds the 12 TS packages + control plane.
npm install
npm run build            # tsc -b across packages/*, then next build for control-plane

# Tools the outward steps need:
#   - vercel CLI      (npm i -g vercel)   — deploy + env
#   - psql            (postgres client)   — apply migrations to Neon
#   - neonctl or Neon console             — create the project (console is fine)
#   - the Go CLI:  (cd apps/cli && make build)  → apps/cli/bin/manifold
```

---

## A. Create the Neon project + get the pooled DATABASE_URL

**`RUN MANUALLY — requires the confirmed target`**

Use the Neon console (or `neonctl`). Postgres 16 to match the test harness.

1. Create project `manifold` (region near the Vercel `iad1` region, e.g. `aws-us-east-1`).
2. Capture **two** connection strings from Connection Details:
   - **Direct** (non-pooler host) — used to apply migrations as the DB **owner** role
     (e.g. `neondb_owner`). DDL, `CREATE ROLE`, `ALTER DEFAULT PRIVILEGES` need a session
     connection, not the transaction pooler.
     ```
     export MANIFOLD_MIGRATE_URL='postgresql://neondb_owner:<owner_pw>@<project>.<region>.aws.neon.tech/<db>?sslmode=require'
     ```
   - **Pooled** (the `-pooler` host) — the runtime `DATABASE_URL`. We rewrite the role to
     `manifold_app` in step C after the migrations create it:
     ```
     # after step C:
     export MANIFOLD_APP_URL='postgresql://manifold_app:<app_pw>@<project>-pooler.<region>.aws.neon.tech/<db>?sslmode=require'
     ```

> Neon note: the project owner role is **not** a real superuser. `CREATE ROLE`, RLS,
> partitioning, triggers, and `ALTER DEFAULT PRIVILEGES` all work as owner. If any migration
> statement is rejected for privileges, that is a Neon-specific blocker to resolve before the
> app can connect as `manifold_app` — see "Known blockers" at the bottom.

---

## B. Apply the migrations 0000–0006 to Neon (IN ORDER)

**`RUN MANUALLY — requires the confirmed target`**

There is **no** `drizzle-kit migrate` wired in this repo. The canonical apply path (the one the
test harness `packages/database/test/pg-harness.ts` uses) is: run each numbered `.sql` file in
lexical order through `psql` with `ON_ERROR_STOP=1`. Do the same against Neon, using the
**direct owner** URL.

First, set the real `manifold_app` password inside migration `0002` (it ships a placeholder):

```bash
# EITHER edit 0002 before applying (replace the literal CHANGEME_APP_PASSWORD):
#   packages/database/migrations/0002_app_role.sql  →  CREATE ROLE manifold_app LOGIN PASSWORD '<app_pw>'
# OR leave it and run `ALTER ROLE manifold_app PASSWORD '<app_pw>';` right after step B.
```

Apply every migration in order (exact command):

```bash
cd /Users/stephenwalker/Code/projects/manifold
for f in $(ls packages/database/migrations/[0-9][0-9][0-9][0-9]_*.sql | sort); do
  echo ">> applying $f"
  psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f" || { echo "FAILED on $f"; exit 1; }
done
# $MIGRATE_DATABASE_URL = the DIRECT owner URL from step A (MANIFOLD_MIGRATE_URL).
```

Order applied (idempotent DO-blocks where roles/partitions are created):

```
0000_tiresome_piledriver.sql          base schema (§6)
0001_partitions.sql                   RANGE/LIST partitions, RLS policies, immutability triggers
0002_app_role.sql                     non-superuser manifold_app role + least-privilege grants
0003_reservation_counter_coords.sql   reservation counter coords
0004_cache_read_tokens_rename.sql     column rename
0005_partition_rls_and_integrity.sql  partition RLS + integrity
0006_provider_credential_revoke_signal.sql  credential revoke signal
```

If you did not edit 0002, set the app password now:

```bash
psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "ALTER ROLE manifold_app PASSWORD '<app_pw>';"
```

Sanity check the app role can log in and RLS is active:

```bash
psql "$MANIFOLD_APP_URL" -c "select current_user;"   # → manifold_app
```

---

## C. Generate the KEK / pepper / snapshot signing keys (local, safe)

Run locally and paste the outputs into Vercel (step D) and the gateway env (step F).
**Store them in a password manager — they cannot be recovered.**

```bash
# Data KEK — base64 of exactly 32 bytes
openssl rand -base64 32          # → MANIFOLD_DATA_KEK   (SAME value in gateway)

# Key pepper — high-entropy string
openssl rand -hex 32             # → MANIFOLD_KEY_PEPPER  (SAME value in gateway)

# Seed-route guard secret
openssl rand -hex 32             # → MANIFOLD_SEED_SECRET

# ed25519 snapshot signing keypair (prints BOTH halves, base64 of raw 32 bytes)
node -e 'const{generateKeyPairSync}=require("node:crypto");const{publicKey,privateKey}=generateKeyPairSync("ed25519");const pk=privateKey.export({format:"der",type:"pkcs8"});const pub=publicKey.export({format:"der",type:"spki"});console.log("MANIFOLD_SNAPSHOT_SIGNING_KEY="+Buffer.from(pk.subarray(pk.length-32)).toString("base64"));console.log("MANIFOLD_SNAPSHOT_PUBLIC_KEY="+Buffer.from(pub.subarray(pub.length-32)).toString("base64"))'
# → MANIFOLD_SNAPSHOT_SIGNING_KEY  (control plane)
# → MANIFOLD_SNAPSHOT_PUBLIC_KEY   (gateway; must be the public half of the same key)
```

Choose stable ids: `MANIFOLD_DATA_KEK_ID=kek_prod_1`, `MANIFOLD_SNAPSHOT_SIGNING_KEY_ID=snap_prod_1`.

---

## D. Set the Vercel env vars on the `ai-marketing` team

**`RUN MANUALLY — requires the confirmed target`**

The project is already linked (`apps/control-plane/.vercel/project.json` → team `ai-marketing`,
project `manifold`). Set these for the **Production** environment. Set the Node.js version to
**22.x** in Project Settings → General (matches `engines.node >=22`).

```bash
cd /Users/stephenwalker/Code/projects/manifold/apps/control-plane
# (if the link is ever lost:  vercel link --scope ai-marketing --project manifold  — RUN MANUALLY)

vercel env add DATABASE_URL production                 # the POOLED manifold_app URL (MANIFOLD_APP_URL)
vercel env add MANIFOLD_DATA_KEK production             # from step C
vercel env add MANIFOLD_DATA_KEK_ID production          # kek_prod_1
vercel env add MANIFOLD_KEY_PEPPER production           # from step C
vercel env add MANIFOLD_SNAPSHOT_SIGNING_KEY production # ed25519 private seed (step C)
vercel env add MANIFOLD_SNAPSHOT_SIGNING_KEY_ID production   # snap_prod_1
vercel env add MANIFOLD_REQUIRE_REAL_KEYS production    # 1
vercel env add MANIFOLD_SEED_SECRET production          # from step C
vercel env add MANIFOLD_SEED_DB_URL production          # the DIRECT owner URL (for the one-time seed)
# NODE_ENV=production is set by Vercel automatically.
```

---

## E. Deploy the control plane to Vercel

**`RUN MANUALLY — requires the confirmed target`**

`apps/control-plane/vercel.json` pins the build so the workspace TS packages (whose `dist/` is
gitignored) are compiled before `next build`:

```
buildCommand: "tsc -b ../../tsconfig.json && next build"
framework:    "nextjs"
```

Root Directory in the Vercel project must be **`apps/control-plane`** (Vercel runs `npm install`
at the workspace root automatically).

```bash
cd /Users/stephenwalker/Code/projects/manifold/apps/control-plane
vercel deploy --prod                 # RUN MANUALLY — deploys to ai-marketing/manifold
# capture the resulting URL, e.g.:  export MF_URL=https://manifold-<hash>-ai-marketing.vercel.app
```

Smoke the deploy's DB wiring immediately:

```bash
curl -s "$MF_URL/api/v1/health" | jq .     # expect { "status":"ok", "checks": { "db":"ok" } }
```

### Bootstrap the first workspace + API token (one-time)

```bash
curl -s -X POST "$MF_URL/api/v1/admin/seed" \
  -H "x-seed-secret: $MANIFOLD_SEED_SECRET" \
  -H "content-type: application/json" \
  -d '{"slug":"acme","name":"Acme","email":"owner@acme.test"}' | jq .
# Returns the api_token (mf_tok_...) ONCE, plus the workspace + installation ids. Save the token.
export MF_TOKEN=mf_tok_...
export MF_INSTALLATION=...    # gateway_installation id from the seed response
```

---

## F. Run the gateway (container/VM — NOT Vercel)

The gateway is a long-running `node:http` server (`apps/gateway`, default port 8787). It holds a
persistent DB pool and streams upstream responses — it is **not** a serverless function and must
**not** be deployed to Vercel. Run it on a container/VM (Fly.io machine, Render/Railway service,
an EC2/GCE VM under systemd, or a Docker host). Requirements: Node ≥ 22, outbound network to Neon
and to the upstream providers, and a persistent process manager.

**`RUN MANUALLY — requires the confirmed target`** (build + ship the image/host).

1. Produce a **signed** snapshot for the gateway to load. The bundled
   `apps/gateway/snapshot.example.json` is **unsigned** and will be **rejected** in production
   (`MANIFOLD_SNAPSHOT_PUBLIC_KEY` pinned). After you have created routes/keys and run
   `manifold config apply` against the control plane, fetch the signed active snapshot:

   ```bash
   curl -s "$MF_URL/api/v1/config/active?installationId=$MF_INSTALLATION" \
     -H "authorization: Bearer $MF_TOKEN" > snapshot.active.json
   ```

2. Set the gateway env (see `.env.example`), then start it:

   ```bash
   cd /Users/stephenwalker/Code/projects/manifold/apps/gateway
   export NODE_ENV=production
   export DATABASE_URL="$MANIFOLD_APP_URL"            # same Neon DB (pooled, manifold_app)
   export MANIFOLD_KEY_PEPPER=...                     # IDENTICAL to the control plane
   export MANIFOLD_DATA_KEK=...                       # IDENTICAL to the control plane
   export MANIFOLD_SNAPSHOT_PUBLIC_KEY=...            # public half of the signing key
   export MANIFOLD_REQUIRE_REAL_KEYS=1
   export MANIFOLD_REQUIRE_SIGNED=1
   export MANIFOLD_SNAPSHOT=./snapshot.active.json
   export PORT=8787
   npm start                                         # → gateway listening on :8787
   ```

   Reference container recipe (documentation only): `FROM node:22-slim`, copy the repo, run
   `npm ci && npm run build`, `WORKDIR /app/apps/gateway`, `CMD ["npm","start"]`, expose 8787,
   put it behind TLS (the provider secrets and virtual keys ride the wire).

---

## G. Smoke test with the CLI

Build the CLI once: `cd apps/cli && make build` → `apps/cli/bin/manifold`.

```bash
# (a) liveness — real HTTP GET against the deployed control plane's /api/v1/health
manifold ping --base-url "$MF_URL"
#     (alias of `manifold installation health`)

# (b) authenticated list — real GET $MF_URL/api/v1/keys with the bearer token
manifold key list --base-url "$MF_URL" --token "$MF_TOKEN"
```

Gateway smoke (once routes/keys exist in the active snapshot) — see `apps/gateway/README.md`:

```bash
curl -s -X POST http://<gateway-host>:8787/v1/messages \
  -H "authorization: Bearer <virtual-key>" -H "content-type: application/json" -d '{}'
# a bad/unknown key → 401 AUTH_KEY_UNKNOWN envelope proves auth + snapshot are live.
```

---

## Summary — every MANUAL outward step

| Step | Command | Target |
|---|---|---|
| A | Create Neon project; capture direct + pooled URLs | Neon |
| B | `for f in …0000..0006.sql; do psql "$MIGRATE_URL" -v ON_ERROR_STOP=1 -f "$f"; done` | Neon (owner) |
| B | `ALTER ROLE manifold_app PASSWORD '…'` | Neon |
| D | `vercel env add …` (all vars, Production) | Vercel · ai-marketing |
| E | `vercel deploy --prod` | Vercel · ai-marketing |
| E | `POST /api/v1/admin/seed` (bootstrap token) | deployed CP |
| F | build/ship gateway image; `npm start` on VM | container/VM |
| F | `GET /api/v1/config/active` → snapshot.active.json | deployed CP |
| G | `manifold ping` / `manifold key list` | deployed CP |

## Known blockers to a real deploy (verify before promising "done")

- **Neon owner privileges.** Migrations create `manifold_app`, RLS, partitions, triggers, and
  `ALTER DEFAULT PRIVILEGES` as the DB owner. Neon's owner is not a superuser; if any statement
  is rejected, resolve it before the app can connect as `manifold_app`.
- **`0002` password placeholder.** `CHANGEME_APP_PASSWORD` must be replaced (edit the file or
  `ALTER ROLE`) or the pooled `DATABASE_URL` cannot authenticate.
- **Signed snapshot required in prod.** The gateway rejects the unsigned `snapshot.example.json`;
  a real signed snapshot from `/config/active` (after a config apply) is mandatory before the
  gateway will serve traffic.
- **Provider credentials.** The gateway skeleton still reads the provider secret from
  `ANTHROPIC_API_KEY`; the real path decrypts the sealed credmap (KEK). Confirm which path this
  build uses before pointing it at production traffic (`apps/gateway/README.md` TODOs).
- **`dist/` is gitignored.** A fresh Vercel/container checkout has no package `dist/`. The pinned
  `buildCommand` (`tsc -b ../../tsconfig.json && next build`) and the gateway image's
  `npm run build` are what compile them — do not skip them.
