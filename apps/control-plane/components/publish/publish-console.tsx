"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { StatusBadge, type Status } from "@/components/ui/status";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import styles from "./publish.module.css";

type DiffSection = { added: string[]; removed: string[]; changed: string[] };
type Diff = Record<"routes" | "keys" | "offerings" | "policies" | "budgets", DiffSection>;
type Tripwire = {
  kind: "route_delete" | "entitlement_removal" | "budget_enforcement_relaxed";
  ref: string;
  detail: Record<string, unknown>;
};
type Installation = { id: string; name: string; edition: string; status: string };
type Context = { installations: Installation[] };
type MemberRole = "owner" | "admin" | "editor" | "viewer" | "billing";
type Me = { member: { role: MemberRole } | null };
type Plan = {
  installationId: string;
  planHash: string;
  baseConfigHash: string | null;
  targetConfigHash: string;
  diff: Diff;
  tripwireItems: Tripwire[];
  noop: boolean;
};
type ApprovalResponse = {
  installationId: string;
  planHash: string;
  approvals: Array<{ id: string; kind: string; ref: string }>;
  expiresAt: string;
};
type Revision = { id: string; content_hash: string; parent_revision_id: string | null; status: string; created_at: string };
type Operation = {
  id: string;
  operation_kind: string;
  revision_id: string | null;
  base_config_hash: string | null;
  target_config_hash: string | null;
  plan_hash: string | null;
  outcome: string;
  serving_mode: "boot_fallback" | "edge_config";
  accelerator_status: "not_configured" | "pending" | "published" | "reconciliation_required" | "superseded";
  edge_config_version: string | null;
  error: { message?: string; reconciliation_required?: boolean } | null;
  reconciliation_attempts: number;
  last_reconcile_at: string | null;
  completed_at: string | null;
  created_at: string;
};
type History = { installationId: string; revisions: Revision[]; operations: Operation[] };
type ApplyResult = {
  revisionId: string | null;
  edgeConfigVersion: string | null;
  servingMode: "boot_fallback" | "edge_config";
  acceleratorStatus: string;
  activeContentHash: string | null;
  outcome: "written" | "accepted" | "rejected" | "failed";
  noop: boolean;
};
type RollbackResult = {
  operationId: string;
  revisionId: string;
  activeContentHash: string;
  servingMode: "boot_fallback" | "edge_config";
  acceleratorStatus: string;
  edgeConfigVersion: string | null;
  byteIdentical: boolean;
};
type ReconcileResult = {
  operationId: string;
  revisionId: string;
  servingMode: "boot_fallback" | "edge_config";
  acceleratorStatus: string;
  edgeConfigVersion: string | null;
};
type MutationResult =
  | { kind: "apply"; value: ApplyResult }
  | { kind: "rollback"; value: RollbackResult }
  | { kind: "reconcile"; value: ReconcileResult };

const diffLabels: Record<keyof Diff, string> = { routes: "Routes", keys: "Keys", offerings: "Offerings", policies: "Policies", budgets: "Budgets" };
const tripwireLabels: Record<Tripwire["kind"], string> = { route_delete: "Route deletion", entitlement_removal: "Entitlement removal", budget_enforcement_relaxed: "Budget enforcement relaxed" };

function shortHash(hash: string | null): string {
  if (!hash) return "No active revision";
  return hash.length > 24 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function mutationStatus(result: MutationResult): Status {
  if (result.kind === "apply") return result.value.outcome === "written" || result.value.outcome === "accepted" ? "up" : "down";
  return "up";
}

function ApiError({ error }: { error: ControlPlaneApiError }) {
  const { payload } = error;
  return <AlertBanner tone="down" title={payload.code}><span>{payload.remediation ?? payload.message}</span>{payload.reason_codes.length ? <div>Reason codes: {payload.reason_codes.join(", ")}</div> : null}<div>Request ID: <code>{payload.request_id}</code></div></AlertBanner>;
}

export function PublishConsole() {
  const [context, setContext] = useState<Context | null>(null);
  const [role, setRole] = useState<MemberRole>("viewer");
  const [installationId, setInstallationId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [approvals, setApprovals] = useState<ApprovalResponse | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
  const [rollbackTarget, setRollbackTarget] = useState<Revision | null>(null);
  const [rollbackConfirmation, setRollbackConfirmation] = useState("");
  const [loadingContext, setLoadingContext] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [reconcilingId, setReconcilingId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stalePlan, setStalePlan] = useState(false);
  const [result, setResult] = useState<MutationResult | null>(null);
  const canMutate = role === "admin" || role === "owner";

  const loadHistory = useCallback(async () => {
    if (!installationId) return;
    setLoadingHistory(true);
    try {
      setHistory(await apiRequest<History>(`/config/history?installationId=${encodeURIComponent(installationId)}`));
    } catch (caught) {
      setError(caught);
    } finally {
      setLoadingHistory(false);
    }
  }, [installationId]);

  useEffect(() => {
    let mounted = true;
    Promise.all([apiRequest<Context>("/context"), apiRequest<Me>("/me")])
      .then(([nextContext, me]) => {
        if (!mounted) return;
        setContext(nextContext);
        setRole(me.member?.role ?? "viewer");
        setInstallationId(nextContext.installations[0]?.id ?? "");
      })
      .catch((caught: unknown) => { if (mounted) setError(caught); })
      .finally(() => { if (mounted) setLoadingContext(false); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const resetPlan = () => {
    setPlan(null);
    setApprovals(null);
    setConfirmations({});
    setStalePlan(false);
  };

  const createPlan = async () => {
    if (!installationId) return;
    setPlanning(true); setError(null); setResult(null); resetPlan();
    try {
      setPlan(await apiRequest<Plan>("/config/plan", { method: "POST", body: { installationId } }));
    } catch (caught) { setError(caught); } finally { setPlanning(false); }
  };

  const approvedTripwireRefs = useMemo(() => plan?.tripwireItems.filter((item) => confirmations[item.ref] === item.ref).map((item) => item.ref) ?? [], [confirmations, plan]);
  const allTripwiresConfirmed = approvedTripwireRefs.length === (plan?.tripwireItems.length ?? 0);
  const approvalsLive = Boolean(plan && approvals && approvals.planHash === plan.planHash && approvals.approvals.length === plan.tripwireItems.length);

  const createApprovals = async () => {
    if (!plan || !canMutate || !allTripwiresConfirmed) return;
    setApproving(true); setError(null);
    try {
      setApprovals(await apiRequest<ApprovalResponse>("/config/approvals", { method: "POST", body: { installationId: plan.installationId, planHash: plan.planHash } }));
    } catch (caught) {
      handleStalePlan(caught);
    } finally { setApproving(false); }
  };

  const handleStalePlan = (caught: unknown) => {
    setError(caught);
    if (caught instanceof ControlPlaneApiError && caught.payload.code === "CONFIG_PRECONDITION_FAILED") {
      resetPlan();
      setStalePlan(true);
      void loadHistory();
    }
  };

  const applyPlan = async () => {
    if (!plan || !canMutate || stalePlan || (plan.tripwireItems.length > 0 && !approvalsLive)) return;
    setApplying(true); setError(null); setResult(null);
    try {
      const value = await apiRequest<ApplyResult>("/config/apply", { method: "POST", body: { installationId: plan.installationId, planHash: plan.planHash, approvalIds: approvals?.approvals.map((item) => item.id) ?? [] } });
      setResult({ kind: "apply", value });
      resetPlan();
      void loadHistory();
    } catch (caught) { handleStalePlan(caught); } finally { setApplying(false); }
  };

  const rollback = async () => {
    const active = history?.revisions.find((revision) => revision.status === "active");
    if (!rollbackTarget || !active || !canMutate || rollbackConfirmation !== `ROLLBACK ${rollbackTarget.id}`) return;
    setRollingBack(true); setError(null); setResult(null);
    try {
      const value = await apiRequest<RollbackResult>("/config/rollback", { method: "POST", body: { installationId, revisionId: rollbackTarget.id, baseConfigHash: active.content_hash } });
      setResult({ kind: "rollback", value });
      setRollbackTarget(null); setRollbackConfirmation("");
      void loadHistory();
    } catch (caught) { setError(caught); if (caught instanceof ControlPlaneApiError && caught.payload.code === "CONFIG_PRECONDITION_FAILED") void loadHistory(); } finally { setRollingBack(false); }
  };

  const reconcile = async (operationId: string) => {
    if (!canMutate) return;
    setReconcilingId(operationId); setError(null); setResult(null);
    try {
      setResult({ kind: "reconcile", value: await apiRequest<ReconcileResult>("/config/reconcile", { method: "POST", body: { operationId } }) });
      void loadHistory();
    } catch (caught) { setError(caught); void loadHistory(); } finally { setReconcilingId(null); }
  };

  const selectInstallation = (nextId: string) => {
    setInstallationId(nextId); resetPlan(); setHistory(null); setRollbackTarget(null); setRollbackConfirmation(""); setResult(null); setError(null);
  };

  return <div className={styles.root}>
    {error instanceof ControlPlaneApiError ? <ApiError error={error} /> : null}
    {error && !(error instanceof ControlPlaneApiError) ? <AlertBanner tone="down" title="Publish request failed">{error instanceof Error ? error.message : "The request could not be completed"}</AlertBanner> : null}
    {stalePlan ? <AlertBanner tone="verifying" title="Plan is stale">The active revision changed. Generate and review a new plan before any approval or apply request.</AlertBanner> : null}
    {!canMutate && !loadingContext ? <AlertBanner tone="idle" title="Review access">Your role can generate and review plans. An admin or owner session is required for approvals, apply, rollback, and reconciliation.</AlertBanner> : null}
    {result ? <MutationResultCard result={result} /> : null}

    <Card className={styles.controls}>
      <div className="console-field"><span>Gateway installation</span>{loadingContext ? <Skeleton style={{ height: 34 }} /> : <Select aria-label="Gateway installation" disabled={!context?.installations.length || planning || applying} onChange={(event) => selectInstallation(event.target.value)} value={installationId}>{!context?.installations.length ? <option value="">No installations available</option> : null}{context?.installations.map((installation) => <option key={installation.id} value={installation.id}>{installation.name} · {installation.edition} · {installation.status}</option>)}</Select>}</div>
      <Button disabled={!installationId || planning || applying} onClick={() => void createPlan()} variant="primary">{planning ? "Generating plan" : stalePlan ? "Generate new plan" : "Generate plan"}</Button>
      <Button disabled={!installationId || loadingHistory} onClick={() => void loadHistory()} variant="secondary">{loadingHistory ? "Refreshing history" : "Refresh history"}</Button>
    </Card>

    {plan ? <PlanReview plan={plan} confirmations={confirmations} approvals={approvals} canMutate={canMutate} approving={approving} applying={applying} allTripwiresConfirmed={allTripwiresConfirmed} approvalsLive={approvalsLive} onConfirmation={(ref, value) => setConfirmations((current) => ({ ...current, [ref]: value }))} onApprove={() => void createApprovals()} onApply={() => void applyPlan()} /> : null}
    <HistoryView canMutate={canMutate} history={history} loading={loadingHistory} onReconcile={(operationId) => void reconcile(operationId)} onRollback={(revision) => { setRollbackTarget(revision); setRollbackConfirmation(""); }} reconcilingId={reconcilingId} />
    {rollbackTarget ? <RollbackPanel active={history?.revisions.find((revision) => revision.status === "active") ?? null} confirmation={rollbackConfirmation} onCancel={() => { setRollbackTarget(null); setRollbackConfirmation(""); }} onChange={setRollbackConfirmation} onRollback={() => void rollback()} rollingBack={rollingBack} target={rollbackTarget} /> : null}
  </div>;
}

function PlanReview({ plan, confirmations, approvals, canMutate, approving, applying, allTripwiresConfirmed, approvalsLive, onConfirmation, onApprove, onApply }: { plan: Plan; confirmations: Record<string, string>; approvals: ApprovalResponse | null; canMutate: boolean; approving: boolean; applying: boolean; allTripwiresConfirmed: boolean; approvalsLive: boolean; onConfirmation: (ref: string, value: string) => void; onApprove: () => void; onApply: () => void }) {
  const approvalExpired = Boolean(approvals && new Date(approvals.expiresAt).getTime() <= Date.now());
  return <>
    <Card className={styles.planCard}><div className={styles.cardHeading}><div><h2>Plan summary</h2><p>This plan is bound to its base revision and target configuration.</p></div><StatusBadge status={plan.noop ? "idle" : "verifying"}>{plan.noop ? "No changes" : "Review required"}</StatusBadge></div><dl className={styles.summary}><div><dt>Plan hash</dt><dd className="console-mono" title={plan.planHash}>{shortHash(plan.planHash)}</dd></div><div><dt>Base configuration</dt><dd className="console-mono" title={plan.baseConfigHash ?? undefined}>{shortHash(plan.baseConfigHash)}</dd></div><div><dt>Target configuration digest</dt><dd className="console-mono" title={plan.targetConfigHash}>{shortHash(plan.targetConfigHash)}</dd></div></dl></Card>
    {plan.noop ? <Card><div className="console-empty"><h2>No configuration changes to publish</h2><p>The active configuration already matches this target. No apply action is needed.</p></div></Card> : <><DiffView diff={plan.diff} /><TripwireView approvals={approvals} canMutate={canMutate} confirmations={confirmations} items={plan.tripwireItems} onChange={onConfirmation} />{plan.tripwireItems.length ? <Card className={styles.applyCard}><div><h2>Persisted approval</h2><p>Approval records are plan-bound, expire after 15 minutes, and can be consumed once by apply.</p>{approvals ? <p className={styles.approvalStatus}>{approvalExpired ? "The approval records expired. Create live records again after reviewing this plan." : `Created ${approvals.approvals.length} live approval records. Expires ${formatTime(approvals.expiresAt)}.`}</p> : null}</div><Button disabled={!canMutate || !allTripwiresConfirmed || approving || approvalsLive} onClick={onApprove} variant="danger-outline">{approving ? "Creating approvals" : approvalsLive ? "Approvals ready" : approvalExpired ? "Renew persisted approvals" : "Create persisted approvals"}</Button></Card> : null}<Card className={styles.applyCard}><div><h2>Apply this plan</h2><p>The server rechecks the plan hash and any approval records before recording the revision. This does not report gateway runtime state.</p></div><Button disabled={!canMutate || applying || (plan.tripwireItems.length > 0 && !approvalsLive)} onClick={onApply} variant="danger">{applying ? "Applying plan" : "Apply confirmed plan"}</Button></Card></>}</>;
}

function DiffView({ diff }: { diff: Diff }) { return <Card className={styles.planCard}><div className={styles.cardHeading}><div><h2>Structured diff</h2><p>Every changed configuration section is listed by operation.</p></div></div><div className={styles.diffGrid}>{(Object.keys(diff) as Array<keyof Diff>).map((section) => <section className={styles.diffSection} key={section}><h3>{diffLabels[section]}</h3>{(["added", "changed", "removed"] as const).map((operation) => <div className={styles.diffOperation} key={operation}><strong>{operation}</strong>{diff[section][operation].length ? <ul>{diff[section][operation].map((item) => <li className="console-mono" key={item}>{item}</li>)}</ul> : <span className="console-faint">None</span>}</div>)}</section>)}</div></Card>; }

function TripwireView({ items, confirmations, approvals, canMutate, onChange }: { items: Tripwire[]; confirmations: Record<string, string>; approvals: ApprovalResponse | null; canMutate: boolean; onChange: (ref: string, value: string) => void }) {
  if (!items.length) return <AlertBanner tone="up" title="No tripwires detected">This plan has no destructive blast-radius items.</AlertBanner>;
  return <Card className={styles.planCard}><div className={styles.cardHeading}><div><h2>Blast-radius confirmation</h2><p>Type each exact reference before creating single-use approval records.</p></div><StatusBadge status="down">{items.length} confirmation{items.length === 1 ? "" : "s"} required</StatusBadge></div><div className={styles.tripwireList}>{items.map((item) => { const approval = approvals?.approvals.find((candidate) => candidate.ref === item.ref && candidate.kind === item.kind); return <section className={styles.tripwire} key={`${item.kind}:${item.ref}`}><div><strong>{tripwireLabels[item.kind]}</strong><code>{item.ref}</code>{Object.keys(item.detail).length ? <span className="console-muted">{JSON.stringify(item.detail)}</span> : null}{approval ? <span className={styles.approvalStatus}>Persisted approval <code>{approval.id}</code></span> : null}</div><label className="console-field"><span>Type <code>{item.ref}</code> to approve</span><Input aria-label={`Approve ${item.ref}`} disabled={!canMutate || Boolean(approvals)} onChange={(event) => onChange(item.ref, event.target.value)} placeholder={item.ref} value={confirmations[item.ref] ?? ""} /></label></section>; })}</div></Card>;
}

function HistoryView({ history, loading, canMutate, reconcilingId, onReconcile, onRollback }: { history: History | null; loading: boolean; canMutate: boolean; reconcilingId: string | null; onReconcile: (operationId: string) => void; onRollback: (revision: Revision) => void }) {
  const active = history?.revisions.find((revision) => revision.status === "active") ?? null;
  return <Card className={styles.planCard}><div className={styles.cardHeading}><div><h2>Immutable operation history</h2><p>Recorded revision and publication operations. Gateway runtime consumption is not reported here.</p></div>{active ? <StatusBadge status="idle">Active digest {shortHash(active.content_hash)}</StatusBadge> : null}</div>{loading && !history ? <Skeleton style={{ height: 120 }} /> : !history ? <div className="console-empty"><h2>Select an installation</h2><p>History will load for the selected gateway installation.</p></div> : <><div className={styles.historyList}>{history.operations.length ? history.operations.map((operation) => <OperationRow canMutate={canMutate} key={operation.id} onReconcile={onReconcile} operation={operation} reconciling={reconcilingId === operation.id} />) : <p className="console-muted">No recorded operations.</p>}</div><div className={styles.revisionList}><h3>Stored revisions</h3>{history.revisions.map((revision) => <div className={styles.revision} key={revision.id}><div><strong className="console-mono">{revision.id}</strong><span className="console-muted">{shortHash(revision.content_hash)} · {revision.status} · {formatTime(revision.created_at)}</span></div><Button disabled={!canMutate || revision.status === "active" || !active} onClick={() => onRollback(revision)} variant="danger-outline">Rollback to bytes</Button></div>)}</div></>}</Card>;
}

function OperationRow({ operation, canMutate, reconciling, onReconcile }: { operation: Operation; canMutate: boolean; reconciling: boolean; onReconcile: (operationId: string) => void }) {
  const needsReconciliation = operation.accelerator_status === "reconciliation_required";
  return <section className={styles.operation}><div className={styles.operationHead}><strong>{operation.operation_kind} · {operation.outcome}</strong><StatusBadge status={needsReconciliation ? "down" : operation.accelerator_status === "published" ? "up" : "idle"}>{operation.accelerator_status}</StatusBadge></div><dl className={styles.operationMeta}><div><dt>Operation</dt><dd className="console-mono">{operation.id}</dd></div><div><dt>Serving mode</dt><dd>{operation.serving_mode}</dd></div><div><dt>Target digest</dt><dd className="console-mono">{shortHash(operation.target_config_hash)}</dd></div><div><dt>Accelerator version</dt><dd className="console-mono">{operation.edge_config_version ?? "Not recorded"}</dd></div><div><dt>Recorded</dt><dd>{formatTime(operation.created_at)}</dd></div></dl>{operation.serving_mode === "boot_fallback" ? <p className={styles.modeNote}>Boot fallback records that the exact signed snapshot remains available from the control plane. It does not confirm gateway retrieval.</p> : null}{needsReconciliation ? <AlertBanner tone="down" title="Reconciliation required">{operation.error?.message ?? "The accelerator publication needs a retry."}<div>Attempts: {operation.reconciliation_attempts}. Last retry: {formatTime(operation.last_reconcile_at)}.</div><div className={styles.alertAction}><Button disabled={!canMutate || reconciling} onClick={() => onReconcile(operation.id)} variant="danger-outline">{reconciling ? "Reconciling" : "Retry reconciliation"}</Button></div></AlertBanner> : null}</section>;
}

function RollbackPanel({ target, active, confirmation, rollingBack, onChange, onCancel, onRollback }: { target: Revision; active: Revision | null; confirmation: string; rollingBack: boolean; onChange: (value: string) => void; onCancel: () => void; onRollback: () => void }) {
  const required = `ROLLBACK ${target.id}`;
  return <Card className={styles.planCard}><div className={styles.cardHeading}><div><h2>Byte-identical rollback</h2><p>Republish the stored bytes for revision <code>{target.id}</code>. The server verifies the current active digest before recording this rollback.</p></div><StatusBadge status="down">Destructive action</StatusBadge></div><dl className={styles.summary}><div><dt>Current active digest</dt><dd className="console-mono">{shortHash(active?.content_hash ?? null)}</dd></div><div><dt>Rollback target digest</dt><dd className="console-mono">{shortHash(target.content_hash)}</dd></div><div><dt>Target revision</dt><dd className="console-mono">{target.id}</dd></div></dl><label className="console-field"><span>Type <code>{required}</code> to confirm</span><Input aria-label="Rollback confirmation" onChange={(event) => onChange(event.target.value)} placeholder={required} value={confirmation} /></label><div className="console-actions"><Button onClick={onCancel} variant="secondary">Cancel</Button><Button disabled={rollingBack || !active || confirmation !== required} onClick={onRollback} variant="danger">{rollingBack ? "Rolling back" : "Republish identical bytes"}</Button></div></Card>;
}

function MutationResultCard({ result }: { result: MutationResult }) {
  const body = result.kind === "apply"
    ? { title: `Apply returned ${result.value.outcome}`, operationId: null, servingMode: result.value.servingMode, acceleratorStatus: result.value.acceleratorStatus, digest: result.value.activeContentHash, version: result.value.edgeConfigVersion }
    : result.kind === "rollback"
      ? { title: "Rollback recorded", operationId: result.value.operationId, servingMode: result.value.servingMode, acceleratorStatus: result.value.acceleratorStatus, digest: result.value.activeContentHash, version: result.value.edgeConfigVersion }
      : { title: "Reconciliation recorded", operationId: result.value.operationId, servingMode: result.value.servingMode, acceleratorStatus: result.value.acceleratorStatus, digest: null, version: result.value.edgeConfigVersion };
  return <Card className={styles.result} aria-live="polite"><StatusBadge status={mutationStatus(result)}>{body.title}</StatusBadge><dl className={styles.summary}>{body.operationId ? <div><dt>Operation</dt><dd className="console-mono">{body.operationId}</dd></div> : null}<div><dt>Serving mode</dt><dd>{body.servingMode}</dd></div><div><dt>Accelerator status</dt><dd>{body.acceleratorStatus}</dd></div><div><dt>Target digest</dt><dd className="console-mono">{shortHash(body.digest)}</dd></div><div><dt>Accelerator version</dt><dd className="console-mono">{body.version ?? "Not recorded"}</dd></div></dl><p className="console-muted">{body.servingMode === "boot_fallback" ? "Boot fallback means the exact signed snapshot remains available from the control plane. " : ""}This is the control-plane result. It does not confirm a gateway has loaded or served this configuration.</p></Card>;
}
