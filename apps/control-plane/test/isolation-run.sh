#!/usr/bin/env bash
# End-to-end control-plane isolation proof: spins PG16, applies migrations, boots the API,
# and drives real HTTP (seed 2 workspaces, mint a key as A, assert B cannot see it, auth 401s).
# Run: bash apps/control-plane/test/isolation-run.sh   (requires docker + node 22)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; cd "$ROOT"
PORT=4321; PGPORT=55460; CID=mf-cp-run
lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
docker rm -f $CID >/dev/null 2>&1
docker run -d --name $CID -e POSTGRES_PASSWORD=pw -p $PGPORT:5432 postgres:16 >/dev/null
until docker exec $CID psql -U postgres -d postgres -tAc "select 1" >/dev/null 2>&1; do sleep 0.5; done
docker exec -i $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < packages/database/migrations/0000_tiresome_piledriver.sql 2>/tmp/mig0.log
docker exec -i $CID psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 < packages/database/migrations/0001_partitions.sql 2>/tmp/mig1.log
[ "$(docker exec $CID psql -U postgres -d postgres -tAc "select to_regclass('public.api_token')")" = "api_token" ] || { echo "MIGRATION FAILED"; docker rm -f $CID >/dev/null 2>&1; exit 1; }
echo "migrations verified"
PRIV=$(node --input-type=module -e "import {generateSigningKeyPair} from '@manifold/config'; process.stdout.write(generateSigningKeyPair().privateKeyBase64)")
export DATABASE_URL="postgresql://postgres:pw@127.0.0.1:$PGPORT/postgres"
export MANIFOLD_TOKEN_PEPPER="dGVzdC1wZXBwZXItMzJieXRlcy0wMDAwMDAwMDAw"
export MANIFOLD_SNAPSHOT_SIGNING_KEY="$PRIV" MANIFOLD_SNAPSHOT_SIGNING_KEY_ID="k1" MANIFOLD_SEED_SECRET="seed-secret-xyz"
( cd apps/control-plane && exec npx next start -p $PORT >/tmp/cp_run_server.log 2>&1 & echo $! >/tmp/cp_run.pid )
curl -sS --retry-connrefused --retry 40 --retry-delay 1 --max-time 5 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1
BASE="http://127.0.0.1:$PORT" MANIFOLD_SEED_SECRET="$MANIFOLD_SEED_SECRET" node "$HERE/isolation-drive.mjs"; RC=$?
kill "$(cat /tmp/cp_run.pid 2>/dev/null)" 2>/dev/null; lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null
docker rm -f $CID >/dev/null 2>&1
exit $RC
