import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = (path) => new URL(`../app/api/v1/${path}/route.ts`, import.meta.url);
const databaseSource = new URL("../../../packages/database/src/schema.ts", import.meta.url);
const replayMigration = new URL("../../../packages/database/migrations/0016_mutation_guard_replay_hardening.sql", import.meta.url);

const requestAndResponseRoutes = [
  ["policies", "PolicyEndpointContracts.create", "PolicyEndpointContracts.list"],
  ["policies/[id]/approve", "PolicyEndpointContracts.approve", "PolicyEndpointContracts.approveResponse"],
  ["policies/[id]/revisions", "PolicyEndpointContracts.revision", "PolicyEndpointContracts.revisionResponse"],
  ["policies/[id]/simulate", "PolicyEndpointContracts.simulate", "PolicyEndpointContracts.simulateResponse"],
  ["budgets", "BudgetEndpointContracts.create", "BudgetEndpointContracts.list"],
  ["budgets/[id]/allocate", "BudgetEndpointContracts.allocate", "BudgetEndpointContracts.allocationResponse"],
  ["audit/destinations", "AuditEndpointContracts.destinationCreate", "AuditEndpointContracts.destinationList"],
  ["audit/destinations/[id]", "AuditEndpointContracts.destinationPatch", "AuditEndpointContracts.destination"],
  ["settings/tokens", "SettingsEndpointContracts.tokenMint", "SettingsEndpointContracts.tokenMintResponse"],
];

test("governance mutation routes parse strict bodies and validate named outputs", async () => {
  for (const [path, requestContract, responseContract] of requestAndResponseRoutes) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, new RegExp(`contractBody\\(req, ${requestContract.replaceAll(".", "\\.")}`), path);
    assert.match(source, new RegExp(`contractOk\\(${responseContract.replaceAll(".", "\\.")}`), path);
  }
});

test("governance read routes validate deep success projections", async () => {
  for (const [path, contract] of [
    ["policies", "PolicyEndpointContracts.list"], ["policies/[id]", "PolicyEndpointContracts.detail"],
    ["budgets/[id]", "BudgetEndpointContracts.detail"], ["budgets/[id]/forecast", "BudgetEndpointContracts.forecast"],
    ["audit", "AuditEndpointContracts.list"], ["audit/[id]", "AuditEndpointContracts.detail"],
    ["audit/verify", "AuditEndpointContracts.verify"], ["settings/tokens", "SettingsEndpointContracts.tokenList"],
  ]) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, new RegExp(`contractOk\\(${contract.replaceAll(".", "\\.")}`), path);
  }
});

test("every scoped settings method adopts strict request and deep response contracts", async () => {
  const settingsRoutes = [
    "settings/workspace", "settings/members", "settings/members/[id]", "settings/teams", "settings/teams/[id]",
    "settings/cost-centers", "settings/cost-centers/[id]", "settings/apps", "settings/apps/[id]",
    "settings/apps/[id]/actions", "settings/apps/[id]/actions/[actionId]", "settings/cli-auth", "settings/danger-zone",
  ];
  for (const path of settingsRoutes) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, /contractQuery\(/, `${path} must reject unknown and repeated query parameters`);
    assert.match(source, /contractOk\(SettingsEndpointContracts\./, `${path} must validate its success projection`);
  }
  for (const path of ["settings/workspace", "settings/members", "settings/members/[id]", "settings/teams", "settings/teams/[id]", "settings/cost-centers", "settings/cost-centers/[id]", "settings/apps", "settings/apps/[id]", "settings/apps/[id]/actions", "settings/apps/[id]/actions/[actionId]"]) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, /contractBody\(/, `${path} mutation must parse a strict shared body schema`);
  }
  for (const path of ["settings/teams/[id]", "settings/cost-centers/[id]", "settings/apps/[id]", "settings/apps/[id]/actions/[actionId]"]) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, /contractOptionalEmptyBody\(/, `${path} DELETE must reject supplied body fields`);
  }
});

test("settings and retention boundaries reject permissive query parsing and validate named retention contracts", async () => {
  const allSettingsRoutes = [
    "settings", "settings/alerts", "settings/tokens", "settings/tokens/[id]/revoke", "settings/cli-auth/approve", "settings/cli-auth/deny",
  ];
  for (const path of allSettingsRoutes) {
    const source = await readFile(route(path), "utf8");
    assert.match(source, /contractQuery\(/, `${path} must reject unknown and repeated query parameters`);
    assert.doesNotMatch(source, /\bpage\(req\)/, `${path} must not silently clamp query limits at the HTTP boundary`);
  }

  const retention = await readFile(route("storage/retention"), "utf8");
  assert.match(retention, /contractQuery\(new URL\(req\.url\)\.searchParams, StorageContracts\.retentionQuery\)/);
  assert.match(retention, /contractBody\(req, StorageContracts\.retentionRequest\)/);
  assert.match(retention, /contractOk\(StorageContracts\.retentionResponse/);

  const models = await readFile(route("models"), "utf8");
  assert.match(models, /contractQuery\(new URL\(req\.url\)\.searchParams, ModelsApi\.listQuery\)/);
  assert.doesNotMatch(models, /function page\(/);
});

test("Drizzle replay guard mirrors migration 0016 encrypted replay IV and tag lengths", async () => {
  const [schema, migration] = await Promise.all([readFile(databaseSource, "utf8"), readFile(replayMigration, "utf8")]);
  assert.match(schema, /octet_length\(\$\{t\.responseBodyIv\}\) = 12/);
  assert.match(schema, /octet_length\(\$\{t\.responseBodyTag\}\) = 16/);
  assert.match(migration, /octet_length\("response_body_iv"\) = 12/);
  assert.match(migration, /octet_length\("response_body_tag"\) = 16/);
});
