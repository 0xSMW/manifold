// In-memory SnapshotPublishStore — a portable fake for tests and the verify harness (§21).
// Real adapters (adapters-vercel Edge Config, adapters-cloudflare KV) implement the same
// SnapshotPublishStore surface.
import type { Snapshot } from "@manifold/ports";
import type { SnapshotPublishStore } from "./types.js";

export interface VercelEdgeConfigStoreOptions {
  edgeConfigId: string;
  writeToken: string;
  teamId?: string;
  apiBaseUrl?: string;
}

function itemSuffix(installationId: string): string {
  return installationId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Durable optional accelerator backed by the Vercel Edge Config management API.
 * Postgres remains authoritative; this adapter mirrors a snapshot + pointer in one batch and
 * reports the store digest as the actual platform version.
 */
export class VercelEdgeConfigStore implements SnapshotPublishStore {
  constructor(private readonly options: VercelEdgeConfigStoreOptions) {}

  private managementUrl(path = ""): string {
    const base = this.options.apiBaseUrl ?? "https://api.vercel.com";
    const url = new URL(`/v1/edge-config/${this.options.edgeConfigId}${path}`, base);
    if (this.options.teamId) url.searchParams.set("teamId", this.options.teamId);
    return url.toString();
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(this.managementUrl(path), {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.writeToken}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new Error(`Edge Config publication failed: ${detail}`);
    }
    return body;
  }

  async publish(
    installationId: string,
    revision: string,
    snap: Snapshot,
  ): Promise<{ version: string }> {
    const suffix = itemSuffix(installationId);
    await this.request("/items", {
      method: "PATCH",
      body: JSON.stringify({
        items: [
          { operation: "upsert", key: `snapshot_${suffix}`, value: snap },
          { operation: "upsert", key: `active_${suffix}`, value: { revision } },
        ],
      }),
    });
    const metadata = (await this.request("")) as { digest?: unknown };
    if (typeof metadata.digest !== "string" || !metadata.digest) {
      throw new Error("Edge Config publication succeeded without a verifiable digest");
    }
    return { version: metadata.digest };
  }

  async pointer(
    installationId: string,
  ): Promise<{ revision: string; version: string } | null> {
    const suffix = itemSuffix(installationId);
    const [pointer, metadata] = await Promise.all([
      this.request(`/item/active_${suffix}`),
      this.request(""),
    ]);
    const revision =
      pointer && typeof pointer === "object" && "revision" in pointer
        ? (pointer as { revision: unknown }).revision
        : null;
    const version =
      metadata && typeof metadata === "object" && "digest" in metadata
        ? (metadata as { digest: unknown }).digest
        : null;
    return typeof revision === "string" && typeof version === "string"
      ? { revision, version }
      : null;
  }

  async loadActive(installationId: string): Promise<Snapshot> {
    const suffix = itemSuffix(installationId);
    return (await this.request(`/item/snapshot_${suffix}`)) as Snapshot;
  }
}

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
