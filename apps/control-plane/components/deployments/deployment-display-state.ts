import type { ConfigAcceleratorStatus, InstallationLifecycle, SyntheticTestResult } from "./deployment-types";

export type InstallationDisplayState = "active" | "pending" | "disabled";
export type DiagnosticResultState = "unavailable" | "success" | "failure" | "stale" | "unknown";
export type ConfigOperationDisplayState = "success" | "failure" | "pending";

export interface HeartbeatEvidence {
  state?: "disabled" | "never_seen" | "connected" | "stale";
  heartbeatAgeSeconds?: number | null;
  freshnessThresholdSeconds?: number;
  now?: number;
}

export interface SyntheticTestCurrentState {
  activeConfigRevisionId: string | null;
  appliedConfigRevisionId: string | null;
  freshnessThresholdSeconds: number;
  now?: number;
}

export function hasSuccessfulHeartbeat(lastSeenAt: string | null): boolean {
  return lastSeenAt !== null && Number.isFinite(new Date(lastSeenAt).getTime());
}

export function installationDisplayState(
  status: InstallationLifecycle,
  lastSeenAt: string | null,
  evidence: HeartbeatEvidence = {},
): InstallationDisplayState {
  if (status === "disabled") return "disabled";
  if (evidence.state && evidence.state !== "connected") return "pending";
  if (!lastSeenAt || !hasSuccessfulHeartbeat(lastSeenAt)) return "pending";
  const threshold = evidence.freshnessThresholdSeconds ?? 600;
  const ageSeconds = evidence.heartbeatAgeSeconds ?? Math.max(
    0,
    Math.floor(((evidence.now ?? Date.now()) - new Date(lastSeenAt).getTime()) / 1000),
  );
  return ageSeconds <= threshold ? "active" : "pending";
}

export function installationDisplayLabel(state: InstallationDisplayState): string {
  if (state === "active") return "Active";
  if (state === "disabled") return "Disabled";
  return "Pending";
}

export function installationDisplayTone(state: InstallationDisplayState): "up" | "idle" | "down" {
  if (state === "active") return "up";
  if (state === "disabled") return "down";
  return "idle";
}

export function diagnosticResultState(
  available: boolean,
  lastResult: SyntheticTestResult | null,
  current: SyntheticTestCurrentState,
): DiagnosticResultState {
  if (!available) return "unavailable";
  if (lastResult?.detail.kind === "execution_failure") return "failure";
  if (!lastResult || lastResult.detail.kind !== "gateway_response") return "unknown";
  const gatewayStatus = lastResult.detail.gatewayStatus;
  if (typeof gatewayStatus !== "number") return "unknown";
  if (gatewayStatus >= 200 && gatewayStatus < 300) {
    const ageSeconds = Math.max(0, Math.floor(((current.now ?? Date.now()) - new Date(lastResult.createdAt).getTime()) / 1000));
    const currentProvenance = lastResult.detail.configRevisionId === current.activeConfigRevisionId &&
      lastResult.detail.appliedConfigRevisionId === current.appliedConfigRevisionId;
    if (!Number.isFinite(ageSeconds) || ageSeconds > current.freshnessThresholdSeconds || !currentProvenance) return "stale";
    return "success";
  }
  return "failure";
}

export function diagnosticResultLabel(state: DiagnosticResultState): string {
  if (state === "success") return "Passed";
  if (state === "failure") return "Failed";
  if (state === "stale") return "Stale";
  if (state === "unavailable") return "Unavailable";
  return "No result";
}

export function diagnosticResultTone(state: DiagnosticResultState): "up" | "idle" | "down" {
  if (state === "success") return "up";
  if (state === "failure") return "down";
  return "idle";
}

export function diagnosticResultDetail(result: SyntheticTestResult | null): string {
  if (!result) return "No synthetic test result has been returned.";
  if (result.detail.kind === "execution_failure") {
    return `Execution failed: ${result.detail.failureCode.replace("SYNTHETIC_", "").toLowerCase().replaceAll("_", " ")}.`;
  }
  const trace = result.detail.traceId ? ` Trace ${result.detail.traceId}.` : "";
  const truncated = result.detail.responseTruncated ? " Response details were truncated." : "";
  return `HTTP ${result.detail.gatewayStatus}.${trace}${truncated}`;
}

export function configOperationDisplayState(
  outcome: string,
  acceleratorStatus: ConfigAcceleratorStatus,
): ConfigOperationDisplayState {
  if (outcome === "failed" || outcome === "rejected" || acceleratorStatus === "reconciliation_required") {
    return "failure";
  }
  if (acceleratorStatus === "published" && outcome === "accepted") return "success";
  return "pending";
}

export function configOperationDisplayTone(state: ConfigOperationDisplayState): "up" | "idle" | "down" {
  if (state === "success") return "up";
  if (state === "failure") return "down";
  return "idle";
}
