export type InstallationEdition = "vercel" | "cloudflare" | "compose";
export type ProfileMode = "public_app" | "enterprise_egress";
export type NetworkExposure = "public" | "vpc" | "mtls";

export interface InstallationSummary {
  id: string;
  name: string;
  edition: InstallationEdition;
  appliedConfigRevision: string | null;
  lastSeenAt: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

export interface IngressProfile {
  id: string;
  installationId?: string;
  hostname: string;
  mode: ProfileMode;
  networkExposure: NetworkExposure;
  authConfig?: unknown;
  networkConfig?: unknown;
  policyRevisionId: string | null;
  defaultRouteSet: unknown;
  published: boolean;
  bindingStatus: "published" | "draft";
  available: boolean;
  status: "active" | "disabled";
  trustedHostInvariant: string;
  createdAt: string;
}

export interface InstallationDetail extends InstallationSummary {
  activeConfigRevision: string | null;
  trustedHostInvariant: string;
  profiles: IngressProfile[];
}

export interface ReadinessResponse {
  installationId: string;
  ready: boolean;
  checks: {
    connectivity: {
      ok: boolean;
      state: "disabled" | "never_seen" | "connected" | "stale";
      lastHeartbeatAt: string | null;
      heartbeatAgeSeconds: number | null;
      freshnessThresholdSeconds: number;
      reportingAvailable: boolean;
      limitation: string;
    };
    snapshotFreshness: {
      ok: boolean;
      appliedRevision: string | null;
      activeRevision: string | null;
      state: "not_published" | "current" | "revision_mismatch" | "not_reported";
    };
    providers: {
      ok: boolean;
      state: "not_applicable" | "valid" | "invalid";
      configuredCredentialCount: number;
      invalid: Array<{
        id: string;
        provider: string;
        label: string;
        status: string;
        lastValidatedAt: string | null;
      }>;
      missingCredentialIds: string[];
    };
    snapshotServing: {
      available: boolean;
      activeRevision: string | null;
      contentHash: string | null;
      builtAt: string | null;
      storedAt: string | null;
      reportedServingActive: boolean;
    };
    clockSkew: {
      available: boolean;
      skewSeconds: number | null;
      reason: string;
    };
    installationAuthentication: {
      ok: boolean;
      method: "ed25519" | "workload_identity";
      state: "configured" | "invalid_configuration";
      verifier: "ed25519_request_signature" | "oidc_jwks";
    };
  };
}

export interface DiagnosticsResponse {
  installationId: string;
  lastHeartbeat: {
    observedAt: string | null;
    appliedConfigRevision: string | null;
    installationStatus: "active" | "disabled";
    reportingAvailable: boolean;
    limitation: string;
  };
  recentConfigOperations: Array<{
    id: string;
    outcome: string;
    baseConfigHash: string | null;
    targetConfigHash: string | null;
    planHash: string | null;
    edgeConfigVersion: string | null;
    tripwireItems: unknown;
    error: unknown;
    createdAt: string;
  }>;
  syntheticTest: {
    available: boolean;
    lastResult: unknown;
    reason: string;
  };
}

export interface InstallationCreated extends InstallationSummary {
  installationIdentityPublicKey?: string;
  installationIdentityPrivateKey?: string;
  privateKeyShownOnce?: boolean;
}

export interface ProfileCreated {
  id: string;
  installationId: string;
  hostname: string;
  mode: ProfileMode;
  networkExposure: NetworkExposure;
  status: "draft";
  published: false;
  trustedHostInvariant: string;
}
