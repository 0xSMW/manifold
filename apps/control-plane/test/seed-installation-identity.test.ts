import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSeedInstallationIdentity } from "../lib/seed-installation-identity.ts";
import { canonicalHostname } from "../app/api/v1/deployments/_lib.ts";

test("seed installation identity stores an SPKI public key that verifies the returned PKCS#8 private key", () => {
  const identity = generateSeedInstallationIdentity();
  const message = Buffer.from("seed installation identity proof");
  const signature = sign(null, message, createPrivateKey({ key: Buffer.from(identity.privateKeyBase64, "base64"), format: "der", type: "pkcs8" }));
  assert.equal(verify(null, message, createPublicKey({ key: identity.publicKey, format: "der", type: "spki" }), signature), true);
  assert.equal(identity.publicKeyBase64, identity.publicKey.toString("base64"));
});

test("seed route persists only the generated public key and returns the private key once", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/api/v1/admin/seed/route.ts"), "utf8");
  assert.match(source, /\$\{installationIdentity\.publicKey\}/);
  assert.match(source, /MANIFOLD_INSTALLATION_PRIVATE_KEY: result\.installationIdentity\.privateKeyBase64/);
  assert.match(source, /status: "already_seeded"/);
  assert.match(source, /MANIFOLD_INSTALLATION_PRIVATE_KEY: null/);
  assert.doesNotMatch(source, /PLACEHOLDER_INSTALLATION_PUBLIC_KEY/);
  assert.doesNotMatch(source, /gateway\.local/);
});

test("seed replay returns durable identifiers before requiring new hostname configuration", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/api/v1/admin/seed/route.ts"), "utf8");
  const replayLookup = source.indexOf("const prior = await existingSeed(sql, slug)");
  const replayReturn = source.indexOf('if (prior) return { kind: "existing" as const, prior }');
  const newHostname = source.indexOf("const hostname = configuredHostname(slug, body.hostname)");
  assert.ok(replayLookup >= 0 && replayReturn > replayLookup && newHostname > replayReturn,
    "an existing workspace replays before hostname input or MANIFOLD_SEED_GATEWAY_DOMAIN is required");
  assert.match(source, /MANIFOLD_SEED_DB_URL is required for safe bootstrap replay and catalog seeding/);
  assert.doesNotMatch(source, /adminDb\(\)\?\.\$client/);
});

test("seed rejects a second workspace slug with a bounded bootstrap conflict", () => {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/api/v1/admin/seed/route.ts"), "utf8");
  assert.match(source, /withSeedBootstrapLock/);
  assert.match(source, /database is already bootstrapped for a different workspace/);
  assert.match(source, /reasonCodes: \["BOOTSTRAP_WORKSPACE_EXISTS"\]/);
  assert.match(source, /status: 409/);
});

test("seed route validates explicit hostnames and requires an explicit configured fallback", () => {
  assert.equal(canonicalHostname("Gateway.Example.Test."), "gateway.example.test");
  assert.throws(() => canonicalHostname("https://gateway.example.test"));
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/api/v1/admin/seed/route.ts"), "utf8");
  assert.match(source, /requireDeployableHostname\(requested\)/);
  assert.match(source, /MANIFOLD_SEED_GATEWAY_DOMAIN/);
  assert.match(source, /hostname\.endsWith\("\.local"\)/);
  assert.match(source, /requireDeployableHostname\(`\$\{slug\}\.\$\{requireDeployableHostname\(domain\)\}`\)/);
});
