import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  fetchWorkloadIdentityJwks,
  verifyWorkloadIdentityJwt,
} from "../lib/installation-auth.ts";
import { validateWorkloadIdentity } from "../app/api/v1/deployments/_lib.ts";

const now = new Date("2026-07-25T00:00:00.000Z");
const identity = {
  issuer: "https://issuer.example.com",
  jwksUrl: "https://issuer.example.com/keys",
  audience: "manifold-gateway",
  subject: "system:serviceaccount:gateway:prod",
};

function encoded(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function key(algorithm: "RS256" | "PS256" | "EdDSA", modulusLength = 2048) {
  const pair = algorithm === "EdDSA"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("rsa", { modulusLength });
  const jwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
  return { pair, jwk: { ...jwk, kid: `${algorithm}-${modulusLength}`, alg: algorithm, use: "sig", key_ops: ["verify"] } };
}
function token(
  algorithm: "RS256" | "PS256" | "EdDSA",
  material: ReturnType<typeof key>,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): string {
  const protectedHeader = encoded({ alg: algorithm, kid: material.jwk.kid, ...header });
  const payload = encoded({ iss: identity.issuer, aud: identity.audience, sub: identity.subject, exp: Math.floor(now.getTime() / 1000) + 300, jti: "a-valid-jti-value-with-sufficient-entropy", ...claims });
  const input = Buffer.from(`${protectedHeader}.${payload}`, "ascii");
  const signature = algorithm === "EdDSA"
    ? sign(null, input, material.pair.privateKey)
    : algorithm === "PS256"
      ? sign("RSA-SHA256", input, { key: material.pair.privateKey, padding: 6, saltLength: 32 })
      : sign("RSA-SHA256", input, material.pair.privateKey);
  return `${protectedHeader}.${payload}.${signature.toString("base64url")}`;
}
function fetcher(jwk: JsonWebKey) { return async () => ({ keys: [jwk] }); }
async function rejected(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => Array.isArray((error as { reasonCodes?: unknown }).reasonCodes) && (error as { reasonCodes: string[] }).reasonCodes.includes(reason));
}

for (const algorithm of ["RS256", "PS256", "EdDSA"] as const) {
  test(`accepts a valid ${algorithm} workload JWT`, async () => {
    const material = key(algorithm);
    const verified = await verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?alg=${algorithm}` }, token(algorithm, material), { now, jwksFetcher: fetcher(material.jwk) });
    assert.equal(verified.jti, "a-valid-jti-value-with-sufficient-entropy");
  });
}

test("pins issuer, audience, and subject claims", async () => {
  const material = key("RS256");
  for (const claims of [{ iss: "https://other.example.com" }, { aud: "other-audience" }, { sub: "other-subject" }]) {
    await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?claim=${Object.keys(claims)[0]}` }, token("RS256", material, claims), { now, jwksFetcher: fetcher(material.jwk) }), "AUTH_INSTALLATION_JWT_CLAIMS_INVALID");
  }
});

test("rejects malformed, none, algorithm-confused, wrong-key, weak-key, and invalid-time JWTs", async () => {
  const rsa = key("RS256");
  await rejected(verifyWorkloadIdentityJwt(identity, "not-a-jwt", { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_INVALID");
  const none = `${encoded({ alg: "none", kid: rsa.jwk.kid })}.${encoded({})}.x`;
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?none` }, none, { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_ALGORITHM_INVALID");
  const confused = token("RS256", rsa, {}, { alg: "HS256" });
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?confused` }, confused, { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_ALGORITHM_INVALID");
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?kid` }, token("RS256", rsa, {}, { kid: "unknown" }), { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_KEY_INVALID");
  const wrongSigner = key("RS256");
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?wrong-key` }, token("RS256", wrongSigner, {}, { kid: rsa.jwk.kid }), { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_SIGNATURE_INVALID");
  const weak = key("RS256", 1024);
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?weak` }, token("RS256", weak), { now, jwksFetcher: fetcher(weak.jwk) }), "AUTH_INSTALLATION_JWT_SIGNATURE_INVALID");
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?expired` }, token("RS256", rsa, { exp: Math.floor(now.getTime() / 1000) - 1 }), { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_TIME_INVALID");
  await rejected(verifyWorkloadIdentityJwt({ ...identity, jwksUrl: `${identity.jwksUrl}?nbf` }, token("RS256", rsa, { nbf: Math.floor(now.getTime() / 1000) + 301 }), { now, jwksFetcher: fetcher(rsa.jwk) }), "AUTH_INSTALLATION_JWT_TIME_INVALID");
});

test("rejects unsafe direct and resolved JWKS destinations, including mixed and IPv4-mapped answers", async () => {
  await rejected(fetchWorkloadIdentityJwks("https://127.0.0.1/keys"), "AUTH_INSTALLATION_JWKS_UNSAFE");
  await rejected(fetchWorkloadIdentityJwks("https://issuer.example.com/keys", { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }] }), "AUTH_INSTALLATION_JWKS_UNSAFE");
  await rejected(fetchWorkloadIdentityJwks("https://issuer.example.com/keys", { resolve: async () => [{ address: "64:ff9b::a9fe:a9fe", family: 6 }] }), "AUTH_INSTALLATION_JWKS_UNSAFE");
});

test("validates the complete workload-identity storage contract", () => {
  assert.deepEqual(validateWorkloadIdentity(identity), identity);
  for (const invalid of [
    { issuer: identity.issuer, jwksUrl: identity.jwksUrl, audience: identity.audience },
    { ...identity, issuer: "http://issuer.example.com" },
    { ...identity, jwksUrl: "https://127.0.0.1/keys" },
    { ...identity, subject: "" },
  ]) {
    assert.throws(() => validateWorkloadIdentity(invalid));
  }
});
