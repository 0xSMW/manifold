// Snapshot signing config + the publish store singleton (SPEC §7.3, §8.2).
//
// The control plane holds the ed25519 snapshot-signing private key
// (MANIFOLD_SNAPSHOT_SIGNING_KEY, base64 32-byte seed); the gateway pins only the public half
// (MANIFOLD_SNAPSHOT_PUBLIC_KEY). buildSnapshot → signSnapshot stamps meta.signature over the
// content hash; verifySnapshot (used by a real loader / our verify harness) accepts it.
//
// The DB (gateway_config_revision) is the source of truth for the active snapshot; the store is
// its cache (§8.2). We keep an in-process InMemorySnapshotStore so `apply` gets an edge version
// handle; /config/active reads the signed bytes from the DB, not the store.
import {
  InMemorySnapshotStore,
  signSnapshot as signSnapshotImpl,
  type ConfigSnapshot,
} from "@manifold/config";
import { ManifoldError } from "@/lib/http";

let store: InMemorySnapshotStore | null = null;

export function snapshotStore(): InMemorySnapshotStore {
  if (!store) store = new InMemorySnapshotStore();
  return store;
}

function signingKey(): string {
  const key = process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY;
  if (!key) {
    throw new ManifoldError({
      status: 500,
      code: "INTERNAL",
      message: "MANIFOLD_SNAPSHOT_SIGNING_KEY is not configured",
      reasonCodes: [],
    });
  }
  return key;
}

/** Sign a freshly-built snapshot with the configured ed25519 key (§7.3). */
export function signSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return signSnapshotImpl(
    snapshot,
    signingKey(),
    process.env.MANIFOLD_SNAPSHOT_SIGNING_KEY_ID,
  );
}
