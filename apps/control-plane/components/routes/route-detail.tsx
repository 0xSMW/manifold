"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest } from "@/lib/api-client";
import type { Offering, PageResult, ProviderCredential, RouteDetailResponse, RouteRevision, RouteTarget, RouteTestProfile, RouteTestResponse } from "./route-types";

type DraftTarget = Pick<RouteTarget, "providerCredentialId" | "offeringId" | "baseUrl" | "region" | "weight" | "priority">;
type RevisionForm = { mode: "ordered" | "weighted"; targets: DraftTarget[]; maxAttempts: string; backoffMs: string; connectMs: string; firstByteMs: string; overallMs: string; capturePolicy: string };
const field = { display: "grid", fontSize: 12, fontWeight: 650, gap: 6 };

const number = (value: unknown, fallback: number) => typeof value === "number" ? value : fallback;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const targetDraft = (target: RouteTarget): DraftTarget => ({ providerCredentialId: target.providerCredentialId, offeringId: target.offeringId, baseUrl: target.baseUrl, region: target.region, weight: target.weight, priority: target.priority });
function formFrom(revision: RouteRevision): RevisionForm {
  const retry = revision.retryPolicy;
  const timeout = revision.timeoutPolicy;
  return { mode: revision.mode, targets: revision.targets.map(targetDraft), maxAttempts: String(number(retry.max_attempts, 1)), backoffMs: String(number(retry.backoff_ms, 0)), connectMs: String(number(timeout.connect_ms, 0)), firstByteMs: String(number(timeout.first_byte_ms, 0)), overallMs: String(number(timeout.overall_ms, 60000)), capturePolicy: revision.capturePolicy ? JSON.stringify(revision.capturePolicy) : "" };
}
function endpointKinds(offering: Offering): string[] { return Array.isArray(offering.endpointKinds) ? offering.endpointKinds.filter((item): item is string => typeof item === "string") : []; }
function message(error: unknown) { return error instanceof Error ? error.message : "Request failed"; }

export function RouteDetail({ routeId }: { routeId: string }) {
  const toast = useToast();
  const [route, setRoute] = useState<RouteDetailResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [draft, setDraft] = useState<RevisionForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [testProfiles, setTestProfiles] = useState<RouteTestProfile[]>([]);
  const [testProfileId, setTestProfileId] = useState("");
  const [testResult, setTestResult] = useState<RouteTestResponse | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [leftRevision, setLeftRevision] = useState("");
  const [rightRevision, setRightRevision] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextRoute, providers, models] = await Promise.all([
        apiRequest<RouteDetailResponse>(`/routes/${routeId}`),
        apiRequest<PageResult<ProviderCredential>>("/providers"),
        apiRequest<PageResult<Offering>>("/models?limit=100"),
      ]);
      setRoute(nextRoute);
      setCredentials(providers.data);
      setOfferings(models.data);
      try {
        const profiles = await apiRequest<PageResult<RouteTestProfile>>(`/profiles?installationId=${encodeURIComponent(nextRoute.installationId)}`);
        const publishedProfiles = profiles.data.filter((profile) => profile.published && profile.available);
        setTestProfiles(publishedProfiles);
        setTestProfileId((current) => publishedProfiles.some((profile) => profile.id === current) ? current : publishedProfiles.length === 1 ? publishedProfiles[0].id : "");
      } catch { setTestProfiles([]); setTestProfileId(""); }
      const active = nextRoute.revisions.find((item) => item.isActive) ?? nextRoute.revisions[0];
      setDraft(active ? formFrom(active) : null);
      setLeftRevision(active?.id ?? "");
      setRightRevision(nextRoute.revisions.find((item) => item.id !== active?.id)?.id ?? active?.id ?? "");
    } catch (caught) { setError(message(caught)); setRoute(null); }
  }, [routeId]);
  useEffect(() => { void load(); }, [load]);

  const revisions = route?.revisions ?? [];
  const compared = useMemo(() => [revisions.find((item) => item.id === leftRevision), revisions.find((item) => item.id === rightRevision)] as const, [leftRevision, revisions, rightRevision]);
  const compatibleOfferings = (credentialId: string) => {
    const provider = credentials.find((item) => item.id === credentialId)?.provider;
    return offerings.filter((item) => item.provider === provider && route && endpointKinds(item).includes(route.endpointKind));
  };
  const updateTarget = (index: number, patch: Partial<DraftTarget>) => setDraft((current) => current ? { ...current, targets: current.targets.map((target, targetIndex) => targetIndex === index ? { ...target, ...patch } : target) } : current);
  const stageRevision = async () => {
    if (!draft || !route) return;
    let capturePolicy: Record<string, unknown> | null = null;
    try { capturePolicy = draft.capturePolicy.trim() ? JSON.parse(draft.capturePolicy) as Record<string, unknown> : null; } catch { setError("Capture policy must be valid JSON"); return; }
    setSaving(true); setError(null);
    try {
      await apiRequest(`/routes/${route.id}/revisions`, { method: "POST", body: { mode: draft.mode, targets: draft.targets.map((target) => ({ ...target, baseUrl: target.baseUrl || null, region: target.region || null, weight: Number(target.weight), priority: Number(target.priority) })), retryPolicy: { maxAttempts: Number(draft.maxAttempts), backoffMs: Number(draft.backoffMs), retryOn: [] }, timeoutPolicy: { connectMs: Number(draft.connectMs), firstByteMs: Number(draft.firstByteMs), overallMs: Number(draft.overallMs) }, capturePolicy } });
      toast("Staged successor revision", "verifying");
      await load();
    } catch (caught) { setError(message(caught)); } finally { setSaving(false); }
  };
  const runTest = async () => {
    if (!route) return;
    setTestResult(null);
    try { setTestResult(await apiRequest<RouteTestResponse>(`/routes/${route.id}/test`, { method: "POST", body: testProfileId ? { profileId: testProfileId } : {} })); } catch (caught) { setError(message(caught)); }
  };
  const disable = async () => {
    if (!route) return;
    try { await apiRequest(`/routes/${route.id}`, { method: "DELETE" }); toast("Route disabled and awaiting publish", "verifying"); setDisableOpen(false); await load(); } catch (caught) { setError(message(caught)); }
  };

  if (route === undefined) return <PageFrame description="Loading route" title="Route"><Card style={{ padding: 16 }}><Skeleton style={{ height: 120 }} /></Card></PageFrame>;
  if (route === null) return <PageFrame description="Route lifecycle" title="Route">{error ? <AlertBanner title="Route could not load" tone="down">{error} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner> : <EmptyState action={<a className="cp-button" href="/routes">Back to routes</a>} description="The route may have been removed or is outside this workspace." title="Route not found" />}</PageFrame>;
  const active = revisions.find((item) => item.isActive);
  return <PageFrame actions={<div style={{ display: "flex", gap: 8 }}><Button disabled={route.status === "disabled" || (testProfiles.length > 1 && !testProfileId)} onClick={() => void runTest()} variant="outline">Test route</Button><a className="cp-button" data-variant="primary" href="/publish">Publish</a></div>} description={`Installation: ${route.installationName}`} title={route.publicName}>
    <div style={{ display: "grid", gap: 16 }}>
      {error ? <AlertBanner title="Route action failed" tone="down">{error}</AlertBanner> : null}
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Synthetic test</h2><p style={{ color: "var(--fg-muted)", marginTop: 0 }}>Runs one bounded request through the published gateway route</p>{testProfiles.length > 1 ? <label style={field}>Published ingress profile<Select onChange={(event) => setTestProfileId(event.target.value)} value={testProfileId}><option value="">Select profile</option>{testProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.hostname} ({profile.mode})</option>)}</Select></label> : testProfiles.length === 1 ? <p style={{ color: "var(--fg-muted)", margin: 0 }}>Using published profile {testProfiles[0].hostname}</p> : <p style={{ color: "var(--fg-muted)", margin: 0 }}>Publish this route to an ingress profile before testing it</p>}{testResult ? <AlertBanner title={testResult.status === "completed" ? "Synthetic test completed" : "Gateway returned an error"} tone={testResult.status === "completed" ? "up" : "down"}>{testResult.profile.hostname} returned HTTP {testResult.gatewayStatus}.{testResult.logsHref ? <> <a href={testResult.logsHref} style={{ color: "var(--accent)", textDecoration: "underline" }}>Open trace {testResult.traceId ?? "in Logs"}</a></> : null}{testResult.responseTruncated ? " Response details were truncated." : ""}</AlertBanner> : null}</Card>
      <AlertBanner title={route.status === "disabled" ? "Route disabled" : "Staged revision"} tone="verifying">{route.status === "disabled" ? "This disable is staged. Publish applies the removal to the installation." : "Changes are staged. Publish applies the current revision to the installation."}</AlertBanner>
      <Card style={{ padding: 16 }}><div style={{ alignItems: "center", display: "flex", gap: 12, justifyContent: "space-between" }}><div><div style={{ color: "var(--fg-muted)", fontSize: 12 }}>Endpoint</div><div className="cp-mono">{route.endpointKind}</div></div><StatusBadge status={route.status === "disabled" ? "down" : "verifying"}>{route.status === "disabled" ? "Disabled" : "Staged"}</StatusBadge><Button disabled={route.status === "disabled"} onClick={() => setDisableOpen(true)} variant="danger-outline">Disable route</Button></div></Card>
      {active && draft && route.status !== "disabled" ? <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Stage successor</h2><p style={{ color: "var(--fg-muted)", marginTop: 0 }}>Revisions are immutable. Save creates a successor from this editable draft.</p><RevisionEditor credentials={credentials} draft={draft} endpointKind={route.endpointKind} offerings={offerings} setDraft={setDraft} updateTarget={updateTarget} /><div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}><Button disabled={saving} onClick={() => setDraft(formFrom(active))}>Reset draft</Button><Button disabled={saving || draft.targets.length === 0} onClick={() => void stageRevision()} variant="primary">{saving ? "Staging revision" : "Stage successor"}</Button></div></Card> : null}
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Revision history</h2><div style={{ display: "grid", gap: 12 }}>{revisions.map((revision) => <RevisionCard key={revision.id} revision={revision} />)}</div></Card>
      {revisions.length > 1 ? <Card style={{ padding: 16 }}><h2 style={{ fontSize: 16, marginTop: 0 }}>Compare revisions</h2><div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}><Select aria-label="Base revision" onChange={(event) => setLeftRevision(event.target.value)} value={leftRevision}>{revisions.map((item, index) => <option key={item.id} value={item.id}>Revision {revisions.length - index}{item.isActive ? " current" : ""}</option>)}</Select><Select aria-label="Comparison revision" onChange={(event) => setRightRevision(event.target.value)} value={rightRevision}>{revisions.map((item, index) => <option key={item.id} value={item.id}>Revision {revisions.length - index}{item.isActive ? " current" : ""}</option>)}</Select></div><RevisionDiff left={compared[0]} right={compared[1]} /></Card> : null}
    </div>
    <ConfirmDialog confirmLabel="Disable route" confirmText={route.publicName} description="This stages the route for removal. Publish is still required before traffic changes." onClose={() => setDisableOpen(false)} onConfirm={() => void disable()} open={disableOpen} title="Disable route" />
  </PageFrame>;
}

function RevisionEditor({ credentials, draft, endpointKind, offerings, setDraft, updateTarget }: { credentials: ProviderCredential[]; draft: RevisionForm; endpointKind: string; offerings: Offering[]; setDraft: React.Dispatch<React.SetStateAction<RevisionForm | null>>; updateTarget: (index: number, patch: Partial<DraftTarget>) => void }) {
  const validCredentials = credentials.filter((item) => item.status === "valid");
  return <div style={{ display: "grid", gap: 16 }}><label style={field}>Mode<Select onChange={(event) => setDraft((current) => current ? { ...current, mode: event.target.value as RevisionForm["mode"] } : current)} value={draft.mode}><option value="ordered">Ordered</option><option value="weighted">Weighted</option></Select></label><div style={{ display: "grid", gap: 10 }}><strong style={{ fontSize: 13 }}>Targets</strong>{draft.targets.map((target, index) => { const provider = credentials.find((item) => item.id === target.providerCredentialId)?.provider; const options = offerings.filter((item) => item.provider === provider && endpointKinds(item).includes(endpointKind)); return <Card key={`${target.providerCredentialId}-${index}`} style={{ padding: 12 }}><div style={{ display: "grid", gap: 10 }}><div style={{ display: "flex", justifyContent: "space-between" }}><strong style={{ fontSize: 13 }}>Target {index + 1}</strong><Button disabled={draft.targets.length === 1} onClick={() => setDraft((current) => current ? { ...current, targets: current.targets.filter((_, targetIndex) => targetIndex !== index) } : current)} variant="ghost">Remove</Button></div><label style={field}>Credential<Select onChange={(event) => { const nextCredentialId = event.target.value; const first = offerings.find((item) => item.provider === credentials.find((credential) => credential.id === nextCredentialId)?.provider && endpointKinds(item).includes(endpointKind)); updateTarget(index, { providerCredentialId: nextCredentialId, offeringId: first?.id ?? "" }); }} value={target.providerCredentialId}>{validCredentials.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.provider})</option>)}</Select></label><label style={field}>Offering<Select onChange={(event) => updateTarget(index, { offeringId: event.target.value })} value={target.offeringId}>{options.map((item) => <option key={item.id} value={item.id}>{item.canonicalModel.displayName} ({item.providerModelId})</option>)}</Select></label><div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}><label style={field}>Weight<Input min="0" onChange={(event) => updateTarget(index, { weight: Number(event.target.value) })} type="number" value={target.weight} /></label><label style={field}>Priority<Input min="0" onChange={(event) => updateTarget(index, { priority: Number(event.target.value) })} type="number" value={target.priority} /></label></div><label style={field}>Base URL<Input onChange={(event) => updateTarget(index, { baseUrl: event.target.value })} placeholder="Provider default" value={target.baseUrl ?? ""} /></label><label style={field}>Region<Input onChange={(event) => updateTarget(index, { region: event.target.value })} placeholder="Optional region" value={target.region ?? ""} /></label></div></Card>; })}<Button onClick={() => setDraft((current) => current && validCredentials[0] ? { ...current, targets: [...current.targets, { providerCredentialId: validCredentials[0].id, offeringId: offerings.find((item) => item.provider === validCredentials[0].provider && endpointKinds(item).includes(endpointKind))?.id ?? "", baseUrl: null, region: null, weight: 1, priority: 0 }] } : current)} variant="outline">Add target</Button></div><div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(3, 1fr)" }}><NumberField label="Max attempts" onChange={(value) => setDraft((current) => current ? { ...current, maxAttempts: value } : current)} value={draft.maxAttempts} /><NumberField label="Backoff ms" onChange={(value) => setDraft((current) => current ? { ...current, backoffMs: value } : current)} value={draft.backoffMs} /><NumberField label="Overall timeout ms" onChange={(value) => setDraft((current) => current ? { ...current, overallMs: value } : current)} value={draft.overallMs} /><NumberField label="Connect timeout ms" onChange={(value) => setDraft((current) => current ? { ...current, connectMs: value } : current)} value={draft.connectMs} /><NumberField label="First byte timeout ms" onChange={(value) => setDraft((current) => current ? { ...current, firstByteMs: value } : current)} value={draft.firstByteMs} /></div><label style={field}>Capture policy JSON<Input onChange={(event) => setDraft((current) => current ? { ...current, capturePolicy: event.target.value } : current)} placeholder='{"mode":"metadata"}' value={draft.capturePolicy} /></label></div>;
}
function NumberField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) { return <label style={field}>{label}<Input min="0" onChange={(event) => onChange(event.target.value)} type="number" value={value} /></label>; }
function RevisionCard({ revision }: { revision: RouteRevision }) { return <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12 }}><div style={{ alignItems: "center", display: "flex", gap: 10, justifyContent: "space-between" }}><strong>Revision {new Date(revision.createdAt).toLocaleString()}</strong>{revision.isActive ? <StatusBadge status="verifying">Current staged revision</StatusBadge> : <StatusBadge status="idle">Historical revision</StatusBadge>}</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 8 }}>Content hash <span className="cp-mono">{revision.contentHash}</span></div><div style={{ display: "grid", gap: 6, marginTop: 10 }}>{revision.targets.map((target) => <div key={target.id} style={{ alignItems: "center", display: "flex", gap: 8, flexWrap: "wrap" }}><strong>{target.credentialLabel}</strong><span>{target.providerModelId}</span><StatusBadge status={target.healthState === "healthy" ? "up" : target.healthState === "unhealthy" ? "down" : "idle"}>{target.healthState ?? "unknown health"}</StatusBadge><span style={{ color: "var(--fg-muted)" }}>{target.weight} weight, priority {target.priority}{target.region ? `, ${target.region}` : ""}</span></div>)}</div></div>; }
function RevisionDiff({ left, right }: { left?: RouteRevision; right?: RouteRevision }) { if (!left || !right) return null; const rows = [["Mode", left.mode, right.mode], ["Targets", String(left.targets.length), String(right.targets.length)], ["Retry policy", JSON.stringify(left.retryPolicy), JSON.stringify(right.retryPolicy)], ["Timeout policy", JSON.stringify(left.timeoutPolicy), JSON.stringify(right.timeoutPolicy)], ["Capture policy", JSON.stringify(left.capturePolicy), JSON.stringify(right.capturePolicy)]]; return <div style={{ display: "grid", gap: 8, marginTop: 16 }}>{rows.map(([label, from, to]) => <div key={label} style={{ borderTop: "1px solid var(--border)", display: "grid", gap: 6, gridTemplateColumns: "130px 1fr 1fr", paddingTop: 8 }}><span style={{ color: "var(--fg-muted)" }}>{label}</span><span className="cp-mono" style={{ color: from === to ? "var(--fg-muted)" : "var(--down)", overflowWrap: "anywhere" }}>{from}</span><span className="cp-mono" style={{ color: from === to ? "var(--fg-muted)" : "var(--up)", overflowWrap: "anywhere" }}>{to}</span></div>)}</div>; }
