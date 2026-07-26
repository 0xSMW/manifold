# Gateway release acceptance

This record distinguishes exercised production behavior from local, real-Postgres, and
operator-run release gates. It contains no credential material.

Final production artifacts:

- gateway: `dpl_3XDsLnM1f3y19LpFyRc7tPK8vtFv`, aliased to
  `https://manifold-gateway.vercel.app`;
- control plane: `dpl_HwKFWBZxF8T4fEaqFTcBBG7BMH9j`, aliased to
  `https://manifold-puce.vercel.app`;
- active snapshot: `cfgrev_01KYDZRH2BF6YHT2G79QS3FGM0`.

## Current shipped evidence

| Gate | Status | Evidence |
|---|---|---|
| Vercel Fluid gateway contract | PASS | `apps/gateway/vercel.json` enables Fluid in `iad1`, with a 300-second gateway, a 60-second drainer, and the minute Cron. |
| Public OpenAI endpoint rewrites | PASS | The deployed shape routes the four supported paths — `/v1/models`, `/v1/chat/completions`, `/v1/responses`, and `/v1/embeddings` — to the Web handler with a literal original-path value. `apps/gateway/test/vercel.test.ts` prevents restoration of the wildcard placeholder regression. |
| Signed remote snapshot and LKG | PASS | Local tests cover authenticated fetch, signature/tenant validation, freshness, stale ceiling, atomic LKG, signer overlap/retirement, and heartbeat behavior. Preview and Production both converged on signed remote revisions, and a live historical rollback plus restore converged in 2.6 and 7.4 seconds. |
| Protected Preview and Production | PASS | Protected Preview returned the expected unauthenticated redirect, then passed bypassed health, readiness, models, streaming, and non-streaming Gemini traffic. Production health, readiness, models, and Gemini traffic passed on the stable alias. |
| Gemini OpenAI-compatible provider | PASS | Provider validation and model discovery passed. A 15-minute Production soak completed 638 authenticated Gemini calls with HTTP 200 and exact response validation across balanced streaming and non-streaming traffic. The provider credential and virtual keys are never recorded here. |
| Chat, Responses, embeddings, and models codecs | PASS (local) | `packages/gateway-core/test/model-routing-integration.test.ts` covers endpoint/model routing, path preservation, and provider base paths. |
| Exact usage and billing | PASS | All 638 soak traces produced exactly one observation, exact usage row, exact cost row, and completed durable ingest job. A separate bounded unknown-length JSON smoke retained exact non-stream billing, while fallback tests preserve conservative reservations when usage is absent. |
| Bounded SSE and durable terminal handling | PASS | Gateway/core and real-Postgres tests cover relay ordering, aborts, usage, reservation reconciliation, idempotent ingest, competing claims, stale recovery, and DLQ. A forced stale claim recovered exactly once during deployment interruption; a forced malformed job retried and reached DLQ with a redacted diagnostic. |
| Strict distributed admission | PASS (local + Postgres) | `apps/gateway/test/distributed-admission-pg.test.ts` covers cross-instance caps, rate limits, duplicate traces, crash lease expiry, and RLS isolation. |
| Rotation and revocation | PASS | Preview virtual-key rotation invalidated the predecessor on the first poll and converged in 945 ms. Provider credential re-encryption, prior-DEK retirement, snapshot publication, and exact Gemini smoke converged in 886 ms. The Vercel protection-bypass secret was independently rotated and its predecessor invalidated. |
| Capacity and limits | PASS WITH DEFERRED PLATFORM TELEMETRY | Production health passed 1,000/1,000 at concurrency 16; the authenticated 15-minute soak passed 638/638. Neon peaked at 2 of 112 connections (1.79%). The 1 MiB JSON boundary accepted the exact limit and rejected limit+1 before egress. The local release gate streamed 1 GiB with an 18.2 MB RSS increase against a 128 MiB ceiling. Vercel memory/FD/duration graphs remain part of the observability follow-up below. |
| Rollback readiness | PASS | A stored signed snapshot was activated, served exact Gemini traffic, and the original revision was restored and re-proven. The stable gateway alias was then rolled back to prior Ready artifact `dpl_9feSHoziCpCxE3J3J4jEkhro7Zz9`, passed readiness and exact Gemini traffic, and was promoted back to the final artifact in two seconds. |
| Health/readiness | PASS | `/health` is liveness-only and no-store; `/ready` proves a verified active snapshot and strict runtime dependencies. Both were rechecked after rotation, interruption, rollback, and restore. |
| Release gates | PASS | Node 22 control-plane, package, security, conformance, migration, environment-isolation, real-Postgres/RLS, k6, flat-memory, and production build gates pass on the shipped tree. Final trace `01KYE30PM752PGJ2HHS3Q341K1` has HTTP 200, exact usage/cost/ledger fidelity, and a completed durable job. |

## Observability follow-up

Vercel-hosted metrics, dashboards, alert delivery, and their platform memory/FD/duration panels
are **explicitly deferred by the user to a later follow-up**. OpenTelemetry instrumentation,
structured logs, durable observation events, readiness, exact billing records, and local bounded
memory gates remain active. Complete the observability section of `Docs/DEPLOY.md` before relying
on hosted SLO panels, paging, or automated promotion decisions.

## Re-run baseline

```bash
pnpm typecheck
pnpm build
pnpm --filter @manifold/gateway-core test
pnpm --filter @manifold/gateway test
pnpm --filter @manifold/config test
pnpm --filter @manifold/control-plane exec tsx --test \
  test/provider-validation.test.ts test/mutation-guard-pg.test.ts
git diff --check
```
