import { ControlEgressError, executeControlEgress, type ControlEgressDependencies, type ControlEgressRequest } from "./control-egress.ts";

const PROVIDER_DEFAULTS: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
  together: "https://api.together.xyz",
};

const OPENAI_COMPATIBLE = new Set([
  "openai",
  "openai-compatible",
  "groq",
  "mistral",
  "together",
]);

export type ProviderValidationClassification =
  | "PROVIDER_VALID"
  | "PROVIDER_UNSUPPORTED"
  | "PROVIDER_HTTP_AUTH"
  | "PROVIDER_HTTP_RATE_LIMIT"
  | "PROVIDER_HTTP_CLIENT"
  | "PROVIDER_HTTP_SERVER"
  | "PROVIDER_EGRESS_POLICY"
  | "PROVIDER_DNS"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK"
  | "PROVIDER_RESPONSE_TRUNCATED";

export interface ProviderValidationInput {
  provider: string;
  secret: string;
  baseUrl: string | null;
  allowedHosts: readonly string[];
}

export interface ProviderValidationResult {
  outcome: "valid" | "invalid" | "unsupported";
  classification: ProviderValidationClassification;
  upstreamStatus: number | null;
  message: string;
  responseTruncated: boolean;
}

export function defaultProviderBaseUrl(provider: string): string | null {
  return PROVIDER_DEFAULTS[provider.trim().toLowerCase()] ?? null;
}

export function defaultProviderAllowedHosts(provider: string): string[] {
  const baseUrl = defaultProviderBaseUrl(provider);
  return baseUrl ? [new URL(baseUrl).hostname] : [];
}

function appendPath(baseUrl: string, suffix: string): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const normalizedSuffix = suffix.replace(/^\/+/, "");
  url.pathname = `${basePath}/${normalizedSuffix}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  return url;
}

function openAiModelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  // A configured compatible base URL is the provider's API root.  OpenAI's
  // default root is the sole case that needs the conventional /v1 prefix;
  // compatibility roots can be nested (for example Gemini's
  // /v1beta/openai/) and must retain that path unchanged.
  return appendPath(baseUrl, path ? "models" : "v1/models");
}

function googleModelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return appendPath(baseUrl, /\/v1(?:beta)?$/.test(path) ? "models" : "v1beta/models");
}

function azureModelsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const result = appendPath(baseUrl, path.endsWith("/openai") ? "models" : "openai/models");
  result.searchParams.set("api-version", "2024-10-21");
  return result;
}

/**
 * Build a non-mutating provider probe. It is pure so request shapes can be tested without egress.
 * Bedrock is deliberately unsupported: the credential schema stores one opaque secret and no
 * structured AWS access-key/session-token/region tuple, so a correctly signed AWS probe cannot be
 * constructed without guessing.
 */
export function buildProviderValidationRequest(
  input: ProviderValidationInput,
): { request: ControlEgressRequest; unsupportedReason?: never } | {
  request?: never;
  unsupportedReason: string;
} {
  const provider = input.provider.trim().toLowerCase();
  const baseUrl = input.baseUrl ?? defaultProviderBaseUrl(provider);
  if (!baseUrl) {
    if (provider === "bedrock" || provider === "amazon-bedrock") {
      return {
        unsupportedReason:
          "Bedrock validation requires structured AWS credentials and a region, which this credential does not provide",
      };
    }
    return {
      unsupportedReason:
        "This provider has no built-in validation endpoint; configure a supported provider type",
    };
  }

  if (OPENAI_COMPATIBLE.has(provider)) {
    return {
      request: {
        url: openAiModelsUrl(baseUrl).toString(),
        allowedHosts: input.allowedHosts,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.secret}`,
        },
      },
    };
  }
  if (provider === "anthropic") {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return {
      request: {
        url: appendPath(baseUrl, path.endsWith("/v1") ? "models" : "v1/models").toString(),
        allowedHosts: input.allowedHosts,
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": input.secret,
        },
      },
    };
  }
  if (provider === "google") {
    return {
      request: {
        url: googleModelsUrl(baseUrl).toString(),
        allowedHosts: input.allowedHosts,
        headers: {
          accept: "application/json",
          "x-goog-api-key": input.secret,
        },
      },
    };
  }
  if (provider === "azure" || provider === "azure-openai") {
    return {
      request: {
        url: azureModelsUrl(baseUrl).toString(),
        allowedHosts: input.allowedHosts,
        headers: {
          accept: "application/json",
          "api-key": input.secret,
        },
      },
    };
  }

  return {
    unsupportedReason: "This provider does not have a safe built-in validation request",
  };
}

function classificationForStatus(status: number): ProviderValidationClassification {
  if (status === 401 || status === 403) return "PROVIDER_HTTP_AUTH";
  if (status === 429) return "PROVIDER_HTTP_RATE_LIMIT";
  if (status >= 500) return "PROVIDER_HTTP_SERVER";
  return "PROVIDER_HTTP_CLIENT";
}

function safeUpstreamMessage(body: Uint8Array, secret: string, fallback: string): string {
  const raw = new TextDecoder().decode(body);
  let candidate = "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const nested =
        record.error && typeof record.error === "object"
          ? (record.error as Record<string, unknown>)
          : null;
      const value = nested?.message ?? record.message ?? record.error_description;
      if (typeof value === "string") candidate = value;
    }
  } catch {
    // Some providers return a plain-text error. Preserve that upstream message while applying the
    // same exact-secret redaction and output bound used for JSON messages.
    if (raw.trim()) candidate = raw;
  }
  if (!candidate) return fallback;
  const redacted = secret ? candidate.split(secret).join("[REDACTED]") : candidate;
  return redacted.slice(0, 500);
}

function egressClassification(error: ControlEgressError): ProviderValidationClassification {
  switch (error.code) {
    case "EGRESS_POLICY":
    case "EGRESS_REDIRECT":
      return "PROVIDER_EGRESS_POLICY";
    case "EGRESS_DNS":
      return "PROVIDER_DNS";
    case "EGRESS_TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "EGRESS_NETWORK":
      return "PROVIDER_NETWORK";
  }
}

export async function validateProviderCredential(
  input: ProviderValidationInput,
  dependencies: ControlEgressDependencies = {},
): Promise<ProviderValidationResult> {
  const built = buildProviderValidationRequest(input);
  if (!built.request) {
    return {
      outcome: "unsupported",
      classification: "PROVIDER_UNSUPPORTED",
      upstreamStatus: null,
      message: built.unsupportedReason,
      responseTruncated: false,
    };
  }

  try {
    const response = await executeControlEgress(built.request, dependencies);
    if (response.status >= 200 && response.status < 300) {
      return {
        outcome: "valid",
        classification: response.truncated
          ? "PROVIDER_RESPONSE_TRUNCATED"
          : "PROVIDER_VALID",
        upstreamStatus: response.status,
        message: "Provider credential validated",
        responseTruncated: response.truncated,
      };
    }
    return {
      outcome: "invalid",
      classification: classificationForStatus(response.status),
      upstreamStatus: response.status,
      message: safeUpstreamMessage(
        response.body,
        input.secret,
        `Provider returned HTTP ${response.status}`,
      ),
      responseTruncated: response.truncated,
    };
  } catch (error) {
    if (!(error instanceof ControlEgressError)) throw error;
    return {
      outcome: "invalid",
      classification: egressClassification(error),
      upstreamStatus: null,
      message: error.message,
      responseTruncated: false,
    };
  }
}
