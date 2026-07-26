export interface RouteSummary {
  id: string;
  publicName: string;
  endpointKind: "chat" | "responses" | "embeddings" | string;
  activeRevisionId: string | null;
  installationId?: string;
  status: "staged" | "draft" | "disabled" | string;
  targetCount?: number;
  healthyTargetCount?: number;
  createdAt: string;
}

export interface RouteTarget {
  id: string;
  providerCredentialId: string;
  offeringId: string;
  provider: string;
  credentialLabel: string;
  credentialStatus: string;
  providerModelId: string;
  adapterRevision: string;
  baseUrl: string | null;
  deployment: Record<string, unknown> | null;
  region: string | null;
  weight: number;
  priority: number;
  healthState: string | null;
}

export interface RouteRevision {
  id: string;
  mode: "ordered" | "weighted";
  retryPolicy: Record<string, unknown>;
  timeoutPolicy: Record<string, unknown>;
  capturePolicy: Record<string, unknown> | null;
  contentHash: string;
  createdBy: string | null;
  createdAt: string;
  isActive: boolean;
  targets: RouteTarget[];
}

export interface RouteDetailResponse {
  id: string;
  installationId: string;
  installationName: string;
  publicName: string;
  endpointKind: string;
  activeRevisionId: string | null;
  status: "staged" | "draft" | "disabled";
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  revisions: RouteRevision[];
}

export interface Installation {
  id: string;
  name: string;
  edition: string;
  status: "active" | "disabled" | string;
}

export interface ProviderCredential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  status: string;
}

export interface Offering {
  id: string;
  provider: string;
  providerModelId: string;
  endpointKinds: unknown;
  canonicalModel: { slug: string; displayName: string };
  routable: boolean;
}

export interface PageResult<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ContextResponse {
  installations: Installation[];
}

export interface RouteTestProfile {
  id: string;
  hostname: string;
  mode: string;
  published: boolean;
  available: boolean;
}

export interface RouteTestResponse {
  routeId: string;
  installationId: string;
  profile: { id: string; hostname: string; mode: string };
  status: "completed" | "gateway_error";
  gatewayStatus: number;
  traceId: string | null;
  logsHref: string | null;
  responseTruncated: boolean;
}
