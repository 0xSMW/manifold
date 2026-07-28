export type InstallationEdition = "vercel" | "cloudflare" | "compose";
export type InstallationLifecycle = "active" | "disabled";
export type ConfigAcceleratorStatus = "not_configured" | "pending" | "published" | "reconciliation_required" | "superseded";
export type ProfileMode = "public_app" | "enterprise_egress";
export type NetworkExposure = "public" | "vpc" | "mtls";

export interface InstallationSummary {
  id: string;
  name: string;
  edition: InstallationEdition;
  appliedConfigRevision: string | null;
  lastSeenAt: string | null;
  /** Backend lifecycle. Display state also requires a returned heartbeat. */
  status: InstallationLifecycle;
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
    operationKind: string;
    servingMode: string;
    acceleratorStatus: ConfigAcceleratorStatus;
    baseConfigHash: string | null;
    targetConfigHash: string | null;
    planHash: string | null;
    edgeConfigVersion: string | null;
    tripwireItems: unknown;
    error: unknown;
    reconciliationAttempts: number;
    lastReconcileAt: string | null;
    completedAt: string | null;
    createdAt: string;
  }>;
  syntheticTest: {
    available: boolean;
    lastResult: SyntheticTestResult | null;
    activeConfigRevisionId: string | null;
    appliedConfigRevisionId: string | null;
    freshnessThresholdSeconds: number;
    reason: string;
  };
}

export interface SyntheticTestResult {
  id: string;
  createdAt: string;
  detail: SyntheticTestDetail;
}

export type SyntheticTestDetail =
  | {
      kind: "gateway_response";
      installationId: string;
      profileId: string;
      endpointKind: "chat" | "responses" | "embeddings";
      configRevisionId: string | null;
      appliedConfigRevisionId: string | null;
      gatewayStatus: number;
      traceId: string | null;
      responseTruncated: boolean;
    }
  | {
      kind: "execution_failure";
      installationId: string;
      profileId: string;
      endpointKind: "chat" | "responses" | "embeddings";
      configRevisionId: string | null;
      appliedConfigRevisionId: string | null;
      failureCode: "SYNTHETIC_NOT_CONFIGURED" | "SYNTHETIC_POLICY" | "SYNTHETIC_DNS" | "SYNTHETIC_TIMEOUT" | "SYNTHETIC_NETWORK" | "SYNTHETIC_EXECUTION_FAILED";
      retryable: boolean;
    };

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
