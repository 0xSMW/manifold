// Adversarial tests for snapshot signature verification on load (SPEC §7.3, ADR-0024).
// A forged MANIFOLD_SNAPSHOT (rewritten routes/keys/baseUrl/ciphertext) must be REJECTED when a
// public key is pinned. Fixtures are signed with @manifold/config's REAL ed25519 signer, proving
// the gateway's DB-free verifier is byte-for-byte compatible with config's canonicalization.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The TEST may pull in @manifold/config to sign fixtures with the exact key material + algorithm
// the control plane uses. The gateway RUNTIME never imports this (it would pull the DB); only this
// test does, to prove a config-signed snapshot verifies in the gateway's DB-free verifier.
import { computeContentHash, generateSigningKeyPair, signSnapshot } from "@manifold/config";
import type { Snapshot } from "@manifold/ports";
import { SnapshotFileStore } from "../src/adapters.ts";
import { verifySnapshot } from "../src/snapshotVerify.ts";

const tmp = mkdtempSync(join(tmpdir(), "manifold-snap-"));

/** A realistic §7 snapshot body (ports.Snapshot + config's offerings/policies sections). */
function baseSnapshot(): Snapshot {
  return {
    meta: {
      schema: "manifold.snapshot.v1",
      installationId: "local-dev",
      revision: "rev_1",
      contentHash: "sha256:unset",
      builtAt: "2026-07-20T00:00:00.000Z",
      signature: "",
      signingKeyId: "unset",
    },
    profiles: {
      localhost: { id: "public_app", mode: "public_app", policyRevision: null, defaultRouteSet: null },
    },
    keys: {
      abcdef: { id: "vk", profileId: "public_app", scopes: [], allowedAppIds: [], budgetAccountId: null, expiresAt: null, revoked: false },
    },
    routes: {
      "public_app:/v1/messages": {
        routeId: "rt", revision: "rev_1", mode: "ordered", timeoutMs: 60000, capturePolicyId: "cap_none",
        targets: [{
          offeringId: "anthropic.messages", credentialId: "cred", dekId: "dek",
          credentialCiphertext: "", wrappedDek: "", weight: 1, priority: 0,
          baseUrl: "https://api.anthropic.com", region: null, allowedHosts: ["api.anthropic.com"],
          authInject: { headers: { "x-api-key": "${secret}" } }, secretEnv: "ANTHROPIC_API_KEY",
        }],
      },
    },
    // config's ConfigSnapshot carries these two extra §7 sections (part of the canonical body).
    offerings: {},
    policies: {},
  } as unknown as Snapshot;
}

function writeSnap(name: string, snap: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(snap));
  return path;
}

// A fresh signing keypair (the same ed25519 material/algorithm the control plane uses).
const { privateKeyBase64, publicKeyBase64, signingKeyId } = generateSigningKeyPair();

test("§7.3: a validly config-signed snapshot LOADS under the pinned public key", async () => {
  const signed = signSnapshot(baseSnapshot() as never, privateKeyBase64, signingKeyId);
  // Cross-check: the gateway's DB-free verifier accepts a config-signed snapshot (byte-for-byte).
  assert.equal(verifySnapshot(signed as unknown as Snapshot, publicKeyBase64).ok, true);

  const path = writeSnap("valid.json", signed);
  const store = new SnapshotFileStore(path, publicKeyBase64); // must not throw
  const loaded = await store.loadActive("local-dev");
  assert.equal(loaded.routes["public_app:/v1/messages"]!.targets[0]!.baseUrl, "https://api.anthropic.com");
});

test("§7.3 FAIL CLOSED: a snapshot whose body was tampered AFTER signing is REJECTED", async () => {
  const signed = signSnapshot(baseSnapshot() as never, privateKeyBase64, signingKeyId) as unknown as Snapshot;
  // Attacker rewrites the upstream baseUrl to exfiltrate traffic — signature/contentHash untouched.
  const forged = JSON.parse(JSON.stringify(signed)) as Snapshot;
  forged.routes["public_app:/v1/messages"]!.targets[0]!.baseUrl = "https://evil.example.com";
  const path = writeSnap("tampered-hash.json", forged);
  assert.throws(() => new SnapshotFileStore(path, publicKeyBase64), /content_hash_mismatch/);
});

test("§7.3 FAIL CLOSED: a body-tamper WITH a recomputed contentHash still fails (bad signature)", async () => {
  const signed = signSnapshot(baseSnapshot() as never, privateKeyBase64, signingKeyId) as unknown as Snapshot;
  const forged = JSON.parse(JSON.stringify(signed)) as Snapshot;
  forged.routes["public_app:/v1/messages"]!.targets[0]!.baseUrl = "https://evil.example.com";
  // Forger knows the hash algorithm and refreshes meta.contentHash — but cannot forge the ed25519
  // signature without the private key.
  forged.meta.contentHash = computeContentHash(forged as never);
  const path = writeSnap("tampered-sig.json", forged);
  assert.throws(() => new SnapshotFileStore(path, publicKeyBase64), /bad_signature/);
});

test("§7.3: a snapshot signed by a DIFFERENT key is REJECTED under the pinned key", async () => {
  const other = generateSigningKeyPair();
  const signed = signSnapshot(baseSnapshot() as never, other.privateKeyBase64, other.signingKeyId);
  const path = writeSnap("wrong-key.json", signed);
  assert.throws(() => new SnapshotFileStore(path, publicKeyBase64), /bad_signature/);
});

test("DEV escape hatch: no pinned key ⇒ unsigned snapshot loads (with a loud warning)", async () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  try {
    const path = writeSnap("unsigned.json", baseSnapshot());
    const store = new SnapshotFileStore(path); // no pinned key → allowed
    await store.loadActive("local-dev");
  } finally {
    console.warn = orig;
  }
  assert.ok(warnings.some((w) => w.includes("MANIFOLD_SNAPSHOT_PUBLIC_KEY")), "must warn loudly when unverified");
});
