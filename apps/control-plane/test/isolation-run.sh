#!/usr/bin/env bash
# End-to-end control-plane isolation proof: spins PG16, applies migrations, boots the API,
# and drives real HTTP (seed 2 workspaces, mint a key as A, assert B cannot see it, auth 401s).
#
# SECURITY: the app connects as the NON-superuser `manifold_app` role (migration 0002), so RLS
# (§6.16/§15.2) is actually enforced at runtime instead of being bypassed by a superuser. This
# script proves that: it ASSERTS the connecting role has rolsuper=f, still gets ALL-PASS from the
# HTTP driver (auth works via the SECURITY DEFINER carve-out), and adds an adversarial RLS-backstop
# check — a raw cross-tenant SELECT as manifold_app with no/wrong workspace GUC returns 0 rows.
#
# Run: bash apps/control-plane/test/isolation-run.sh   (requires docker + node 22)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$ROOT"
PORT=4321; PGPORT=55460; CID=mf-cp-run
APP_PW="app-test-pw"   # test-only; replaces the migration's CHANGEME_APP_PASSWORD placeholder
lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
docker rm -f $CID >/dev/null 2>&1
docker run -d --name $CID -e POSTGRES_PASSWORD=pw -p $PGPORT:5432 postgres:16 >/dev/null
until docker exec $CID psql -U postgres -d postgres -tAc "select 1" >/dev/null 2>&1; do sleep 0.5; done
docker exec -i $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < packages/database/migrations/0000_tiresome_piledriver.sql 2>/tmp/mig0.log
docker exec -i $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < packages/database/migrations/0001_partitions.sql 2>/tmp/mig1.log
# 0002: create the non-superuser app role + grants + auth carve-out (SECURITY DEFINER functions).
docker exec -i $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < packages/database/migrations/0002_app_role.sql 2>/tmp/mig2.log || { echo "MIGRATION 0002 FAILED"; cat /tmp/mig2.log; docker rm -f $CID >/dev/null 2>&1; exit 1; }
# Replace the placeholder password with a known test secret (per-environment step documented in 0002).
docker exec $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c "ALTER ROLE manifold_app PASSWORD '$APP_PW'" >/dev/null
[ "$(docker exec $CID psql -U postgres -d postgres -tAc "select to_regclass('public.api_token')")" = "api_token" ] || { echo "MIGRATION FAILED"; docker rm -f $CID >/dev/null 2>&1; exit 1; }
echo "migrations verified"

# --- Assert the app role is NON-superuser (rolsuper=f). If this is 't' the whole RLS backstop is inert. ---
ROLSUPER=$(docker exec $CID psql -U postgres -d postgres -tAc "select rolsuper from pg_roles where rolname='manifold_app'")
echo "manifold_app rolsuper=$ROLSUPER"
[ "$ROLSUPER" = "f" ] || { echo "FAIL: manifold_app is a superuser (rolsuper=$ROLSUPER) — RLS would be bypassed"; docker rm -f $CID >/dev/null 2>&1; exit 1; }
# Also confirm the LIVE connection the app will use resolves to a non-superuser (belt and suspenders).
CONN_SUPER=$(docker exec $CID psql "postgresql://manifold_app:$APP_PW@127.0.0.1:5432/postgres" -tAc "select current_user||':'||current_setting('is_superuser')")
echo "app connection identity=$CONN_SUPER"
[ "$CONN_SUPER" = "manifold_app:off" ] || { echo "FAIL: app connection is superuser ($CONN_SUPER)"; docker rm -f $CID >/dev/null 2>&1; exit 1; }

PRIV=$(node --input-type=module -e "import {generateSigningKeyPair} from '@manifold/config'; process.stdout.write(generateSigningKeyPair().privateKeyBase64)")
# App connects as the NON-superuser manifold_app (NOT postgres) so RLS is enforced at runtime.
export DATABASE_URL="postgresql://manifold_app:$APP_PW@127.0.0.1:$PGPORT/postgres"
export MANIFOLD_TOKEN_PEPPER="dGVzdC1wZXBwZXItMzJieXRlcy0wMDAwMDAwMDAw"
export MANIFOLD_SNAPSHOT_SIGNING_KEY="$PRIV" MANIFOLD_SNAPSHOT_SIGNING_KEY_ID="k1" MANIFOLD_SEED_SECRET="seed-secret-xyz"
( cd apps/control-plane && exec npx next start -p $PORT >/tmp/cp_run_server.log 2>&1 & echo $! >/tmp/cp_run.pid )
curl -sS --retry-connrefused --retry 40 --retry-delay 1 --max-time 5 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1
BASE="http://127.0.0.1:$PORT" MANIFOLD_SEED_SECRET="$MANIFOLD_SEED_SECRET" node "$HERE/isolation-drive.mjs"; RC=$?

# --- Adversarial RLS-backstop assertion: prove RLS is now load-bearing. -----------------------
# The HTTP driver above seeded ≥2 workspaces, so api_token/virtual_key rows EXIST in the DB.
# As the superuser they are visible (RLS bypassed); as manifold_app with the workspace GUC unset
# — or set to a bogus workspace — RLS must hide EVERY row. If these return non-zero, RLS is not
# actually enforced and the fix is a no-op.
echo "--- RLS backstop (adversarial) ---"
SUPER_CNT=$(docker exec $CID psql -U postgres -d postgres -tAc "select count(*) from api_token")
echo "superuser sees api_token rows: $SUPER_CNT (RLS bypassed — expected > 0)"
APP_UNSET=$(docker exec $CID psql "postgresql://manifold_app:$APP_PW@127.0.0.1:5432/postgres" -tAc "select count(*) from api_token")
echo "manifold_app, GUC UNSET, api_token count: $APP_UNSET (expected 0)"
# SET emits a "SET" command tag before the counts; keep only the numeric result lines.
APP_BOGUS=$(docker exec $CID psql "postgresql://manifold_app:$APP_PW@127.0.0.1:5432/postgres" -tAc "set manifold.workspace_id='ws_does_not_exist'; select count(*) from api_token; select count(*) from virtual_key" | grep -E '^[0-9]+$' | tr '\n' ' ' | sed 's/ *$//')
echo "manifold_app, GUC=bogus workspace, api_token+virtual_key counts: $APP_BOGUS (expected: 0 0)"
RLS_OK=1
[ "$SUPER_CNT" -gt 0 ] 2>/dev/null || { echo "FAIL: expected superuser to see seeded api_token rows"; RLS_OK=0; }
[ "$APP_UNSET" = "0" ] || { echo "FAIL: manifold_app saw $APP_UNSET api_token rows with no workspace GUC — RLS NOT enforced"; RLS_OK=0; }
[ "$APP_BOGUS" = "0 0" ] || { echo "FAIL: manifold_app saw cross-tenant rows with a bogus GUC ($APP_BOGUS) — RLS NOT enforced"; RLS_OK=0; }
if [ "$RLS_OK" = "1" ]; then echo "PASS RLS backstop: rows exist for superuser but are invisible to the app role without a valid workspace GUC"; else echo "RLS-BACKSTOP FAILED"; fi

kill "$(cat /tmp/cp_run.pid 2>/dev/null)" 2>/dev/null; lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
docker rm -f $CID >/dev/null 2>&1
# Overall pass requires BOTH the HTTP driver (ALL-PASS) and the new RLS-backstop assertion.
[ $RC -eq 0 ] && [ "$RLS_OK" = "1" ] || exit 1
exit 0
