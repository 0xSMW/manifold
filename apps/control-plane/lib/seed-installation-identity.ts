import { generateKeyPairSync } from "node:crypto";

/**
 * Gateway bootstrap identity in the exact DER formats consumed by the gateway runtime:
 * SPKI public key in PostgreSQL and base64 PKCS#8 private key in
 * MANIFOLD_INSTALLATION_PRIVATE_KEY. The caller must return the private half only once.
 */
export function generateSeedInstallationIdentity(): {
  publicKey: Buffer;
  publicKeyBase64: string;
  privateKeyBase64: string;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey,
    publicKeyBase64: publicKey.toString("base64"),
    privateKeyBase64: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}
