"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { ConfirmDialog, Sheet } from "@/components/ui/overlay";
import { StatusBadge, StatusDot, type Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import type {
  DiagnosticsResponse,
  IngressProfile,
  InstallationDetail,
  ProfileCreated,
  ReadinessResponse,
} from "./deployment-types";
import {
  emptyProfileDraft,
  ProfileFields,
  profileDraftComplete,
  profileRequest,
  type ProfileDraft,
} from "./profile-fields";
import {
  diagnosticResultDetail,
  diagnosticResultLabel,
  diagnosticResultState,
  diagnosticResultTone,
  configOperationDisplayState,
  configOperationDisplayTone,
  installationDisplayLabel,
  installationDisplayState,
} from "./deployment-display-state";
import styles from "./deployments.module.css";

function message(error: unknown): string {
  if (error instanceof ControlPlaneApiError) return error.payload.message;
  return error instanceof Error ? error.message : "Unable to load gateway";
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function checkTone(ok: boolean, available = true): Status {
  if (!available) return "idle";
  return ok ? "up" : "down";
}

export function DeploymentDetail({ installationId }: { installationId: string }) {
  const toast = useToast();
  const [installation, setInstallation] = useState<InstallationDetail | null | undefined>(undefined);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [disableInstallationOpen, setDisableInstallationOpen] = useState(false);
  const [disableProfile, setDisableProfile] = useState<IngressProfile | null>(null);
  const [mutating, setMutating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setReadiness(null);
    setDiagnostics(null);
    const detailRequest = apiRequest<InstallationDetail>(`/deployments/${installationId}`);
    const readinessRequest = apiRequest<ReadinessResponse>(`/deployments/${installationId}/readiness`);
    const diagnosticsRequest = apiRequest<DiagnosticsResponse>(`/deployments/${installationId}/diagnostics`);
    try {
      const detail = await detailRequest;
      setInstallation(detail);
    } catch (caught) {
      setInstallation(null);
      setError(message(caught));
      return;
    }
    const [readinessResult, diagnosticResult] = await Promise.allSettled([
      readinessRequest,
      diagnosticsRequest,
    ]);
    const failures: string[] = [];
    if (readinessResult.status === "fulfilled") {
      setReadiness(readinessResult.value);
    } else {
      failures.push(`Readiness could not load: ${message(readinessResult.reason)}`);
    }
    if (diagnosticResult.status === "fulfilled") {
      setDiagnostics(diagnosticResult.value);
    } else {
      failures.push(`Diagnostics could not load: ${message(diagnosticResult.reason)}`);
    }
    if (failures.length) setError(failures.join(" "));
  }, [installationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const disableInstallation = async () => {
    setMutating(true);
    try {
      await apiRequest(`/installations/${installationId}/disable`, { method: "POST" });
      setDisableInstallationOpen(false);
      toast("Gateway disabled", "down");
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setMutating(false);
    }
  };

  const disableSelectedProfile = async () => {
    if (!disableProfile) return;
    setMutating(true);
    try {
      await apiRequest(`/profiles/${disableProfile.id}/disable`, { method: "POST" });
      setDisableProfile(null);
      toast("Trusted host disabled as a staged change", "verifying");
      await load();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setMutating(false);
    }
  };

  if (installation === undefined) {
    return (
      <PageFrame description="Loading gateway state and diagnostics" title="Deployment">
        <div className={styles.stack}>
          <Skeleton style={{ height: 92 }} />
          <Skeleton style={{ height: 260 }} />
        </div>
      </PageFrame>
    );
  }

  if (!installation) {
    return (
      <PageFrame description="Gateway details" title="Deployment">
        {error ? (
          <AlertBanner title="Gateway could not load" tone="down">
            {error} <Button onClick={() => void load()} variant="outline">Retry</Button>
          </AlertBanner>
        ) : (
          <EmptyState
            action={<Button onClick={() => window.location.assign("/deployments")}>Back to deployments</Button>}
            description="The gateway may be outside this workspace."
            title="Gateway not found"
          />
        )}
      </PageFrame>
    );
  }

  return (
    <PageFrame
      actions={(
        <>
          <Button onClick={() => setProfileOpen(true)} variant="primary">Bind trusted host</Button>
          {installation.status === "active" ? (
            <Button onClick={() => setDisableInstallationOpen(true)} variant="danger-outline">
              Disable gateway
            </Button>
          ) : null}
        </>
      )}
      description="Trusted hosts, serving readiness, and recent configuration activity"
      title={installation.name}
    >
      <div className={styles.stack}>
        <div className={styles.notice}>
          <strong>Trusted host boundary</strong>
          <p>{installation.trustedHostInvariant}</p>
        </div>
        {error ? <AlertBanner title="Gateway update failed" tone="down">{error}</AlertBanner> : null}
        <Card className={styles.panel}>
          <dl className={styles.facts}>
            <Fact label="Edition" value={humanize(installation.edition)} />
            <Fact
              label="Lifecycle"
              value={installationDisplayLabel(installationDisplayState(
                installation.status,
                installation.lastSeenAt,
                readiness?.checks.connectivity,
              ))}
            />
            <Fact label="Last heartbeat" value={formatDate(installation.lastSeenAt)} />
          </dl>
        </Card>
        <div className={styles.detailGrid}>
          <ReadinessPanel readiness={readiness} />
          <DiagnosticsPanel diagnostics={diagnostics} />
        </div>
        <ProfilesPanel
          installation={installation}
          onAdd={() => setProfileOpen(true)}
          onDisable={setDisableProfile}
        />
      </div>
      <AddProfileSheet
        installationId={installation.id}
        onClose={() => setProfileOpen(false)}
        onCreated={(profile) => {
          setProfileOpen(false);
          toast("Trusted host saved as a draft", "verifying");
          if (profile.mode === "enterprise_egress") {
            window.location.reload();
            return;
          }
          void load();
        }}
        open={profileOpen}
      />
      <ConfirmDialog
        confirmLabel={mutating ? "Disabling gateway" : "Disable gateway"}
        confirmText={installation.name}
        description="This stops the gateway and every trusted host attached to it. Existing records remain available."
        onClose={() => setDisableInstallationOpen(false)}
        onConfirm={() => void disableInstallation()}
        open={disableInstallationOpen}
        title="Disable gateway"
      />
      <ConfirmDialog
        confirmLabel={mutating ? "Disabling host" : "Disable trusted host"}
        description="This stages the host binding for removal. Publish the change before relying on it at the gateway."
        onClose={() => setDisableProfile(null)}
        onConfirm={() => void disableSelectedProfile()}
        open={Boolean(disableProfile)}
        title="Disable trusted host"
      />
    </PageFrame>
  );
}

function ReadinessPanel({ readiness }: { readiness: ReadinessResponse | null }) {
  if (!readiness) {
    return (
      <Card className={styles.panel}>
        <div className={styles.panelHeader}><h2>Readiness</h2></div>
        <Skeleton style={{ height: 220 }} />
      </Card>
    );
  }
  const { checks } = readiness;
  const clockSkewAvailable = checks.clockSkew.available;
  const clockSkewMeasured = typeof checks.clockSkew.skewSeconds === "number" &&
    Number.isFinite(checks.clockSkew.skewSeconds);
  const providerDetail = checks.providers.state === "not_applicable"
    ? "No provider credentials are referenced by the active snapshot."
    : checks.providers.ok
      ? `${checks.providers.configuredCredentialCount} configured credential${checks.providers.configuredCredentialCount === 1 ? "" : "s"} marked valid.`
      : [
          ...checks.providers.invalid.map((item) => `${item.label} is ${humanize(item.status).toLowerCase()}`),
          ...(checks.providers.missingCredentialIds.length
            ? ["The active snapshot references a credential that is no longer available."]
            : []),
        ].join(" ");
  return (
    <Card className={styles.panel}>
      <div className={styles.panelHeader}>
        <h2>Readiness</h2>
        <StatusBadge status={readiness.ready ? "up" : "down"}>
          {readiness.ready ? "Ready" : "Action required"}
        </StatusBadge>
      </div>
      <div className={styles.checkGrid}>
        <Check
          available={checks.connectivity.reportingAvailable}
          detail={checks.connectivity.reportingAvailable
            ? `Last heartbeat ${formatDate(checks.connectivity.lastHeartbeatAt)}`
            : checks.connectivity.limitation}
          label="Gateway heartbeat"
          ok={checks.connectivity.ok}
          value={checks.connectivity.reportingAvailable ? humanize(checks.connectivity.state) : "Reporting unavailable"}
        />
        <Check
          detail={checks.snapshotFreshness.ok
            ? "The gateway-reported revision matches the active revision."
            : "Publish a snapshot and wait for the gateway to report the active revision."}
          label="Snapshot revision"
          ok={checks.snapshotFreshness.ok}
          value={humanize(checks.snapshotFreshness.state)}
        />
        <Check
          detail={providerDetail}
          label="Provider credentials"
          ok={checks.providers.ok}
          value={humanize(checks.providers.state)}
        />
        <Check
          available={checks.snapshotServing.available}
          detail={checks.snapshotServing.available
            ? `Snapshot stored ${formatDate(checks.snapshotServing.storedAt)}`
            : "No active snapshot is stored for this gateway."}
          label="Snapshot serving"
          ok={checks.snapshotServing.reportedServingActive}
          value={checks.snapshotServing.available ? "Snapshot available" : "Unavailable"}
        />
        <Check
          available={clockSkewAvailable}
          detail={checks.clockSkew.reason}
          label="Clock skew"
          ok={clockSkewMeasured}
          value={!clockSkewAvailable
            ? "Unavailable"
            : clockSkewMeasured
              ? `${checks.clockSkew.skewSeconds} seconds`
              : "Not measured"}
        />
        <Check
          detail={checks.installationAuthentication.method === "workload_identity"
            ? "OIDC JWTs are pinned to this installation's issuer, JWKS URL, audience, and subject."
            : "Exact-request Ed25519 signatures are verified for this installation."}
          label="Installation authentication"
          ok={checks.installationAuthentication.ok}
          value={checks.installationAuthentication.state === "configured"
            ? humanize(checks.installationAuthentication.method)
            : "Invalid configuration"}
        />
      </div>
    </Card>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: DiagnosticsResponse | null }) {
  if (!diagnostics) {
    return (
      <Card className={styles.panel}>
        <div className={styles.panelHeader}><h2>Diagnostics</h2></div>
        <Skeleton style={{ height: 220 }} />
      </Card>
    );
  }
  const syntheticState = diagnosticResultState(
    diagnostics.syntheticTest.available,
    diagnostics.syntheticTest.lastResult,
    diagnostics.syntheticTest,
  );
  return (
    <Card className={styles.panel}>
      <div className={styles.panelHeader}><h2>Diagnostics</h2></div>
      <AlertBanner
        title={`Synthetic request ${diagnosticResultLabel(syntheticState).toLowerCase()}`}
        tone={diagnosticResultTone(syntheticState)}
      >
        <div>{diagnostics.syntheticTest.reason}</div>
        {diagnostics.syntheticTest.available ? (
          <div className={styles.checkDetail}>
            Last result: {diagnosticResultDetail(diagnostics.syntheticTest.lastResult)}
            {diagnostics.syntheticTest.lastResult ? ` Recorded ${formatDate(diagnostics.syntheticTest.lastResult.createdAt)}.` : ""}
            {syntheticState === "stale" ? " This result is stale for the current configuration or deployment state." : ""}
          </div>
        ) : null}
      </AlertBanner>
      <div>
        <div className={styles.checkHeader}>
          <span>Recent config operations</span>
          <span className="console-muted">{diagnostics.recentConfigOperations.length}</span>
        </div>
        <div className={styles.operations}>
          {diagnostics.recentConfigOperations.length ? diagnostics.recentConfigOperations.map((operation) => (
            <div className={styles.operation} key={operation.id}>
              <StatusBadge status={configOperationDisplayTone(configOperationDisplayState(operation.outcome, operation.acceleratorStatus))}>
                {humanize(operation.acceleratorStatus)}
              </StatusBadge>
              <span>{operation.tripwireItems && Array.isArray(operation.tripwireItems) && operation.tripwireItems.length
                ? `${operation.tripwireItems.length} publish check${operation.tripwireItems.length === 1 ? "" : "s"}`
                : humanize(operation.operationKind)}</span>
              {operation.acceleratorStatus === "reconciliation_required"
                ? <span className="console-muted">Retry attempts {operation.reconciliationAttempts}</span>
                : null}
              <span className="console-muted">{formatDate(operation.createdAt)}</span>
            </div>
          )) : <div className={styles.emptyLine}>No configuration operations recorded.</div>}
        </div>
      </div>
      <div className={styles.checkDetail}>
        Heartbeat reporting: {diagnostics.lastHeartbeat.reportingAvailable
          ? formatDate(diagnostics.lastHeartbeat.observedAt)
          : diagnostics.lastHeartbeat.limitation}
      </div>
    </Card>
  );
}

function ProfilesPanel({
  installation,
  onAdd,
  onDisable,
}: {
  installation: InstallationDetail;
  onAdd: () => void;
  onDisable: (profile: IngressProfile) => void;
}) {
  return (
    <Card>
      <div className={styles.toolbar}>
        <strong>Trusted hosts</strong>
        <span className={styles.toolbarCount}>
          {installation.profiles.length} profile{installation.profiles.length === 1 ? "" : "s"}
        </span>
      </div>
      {installation.profiles.length === 0 ? (
        <EmptyState
          action={<Button onClick={onAdd} variant="primary">Bind trusted host</Button>}
          description="Bind a hostname to one fixed trust mode, then publish the staged change."
          title="No trusted hosts"
        />
      ) : (
        <div className="console-table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Mode</th>
                <th>Network</th>
                <th>Binding</th>
                <th>Lifecycle</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {installation.profiles.map((profile) => (
                <tr key={profile.id}>
                  <td><strong>{profile.hostname}</strong></td>
                  <td className={styles.profileMode}>{profile.mode}</td>
                  <td>{humanize(profile.networkExposure)}</td>
                  <td>
                    <StatusBadge status={profile.published ? "up" : "verifying"}>
                      {profile.published ? "Published" : "Draft"}
                    </StatusBadge>
                  </td>
                  <td>
                    <StatusBadge status={profile.status === "active" ? "up" : "down"}>
                      {humanize(profile.status)}
                    </StatusBadge>
                  </td>
                  <td>
                    {profile.status === "active" ? (
                      <Button onClick={() => onDisable(profile)} variant="danger-outline">
                        Disable
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AddProfileSheet({
  installationId,
  open,
  onClose,
  onCreated,
}: {
  installationId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (profile: ProfileCreated) => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(emptyProfileDraft);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) return;
    setDraft(emptyProfileDraft);
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profileDraftComplete(draft)) return;
    setSubmitting(true);
    setError(null);
    try {
      const profile = await apiRequest<ProfileCreated>(`/deployments/${installationId}/profiles`, {
        method: "POST",
        body: profileRequest(draft),
      });
      onCreated(profile);
    } catch (caught) {
      setError(message(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet onClose={onClose} open={open} title="Bind trusted host">
      <form className="console-form" onSubmit={submit}>
        <div className={styles.notice}>
          <strong>Fixed trust mode</strong>
          <p>The selected mode cannot be changed after creation. The host binding becomes effective after Publish.</p>
        </div>
        <ProfileFields draft={draft} onChange={setDraft} />
        {error ? <p className="console-form-error" role="alert">{error}</p> : null}
        <div className={styles.actions}>
          <Button disabled={submitting} onClick={onClose}>Cancel</Button>
          <Button disabled={submitting || !profileDraftComplete(draft)} type="submit" variant="primary">
            {submitting ? "Saving trusted host" : "Save as draft"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function Check({
  label,
  value,
  detail,
  ok,
  available = true,
}: {
  label: string;
  value: string;
  detail: string;
  ok: boolean;
  available?: boolean;
}) {
  return (
    <div className={styles.check}>
      <div className={styles.checkHeader}>
        <span>{label}</span>
        <StatusDot status={checkTone(ok, available)} />
      </div>
      <div className={styles.checkValue}>{value}</div>
      <div className={styles.checkDetail}>{detail}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
