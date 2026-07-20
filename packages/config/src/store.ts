// In-memory SnapshotPublishStore — a portable fake for tests and the verify harness (§21).
// Real adapters (adapters-vercel Edge Config, adapters-cloudflare KV) implement the same
// SnapshotPublishStore surface.
import type { Snapshot } from "@manifold/ports";
import type { SnapshotPublishStore } from "./types.js";

interface Entry {
  revision: string;
  version: string;
  snapshot: Snapshot;
}

export class InMemorySnapshotStore implements SnapshotPublishStore {
  private byInstallation = new Map<string, Entry>();
  private counter = 0;

  async publish(
    installationId: string,
    revision: string,
    snap: Snapshot,
  ): Promise<{ version: string }> {
    this.counter += 1;
    const version = `v${this.counter}`;
    this.byInstallation.set(installationId, { revision, version, snapshot: snap });
    return { version };
  }

  async pointer(
    installationId: string,
  ): Promise<{ revision: string; version: string } | null> {
    const e = this.byInstallation.get(installationId);
    return e ? { revision: e.revision, version: e.version } : null;
  }

  async loadActive(installationId: string): Promise<Snapshot> {
    const e = this.byInstallation.get(installationId);
    if (!e) throw new Error(`no active snapshot for installation ${installationId}`);
    return e.snapshot;
  }
}
