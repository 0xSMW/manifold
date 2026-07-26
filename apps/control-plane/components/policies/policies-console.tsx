"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

type PageResult<T> = { data: T[]; nextCursor: string | null };
type PolicySummary = { id: string; name: string; activeRevisionId: string | null; revisionCount: number; createdAt: string; updatedAt: string };
type Entitlement = { id: string; subjectKind: SubjectKind; subjectRef: string | null; canonicalModelId: string | null; offeringId: string | null; effect: "allow" | "deny"; createdAt: string };
type Constraint = { id: string; param: string; maxValue: number | null; minValue: number | null; onViolation: "clamp" | "reject"; createdAt: string };
type DataHandling = { id: string; captureMode: string; redaction: unknown; allowedRegions: unknown; createdAt: string };
type Approval = { id: string; approvedBy: string; reason: string | null; createdAt: string };
type Revision = { id: string; contentHash: string; createdBy: string | null; createdAt: string; isActive: boolean; entitlements: Entitlement[]; requestConstraints: Constraint[]; dataHandlingConstraints: DataHandling[]; approvals: Approval[] };
type PolicyDetail = Omit<PolicySummary, "revisionCount"> & { revisions: Revision[] };
type SubjectKind = "all" | "key_scope" | "team" | "cost_center" | "app";
type Me = { member: { role: string } | null; scopes: string[] };
type Context = { teams: Array<{ id: string; name: string }>; costCenters: Array<{ id: string; name: string }>; apps: Array<{ id: string; name: string; slug: string }> };
type Model = { id: string; canonicalModel: { id: string; displayName: string } };

type DraftEntitlement = { subjectKind: SubjectKind; subjectRef: string; canonicalModelId: string; effect: "allow" | "deny" };
type DraftConstraint = { param: string; minValue: string; maxValue: string; onViolation: "clamp" | "reject" };

const cell = { borderBottom: "1px solid var(--border)", padding: 12, textAlign: "left" as const, verticalAlign: "top" };
const subjectKinds: SubjectKind[] = ["all", "key_scope", "team", "cost_center", "app"];
const blankEntitlement = (): DraftEntitlement => ({ subjectKind: "all", subjectRef: "", canonicalModelId: "", effect: "allow" });
const blankConstraint = (): DraftConstraint => ({ param: "max_tokens", minValue: "", maxValue: "", onViolation: "clamp" });

function message(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed"; }
function when(value: string): string { return new Date(value).toLocaleString(); }
function numberOrNull(value: string): number | null { const parsed = Number(value); return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed; }

export function PoliciesConsole() {
  const toast = useToast();
  const [policies, setPolicies] = useState<PolicySummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const loadList = useCallback(async (cursor: string | null = null) => {
    setLoadError(null);
    try {
      const result = await apiRequest<PageResult<PolicySummary>>(`/policies?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      setPolicies((current) => cursor ? [...(current ?? []), ...result.data] : result.data);
      setNextCursor(result.nextCursor);
    } catch (caught) { setLoadError(message(caught)); setPolicies((current) => current ?? []); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);

  const createPolicy = async () => {
    if (!newName.trim()) { setLoadError("Enter a policy name."); return; }
    setCreating(true); setLoadError(null);
    try {
      const policy = await apiRequest<{ id: string }>("/policies", { method: "POST", body: { name: newName.trim() } });
      setNewName(""); await loadList(); window.location.assign(`/policies/${encodeURIComponent(policy.id)}`); toast("Policy created add its first staged revision", "verifying");
    } catch (caught) { setLoadError(message(caught)); } finally { setCreating(false); }
  };

  return <PageFrame title="Policies" description="Deny-first governance revisions for enterprise ingress" actions={<a className="cp-button" data-variant="primary" href="/publish">Open Publish</a>}>
    <div style={{ display: "grid", gap: 16 }}>
      <AlertBanner title="Staged policy revisions" tone="verifying">A successor revision remains staged until it is included in Publish. Approval records an approver decision and does not publish a policy.</AlertBanner>
      {loadError ? <AlertBanner title="Policies could not load" tone="down">{loadError} <Button onClick={() => void loadList()} variant="outline">Retry</Button></AlertBanner> : null}
      <Card style={{ overflow: "hidden" }}>
        {policies === null ? <div style={{ display: "grid", gap: 8, padding: 12 }}><Skeleton style={{ height: 38 }} /><Skeleton style={{ height: 38 }} /></div> : null}
        {policies?.length === 0 ? <EmptyState description="Create a policy container, then author its first immutable staged revision." title="No policies yet" /> : null}
        {policies && policies.length > 0 ? <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse", width: "100%" }}><thead><tr style={{ color: "var(--fg-muted)", fontSize: 12 }}><th scope="col" style={cell}>Policy</th><th scope="col" style={cell}>Revision</th><th scope="col" style={cell}>Updated</th><th scope="col" style={cell} /></tr></thead><tbody>{policies.map((policy) => <tr key={policy.id}><td style={cell}><strong>{policy.name}</strong><div className="console-faint cp-mono">{policy.id}</div></td><td style={cell}><StatusBadge status={policy.activeRevisionId ? "verifying" : "idle"}>{policy.revisionCount} revision{policy.revisionCount === 1 ? "" : "s"}</StatusBadge></td><td style={cell}>{when(policy.updatedAt)}</td><td style={cell}><a className="cp-button" href={`/policies/${encodeURIComponent(policy.id)}`}>View</a></td></tr>)}</tbody></table></div> : null}
        {nextCursor ? <div style={{ padding: 12 }}><Button onClick={() => void loadList(nextCursor)} variant="outline">Load more policies</Button></div> : null}
      </Card>
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Create policy</h2><p className="console-muted">Creation records a draft container. It cannot affect a gateway until a revision is staged and then included in Publish.</p><div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 8 }}><label className="console-field" style={{ flex: "1 1 260px" }}><span>Policy name</span><Input maxLength={120} onChange={(event) => setNewName(event.target.value)} placeholder="Enterprise egress" value={newName} /></label><Button disabled={creating || !newName.trim()} onClick={() => void createPolicy()} variant="primary">{creating ? "Creating policy" : "Create policy"}</Button></div></Card>
    </div>
  </PageFrame>;
}

export function PolicyDetail({ policyId }: { policyId: string }) {
  const toast = useToast();
  const [policy, setPolicy] = useState<PolicyDetail | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    setPolicy(undefined);
    try {
      const [nextPolicy, nextMe] = await Promise.all([
        apiRequest<PolicyDetail>(`/policies/${encodeURIComponent(policyId)}`),
        apiRequest<Me>("/me"),
      ]);
      setPolicy(nextPolicy);
      setMe(nextMe);
    } catch (caught) {
      setError(caught);
      setPolicy(null);
    }
  }, [policyId]);

  useEffect(() => { void load(); }, [load]);

  if (policy === undefined) return <PageFrame description="Loading policy revisions, constraints, and approvals" title="Policy"><Card style={{ padding: 16 }}><Skeleton style={{ height: 220 }} /></Card></PageFrame>;
  if (policy === null) {
    const notFound = error instanceof ControlPlaneApiError && error.status === 404;
    return <PageFrame description="Deny-first governance revisions" title="Policy">{notFound ? <EmptyState action={<a className="cp-button" href="/policies">Back to policies</a>} description="The policy may have been removed or is outside this workspace." title="Policy not found" /> : <AlertBanner title="Policy could not load" tone="down">{message(error)} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner>}</PageFrame>;
  }

  const canApprove = Boolean(me?.member && me.scopes.includes("policies:approve"));
  return <PageFrame actions={<div style={{ display: "flex", gap: 8 }}><a className="cp-button" href="/policies">Back to policies</a><a className="cp-button" data-variant="primary" href="/publish">Open Publish</a></div>} description="Immutable revisions, deny-first constraints, and evaluator output" title={policy.name}>
    <PolicyEditor canApprove={canApprove} onChanged={(revisionId, action) => { void load(); toast(action === "approved" ? `Revision ${revisionId} approval confirmed` : `Revision ${revisionId} is staged`, "verifying"); }} policy={policy} />
  </PageFrame>;
}

function PolicyEditor({ policy, canApprove, onChanged }: { policy: PolicyDetail; canApprove: boolean; onChanged: (revisionId: string, action: "staged" | "approved") => void }) {
  const [draftEntitlements, setDraftEntitlements] = useState<DraftEntitlement[]>(() => initialEntitlements(policy));
  const [draftConstraints, setDraftConstraints] = useState<DraftConstraint[]>(() => initialConstraints(policy));
  const [context, setContext] = useState<Context | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [simulation, setSimulation] = useState<{ outcome: "allow" | "clamp" | "deny"; reasonCodes: string[]; clamps: Record<string, number> } | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simulationModelId, setSimulationModelId] = useState("");
  const [simulationSubject, setSimulationSubject] = useState("{}");
  const [simulationParams, setSimulationParams] = useState("{}");
  const [approvalReason, setApprovalReason] = useState("");
  const [approving, setApproving] = useState<string | null>(null);

  useEffect(() => { setDraftEntitlements(initialEntitlements(policy)); setDraftConstraints(initialConstraints(policy)); setSimulation(null); setSimulationModelId(simulationModelIdFor(policy)); setSimulationSubject("{}"); setSimulationParams("{}"); }, [policy]);
  useEffect(() => {
    Promise.all([apiRequest<Context>("/context"), apiRequest<PageResult<Model>>("/models?limit=100")])
      .then(([nextContext, result]) => { setContext(nextContext); setModels(result.data); })
      .catch((caught) => setDiscoverError(`Some picker names are unavailable: ${message(caught)}. IDs remain supported.`));
  }, []);

  const active = policy.revisions.find((revision) => revision.id === policy.activeRevisionId) ?? policy.revisions[0] ?? null;
  const updateEntitlement = (index: number, patch: Partial<DraftEntitlement>) => setDraftEntitlements((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const updateConstraint = (index: number, patch: Partial<DraftConstraint>) => setDraftConstraints((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const addRevision = async () => {
    setSaveError(null);
    const requestConstraints = draftConstraints.map((item) => ({ param: item.param.trim(), minValue: numberOrNull(item.minValue), maxValue: numberOrNull(item.maxValue), onViolation: item.onViolation }));
    if (requestConstraints.some((item) => !item.param || (item.minValue === null && item.maxValue === null) || (item.minValue !== null && item.maxValue !== null && item.minValue > item.maxValue))) { setSaveError("Each request constraint needs a parameter, at least one finite bound, and min must not exceed max."); return; }
    setSaving(true);
    try {
      const result = await apiRequest<{ revisionId: string }>(`/policies/${policy.id}/revisions`, { method: "POST", body: { entitlements: draftEntitlements.map((item) => ({ subjectKind: item.subjectKind, subjectRef: item.subjectKind === "all" ? null : item.subjectRef.trim() || null, canonicalModelId: item.canonicalModelId.trim() || null, offeringId: null, effect: item.effect })), requestConstraints, dataHandlingConstraints: active?.dataHandlingConstraints.map((item) => ({ captureMode: item.captureMode, redaction: item.redaction, allowedRegions: Array.isArray(item.allowedRegions) ? item.allowedRegions : null })) ?? [] } });
      onChanged(result.revisionId, "staged");
    } catch (caught) { setSaveError(message(caught)); } finally { setSaving(false); }
  };
  const simulate = async () => {
    if (!active) return;
    setSimulating(true); setSaveError(null);
    try {
      const subject: unknown = JSON.parse(simulationSubject);
      const params: unknown = JSON.parse(simulationParams);
      if (!subject || typeof subject !== "object" || Array.isArray(subject) || !params || typeof params !== "object" || Array.isArray(params)) throw new Error("Simulator subject and params must each be JSON objects.");
      const result = await apiRequest<{ outcome: "allow" | "clamp" | "deny"; reasonCodes: string[]; clamps: Record<string, number> }>(`/policies/${policy.id}/simulate`, { method: "POST", body: { revisionId: active.id, subject, canonicalModelId: simulationModelId.trim(), params } });
      setSimulation(result);
    } catch (caught) { setSaveError(message(caught)); } finally { setSimulating(false); }
  };
  const approve = async (revisionId: string) => {
    setApproving(revisionId); setSaveError(null);
    try { await apiRequest(`/policies/${policy.id}/approve`, { method: "POST", body: { revisionId, ...(approvalReason.trim() ? { reason: approvalReason.trim() } : {}) } }); onChanged(revisionId, "approved"); }
    catch (caught) { setSaveError(message(caught)); } finally { setApproving(null); }
  };

  return <div style={{ display: "grid", gap: 16 }}>
    <Card style={{ padding: 16 }}><div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}><div><div className="console-faint">Policy ID</div><span className="cp-mono console-faint">{policy.id}</span></div><StatusBadge status="verifying">Draft changes stage for Publish</StatusBadge></div></Card>
    {discoverError ? <AlertBanner title="Discovery unavailable" tone="verifying">{discoverError}</AlertBanner> : null}
    {saveError ? <AlertBanner title="Policy action failed" tone="down">{saveError}</AlertBanner> : null}
    <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Create successor revision</h2><p className="console-muted">Revisions are immutable. This editor starts from the current revision and creates a content-addressed successor.</p>
      <fieldset style={{ border: 0, display: "grid", gap: 10, margin: 0, padding: 0 }}><legend style={{ fontWeight: 650, marginBottom: 8 }}>Model entitlements</legend>{draftEntitlements.map((item, index) => <EntitlementFields context={context} item={item} key={index} models={models} onChange={(patch) => updateEntitlement(index, patch)} onRemove={() => setDraftEntitlements((items) => items.filter((_, itemIndex) => itemIndex !== index))} />)}<Button onClick={() => setDraftEntitlements((items) => [...items, blankEntitlement()])} variant="outline">Add entitlement</Button></fieldset>
      <fieldset style={{ border: 0, display: "grid", gap: 10, margin: "20px 0 0", padding: 0 }}><legend style={{ fontWeight: 650, marginBottom: 8 }}>Request constraints</legend>{draftConstraints.map((item, index) => <ConstraintFields item={item} key={index} onChange={(patch) => updateConstraint(index, patch)} onRemove={() => setDraftConstraints((items) => items.filter((_, itemIndex) => itemIndex !== index))} />)}<Button onClick={() => setDraftConstraints((items) => [...items, blankConstraint()])} variant="outline">Add constraint</Button></fieldset>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}><Button disabled={saving} onClick={() => { setDraftEntitlements(initialEntitlements(policy)); setDraftConstraints(initialConstraints(policy)); }} variant="outline">Reset</Button><Button disabled={saving} onClick={() => void addRevision()} variant="primary">{saving ? "Creating successor" : "Create staged successor"}</Button></div>
    </Card>
    <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Draft simulator</h2><p className="console-muted">Runs the shared evaluator against the current staged revision. Subject facets and numeric parameters use the API’s supported evaluator input shape.</p><div style={{ display: "grid", gap: 10, maxWidth: 680 }}><label className="console-field"><span>Canonical model ID</span><Input onChange={(event) => setSimulationModelId(event.target.value)} placeholder="Canonical model ID" value={simulationModelId} /></label><label className="console-field"><span>Subject facets JSON</span><textarea className="console-code" onChange={(event) => setSimulationSubject(event.target.value)} rows={3} value={simulationSubject} /></label><label className="console-field"><span>Numeric params JSON</span><textarea className="console-code" onChange={(event) => setSimulationParams(event.target.value)} rows={3} value={simulationParams} /></label></div><Button disabled={!active || simulating || !simulationModelId.trim()} onClick={() => void simulate()} style={{ marginTop: 10 }} variant="outline">{simulating ? "Evaluating" : "Run current revision"}</Button>{simulation ? <div style={{ marginTop: 12 }}><StatusBadge status={simulation.outcome === "deny" ? "down" : simulation.outcome === "clamp" ? "verifying" : "up"}>{simulation.outcome}</StatusBadge><div className="cp-mono" style={{ marginTop: 8 }}>{simulation.reasonCodes.length ? simulation.reasonCodes.join("\n") : "No reason codes"}</div>{Object.keys(simulation.clamps).length ? <pre className="console-code" style={{ marginTop: 8 }}>{JSON.stringify(simulation.clamps, null, 2)}</pre> : null}</div> : null}</Card>
    <RevisionHistory approvalReason={approvalReason} canApprove={canApprove} onApprovalReason={setApprovalReason} onApprove={approve} approving={approving} revisions={policy.revisions} />
  </div>;
}

function initialEntitlements(policy: PolicyDetail): DraftEntitlement[] { const active = policy.revisions.find((item) => item.id === policy.activeRevisionId) ?? policy.revisions[0]; return active?.entitlements.map((item) => ({ subjectKind: item.subjectKind, subjectRef: item.subjectRef ?? "", canonicalModelId: item.canonicalModelId ?? "", effect: item.effect })) ?? []; }
function initialConstraints(policy: PolicyDetail): DraftConstraint[] { const active = policy.revisions.find((item) => item.id === policy.activeRevisionId) ?? policy.revisions[0]; return active?.requestConstraints.map((item) => ({ param: item.param, minValue: item.minValue?.toString() ?? "", maxValue: item.maxValue?.toString() ?? "", onViolation: item.onViolation })) ?? []; }
function simulationModelIdFor(policy: PolicyDetail): string { const revision = policy.revisions.find((item) => item.id === policy.activeRevisionId) ?? policy.revisions[0] ?? null; return revision?.entitlements.find((item) => item.canonicalModelId)?.canonicalModelId ?? ""; }

function EntitlementFields({ item, onChange, onRemove, context, models }: { item: DraftEntitlement; onChange: (patch: Partial<DraftEntitlement>) => void; onRemove: () => void; context: Context | null; models: Model[] }) {
  const namedSubjects = item.subjectKind === "team" ? context?.teams : item.subjectKind === "cost_center" ? context?.costCenters : item.subjectKind === "app" ? context?.apps : null;
  return <div style={{ border: "1px solid var(--border)", borderRadius: 8, display: "grid", gap: 8, padding: 10 }}><div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}><Select aria-label="Subject kind" onChange={(event) => onChange({ subjectKind: event.target.value as SubjectKind, subjectRef: "" })} value={item.subjectKind}>{subjectKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</Select>{item.subjectKind !== "all" ? namedSubjects ? <Select aria-label="Subject" onChange={(event) => onChange({ subjectRef: event.target.value })} value={item.subjectRef}><option value="">Select {item.subjectKind}</option>{namedSubjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</Select> : <Input aria-label="Subject reference" onChange={(event) => onChange({ subjectRef: event.target.value })} placeholder={`${item.subjectKind} ID`} value={item.subjectRef} /> : <span className="console-muted" style={{ alignSelf: "center", fontSize: 12 }}>All subjects</span>}<Select aria-label="Effect" onChange={(event) => onChange({ effect: event.target.value as "allow" | "deny" })} value={item.effect}><option value="allow">Allow</option><option value="deny">Deny</option></Select></div><label className="console-field"><span>Canonical model</span>{models.length ? <Select onChange={(event) => onChange({ canonicalModelId: event.target.value })} value={item.canonicalModelId}><option value="">All models</option>{models.map((model) => <option key={model.canonicalModel.id} value={model.canonicalModel.id}>{model.canonicalModel.displayName} ({model.canonicalModel.id})</option>)}</Select> : <Input onChange={(event) => onChange({ canonicalModelId: event.target.value })} placeholder="Canonical model ID, blank means all models" value={item.canonicalModelId} />}</label><Button onClick={onRemove} variant="danger-outline">Remove entitlement</Button></div>;
}

function ConstraintFields({ item, onChange, onRemove }: { item: DraftConstraint; onChange: (patch: Partial<DraftConstraint>) => void; onRemove: () => void }) { return <div style={{ border: "1px solid var(--border)", borderRadius: 8, display: "grid", gap: 8, padding: 10 }}><div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}><Input aria-label="Parameter" onChange={(event) => onChange({ param: event.target.value })} placeholder="max_tokens" value={item.param} /><Input aria-label="Minimum value" inputMode="decimal" onChange={(event) => onChange({ minValue: event.target.value })} placeholder="Minimum" type="number" value={item.minValue} /><Input aria-label="Maximum value" inputMode="decimal" onChange={(event) => onChange({ maxValue: event.target.value })} placeholder="Maximum" type="number" value={item.maxValue} /><Select aria-label="Violation behavior" onChange={(event) => onChange({ onViolation: event.target.value as "clamp" | "reject" })} value={item.onViolation}><option value="clamp">Clamp</option><option value="reject">Reject</option></Select></div><Button onClick={onRemove} variant="danger-outline">Remove constraint</Button></div>; }

function RevisionHistory({ revisions, canApprove, approvalReason, onApprovalReason, onApprove, approving }: { revisions: Revision[]; canApprove: boolean; approvalReason: string; onApprovalReason: (value: string) => void; onApprove: (id: string) => void; approving: string | null }) { return <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Immutable revision history</h2>{canApprove ? <label className="console-field" style={{ maxWidth: 520 }}><span>Approval reason (optional)</span><Input onChange={(event) => onApprovalReason(event.target.value)} placeholder="Reason recorded with your approval" value={approvalReason} /></label> : <p className="console-muted">Approval is unavailable for this session because it lacks the <span className="cp-mono">policies:approve</span> scope.</p>}<div style={{ display: "grid", gap: 12, marginTop: 12 }}>{revisions.map((revision) => <section aria-labelledby={`revision-${revision.id}`} key={revision.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}><div style={{ alignItems: "start", display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between" }}><div><h3 id={`revision-${revision.id}`} style={{ fontSize: 14, margin: 0 }}><span className="cp-mono">{revision.id}</span> {revision.isActive ? <StatusBadge status="verifying">Current staged revision</StatusBadge> : <StatusBadge status="idle">Historical revision</StatusBadge>}</h3><div className="console-faint">Created {when(revision.createdAt)}{revision.createdBy ? <> by <span className="cp-mono">{revision.createdBy}</span></> : null} · content hash <span className="cp-mono">{revision.contentHash}</span></div></div>{canApprove ? <Button disabled={approving === revision.id} onClick={() => void onApprove(revision.id)} variant="outline">{approving === revision.id ? "Approving" : "Approve revision"}</Button> : null}</div><RevisionConstraints revision={revision} /></section>)}</div></Card>; }

function RevisionConstraints({ revision }: { revision: Revision }) {
  return <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
    <section><h4 style={{ fontSize: 13, margin: 0 }}>Model entitlements ({revision.entitlements.length})</h4>{revision.entitlements.length ? <ul className="console-muted" style={{ marginBottom: 0, marginTop: 4 }}>{revision.entitlements.map((item) => <li key={item.id}><strong>{item.effect}</strong> {item.subjectKind}{item.subjectRef ? `:${item.subjectRef}` : ""} → {item.canonicalModelId ?? item.offeringId ?? "all models"}</li>)}</ul> : <p className="console-faint" style={{ marginBottom: 0 }}>No model entitlements.</p>}</section>
    <section><h4 style={{ fontSize: 13, margin: 0 }}>Request constraints ({revision.requestConstraints.length})</h4>{revision.requestConstraints.length ? <ul className="console-muted" style={{ marginBottom: 0, marginTop: 4 }}>{revision.requestConstraints.map((item) => <li key={item.id}><span className="cp-mono">{item.param}</span>: {item.minValue ?? "−∞"} to {item.maxValue ?? "∞"}, {item.onViolation}</li>)}</ul> : <p className="console-faint" style={{ marginBottom: 0 }}>No request constraints.</p>}</section>
    <section><h4 style={{ fontSize: 13, margin: 0 }}>Data-handling constraints ({revision.dataHandlingConstraints.length})</h4>{revision.dataHandlingConstraints.length ? <ul className="console-muted" style={{ marginBottom: 0, marginTop: 4 }}>{revision.dataHandlingConstraints.map((item) => <li key={item.id}>Capture <span className="cp-mono">{item.captureMode}</span>, regions {Array.isArray(item.allowedRegions) && item.allowedRegions.length ? item.allowedRegions.join(", ") : "all"}, redaction <span className="cp-mono">{JSON.stringify(item.redaction)}</span></li>)}</ul> : <p className="console-faint" style={{ marginBottom: 0 }}>No data-handling constraints.</p>}</section>
    <section><h4 style={{ fontSize: 13, margin: 0 }}>Approvals ({revision.approvals.length})</h4>{revision.approvals.length ? <ul className="console-muted" style={{ marginBottom: 0, marginTop: 4 }}>{revision.approvals.map((approval) => <li key={approval.id}><span className="cp-mono">{approval.approvedBy}</span> {approval.reason ? `— ${approval.reason}` : ""} ({when(approval.createdAt)})</li>)}</ul> : <p className="console-faint" style={{ marginBottom: 0 }}>No approvals recorded.</p>}</section>
  </div>;
}
