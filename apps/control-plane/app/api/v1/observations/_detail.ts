const CAPTURE_MODES = ["none", "metadata", "redacted", "full"] as const;
type CaptureMode = (typeof CAPTURE_MODES)[number];

export interface CapturePolicyView {
  name: string;
  source: "route_revision" | "app" | "data_handling";
  mode: CaptureMode;
  max_bytes: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mode(value: unknown): CaptureMode | null {
  return typeof value === "string" && CAPTURE_MODES.includes(value as CaptureMode)
    ? (value as CaptureMode)
    : null;
}

function boundedPositiveInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      return Math.min(value, 1_048_576);
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) return Math.min(parsed, 1_048_576);
    }
  }
  return null;
}

export function capturePolicyView(input: {
  routePolicy: unknown;
  appPolicy: unknown;
  routeRevisionId: string | null;
  appSlug: string | null;
  dataHandlingMode: string | null;
  policyName: string | null;
}): CapturePolicyView {
  const route = object(input.routePolicy);
  const app = object(input.appPolicy);
  const selected = route ?? app ?? {};
  const selectedMode =
    mode(selected.mode) ??
    mode(selected.capture_mode) ??
    mode(selected.captureMode) ??
    "none";
  const handlingMode = mode(input.dataHandlingMode);
  const effectiveMode =
    handlingMode && CAPTURE_MODES.indexOf(handlingMode) < CAPTURE_MODES.indexOf(selectedMode)
      ? handlingMode
      : selectedMode;
  const maxBytes =
    boundedPositiveInteger(
      selected.max_bytes,
      selected.maxBytes,
      selected.byte_cap,
      selected.byteCap,
      selected.limit_bytes,
    ) ?? 0;
  const explicitName =
    typeof selected.name === "string" && selected.name.trim()
      ? selected.name.trim()
      : typeof selected.id === "string" && selected.id.trim()
        ? selected.id.trim()
        : null;
  const source = route ? "route_revision" : app ? "app" : "data_handling";
  return {
    name:
      explicitName ??
      input.policyName ??
      (route
        ? input.routeRevisionId ?? "route capture policy"
        : app
          ? input.appSlug ?? "app capture policy"
          : "no capture policy"),
    source,
    mode: effectiveMode,
    max_bytes: effectiveMode === "none" || effectiveMode === "metadata" ? 0 : maxBytes,
  };
}

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function captureView(
  captureRef: unknown,
  policy: CapturePolicyView,
  scopeAllowed: boolean,
): Record<string, unknown> {
  const capture = object(captureRef);
  const storedBytes = capture
    ? numberField(capture.bytes)
    : null;
  const metadata = {
    present: capture !== null,
    stored_bytes: storedBytes,
    truncated: capture?.truncated === true,
    redacted: capture?.redacted === true,
    sampled_out:
      capture?.sampled_out === true ||
      capture?.sampledOut === true ||
      capture?.reason === "STORAGE_SHED_SAMPLED",
  };
  const policyAllowsPayload =
    (policy.mode === "redacted" || policy.mode === "full") && policy.max_bytes > 0;
  if (!capture || !scopeAllowed || !policyAllowsPayload) {
    return {
      policy,
      metadata,
      payload: null,
      visibility:
        !scopeAllowed && capture
          ? "scope_required"
          : policyAllowsPayload
            ? "not_captured"
            : "policy_disallows_payload",
    };
  }

  if (capture.truncated === true) {
    return { policy, metadata, payload: null, visibility: "bounded_out" };
  }

  const payload = {
    request: capture.request ?? null,
    response: capture.response ?? null,
  };
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes > policy.max_bytes) {
    return {
      policy,
      metadata: { ...metadata, response_bound_exceeded: true },
      payload: null,
      visibility: "bounded_out",
    };
  }
  return { policy, metadata, payload, visibility: "visible" };
}

const TOKEN_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "reasoningTokens",
  "cacheWriteTokens",
  "audioInputTokens",
  "audioOutputTokens",
] as const;

function safeTokens(value: unknown): Record<string, string> | null {
  const candidate = object(value);
  if (!candidate) return null;
  const result: Record<string, string> = {};
  for (const key of TOKEN_KEYS) {
    const token = candidate[key];
    if (
      (typeof token === "number" && Number.isSafeInteger(token) && token >= 0) ||
      (typeof token === "string" && /^\d+$/.test(token))
    ) {
      result[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = String(token);
    }
  }
  return Object.keys(result).length ? result : null;
}

export function safeSpanPayload(kind: string, value: unknown): Record<string, unknown> {
  const payload = object(value) ?? {};
  if (kind === "provider_attempt") {
    return {
      provider: typeof payload.provider === "string" ? payload.provider : null,
      offering_id: typeof payload.offeringId === "string" ? payload.offeringId : null,
      outcome: typeof payload.outcome === "string" ? payload.outcome : null,
      http_status: typeof payload.httpStatus === "number" ? payload.httpStatus : null,
      reason_codes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes.map(String) : [],
      usage: safeTokens(payload.tokens),
    };
  }
  if (kind === "terminal") {
    return {
      status: typeof payload.status === "string" ? payload.status : null,
      http_status: typeof payload.httpStatus === "number" ? payload.httpStatus : null,
      final_provider:
        typeof payload.finalProvider === "string" ? payload.finalProvider : null,
      final_offering_id:
        typeof payload.finalOfferingId === "string" ? payload.finalOfferingId : null,
      cost_fidelity:
        typeof payload.costFidelity === "string" ? payload.costFidelity : "unknown",
      reason_codes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes.map(String) : [],
      usage: safeTokens(payload.tokens),
    };
  }
  if (kind === "accepted") {
    return {
      route_id: typeof payload.routeId === "string" ? payload.routeId : null,
      route_revision_id:
        typeof payload.routeRevisionId === "string" ? payload.routeRevisionId : null,
      endpoint_kind: typeof payload.endpointKind === "string" ? payload.endpointKind : null,
      public_name: typeof payload.publicName === "string" ? payload.publicName : null,
    };
  }
  return {};
}
