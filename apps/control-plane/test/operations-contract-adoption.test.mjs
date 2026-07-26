import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const routes = [
  "app/api/v1/config/active/route.ts",
  "app/api/v1/config/plan/route.ts",
  "app/api/v1/config/history/route.ts",
  "app/api/v1/installations/route.ts",
  "app/api/v1/installations/[id]/route.ts",
  "app/api/v1/installations/[id]/disable/route.ts",
  "app/api/v1/deployments/[id]/profiles/route.ts",
  "app/api/v1/deployments/[id]/diagnostics/route.ts",
  "app/api/v1/deployments/[id]/readiness/route.ts",
  "app/api/v1/internal/keys/grace-expiry/route.ts",
  "app/api/v1/internal/storage-compact/route.ts",
  "app/api/v1/internal/config-publication-recovery/route.ts",
  "app/api/v1/internal/target-health/cron/route.ts",
  "app/api/v1/internal/mutation-cleanup/route.ts",
];

test("operations routes adopt strict shared request/query and response contracts", async () => {
  for (const route of routes) {
    const source = await readFile(new URL(route, root), "utf8");
    assert.match(source, /@manifold\/contracts/, route);
    assert.match(source, /contract(?:Body|Query|OptionalEmptyBody|Ok)/, route);
  }
});

test("internal recovery workers validate their exact success projections", async () => {
  const recovery = await readFile(new URL("app/api/v1/internal/config-publication-recovery/route.ts", root), "utf8");
  assert.match(recovery, /contractOk\(InternalContracts\.configPublicationRecoveryResponse/);
  const targetHealth = await readFile(new URL("app/api/v1/internal/target-health/cron/route.ts", root), "utf8");
  assert.match(targetHealth, /contractOk\(InternalContracts\.targetHealthCronResponse/);
  const cleanup = await readFile(new URL("app/api/v1/internal/mutation-cleanup/route.ts", root), "utf8");
  assert.match(cleanup, /contractOk\(InternalContracts\.mutationCleanupResponse/);
});

test("config plan exposes the documented GET contract while retaining the console POST form", async () => {
  const source = await readFile(new URL("app/api/v1/config/plan/route.ts", root), "utf8");
  assert.match(source, /export async function GET\(/);
  assert.match(source, /ConfigContracts\.planQuery/);
  assert.match(source, /export async function POST\(/);
  assert.match(source, /ConfigContracts\.plan/);
});

test("active snapshot query uses the strict shared installation contract", async () => {
  const source = await readFile(new URL("app/api/v1/config/active/route.ts", root), "utf8");
  assert.match(source, /contractQuery\(url\.searchParams, ConfigContracts\.activeQuery\)/);
});
