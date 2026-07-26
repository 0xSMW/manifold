"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import { capabilityEntries, fidelityLabel, formatLimit, formatMicrousd, hasCompleteCorePrice, stringList, type ModelOffering } from "./model-types";

export function ModelDetail({ modelId }: { modelId: string }) {
  const toast = useToast();
  const [model, setModel] = useState<ModelOffering | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [me, setMe] = useState<{ scopes: string[] } | null>(null);
  const [profileId, setProfileId] = useState("");
  const [preview, setPreview] = useState<{ profile: { hostname: string; available: boolean }; data: Array<{ model: string; endpointKind: string; provider: string; providerModelId: string }>; note: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [overrideInput, setOverrideInput] = useState("");
  const [overrideOutput, setOverrideOutput] = useState("");
  const [overriding, setOverriding] = useState(false);
  const load = useCallback(async () => {
    setError(null); setNotFound(false); setModel(undefined);
    try { setModel(await apiRequest<ModelOffering>(`/models/${encodeURIComponent(modelId)}`)); }
    catch (caught) { setNotFound(caught instanceof ControlPlaneApiError && caught.status === 404); setError(caught instanceof Error ? caught.message : "Unable to load model"); setModel(null); }
  }, [modelId]);
  useEffect(() => { void load(); void apiRequest<{ scopes: string[] }>("/me").then(setMe).catch(() => setMe({ scopes: [] })); }, [load]);
  if (model === undefined) return <PageFrame description="Loading model offering" title="Model"><Card style={{ padding: 16 }}><Skeleton style={{ height: 144 }} /></Card></PageFrame>;
  if (model === null) return <PageFrame description="Provider model offering details" title="Model">{!notFound ? <AlertBanner title="Model could not load" tone="down">{error} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner> : <EmptyState action={<a className="cp-button" href="/models">Back to models</a>} description="The offering may have been removed or is outside this workspace." title="Model not found" />}</PageFrame>;
  const completePrice = hasCompleteCorePrice(model);
  const price = model.activePrice;
  const canOverride = Boolean(me?.scopes.includes("registry:write"));
  const runPreview = async () => { if (!profileId.trim()) { setPreviewError("Enter an ingress profile ID."); return; } setPreviewError(null); setPreview(null); try { setPreview(await apiRequest(`/models/preview?profileId=${encodeURIComponent(profileId.trim())}`)); } catch (caught) { setPreviewError(caught instanceof Error ? caught.message : "Preview could not load"); } };
  const override = async () => { if (!/^\d+$/.test(overrideInput) || !/^\d+$/.test(overrideOutput)) { toast("Input and output prices must be non-negative integer microdollars", "down"); return; } setOverriding(true); try { await apiRequest("/models/overrides", { method: "POST", body: { offeringId: model.id, inputPerMtokMicrousd: overrideInput, outputPerMtokMicrousd: overrideOutput } }); toast("Operator price override staged for Publish", "verifying"); await load(); } catch (caught) { toast(caught instanceof Error ? caught.message : "Override could not be saved", "down"); } finally { setOverriding(false); } };
  return <PageFrame actions={<a className="cp-button" href="/models">Back to models</a>} description="Provider offering, capability matrix, limits, and price provenance" title={model.canonicalModel.displayName}>
    <div style={{ display: "grid", gap: 16 }}>
      {!completePrice ? <AlertBanner title="Hard-budget ineligible" tone="down">Input and output pricing with known fidelity are required before this offering can participate in a hard budget.</AlertBanner> : null}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Offering</h2><dl style={{ display: "grid", gap: 12, margin: 0 }}><Value label="Canonical slug" mono value={model.canonicalModel.slug} /><Value label="Provider model ID" mono value={model.providerModelId} /><Value label="Provider" value={model.provider} /><Value label="Family" value={model.canonicalModel.family ?? "Unclassified"} /><Value label="Region" value={model.region ?? "Any region"} /><Value label="Adapter revision" mono value={model.adapterRevision} /></dl></Card>
        <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Routing and limits</h2><dl style={{ display: "grid", gap: 12, margin: 0 }}><div><dt style={{ color: "var(--fg-muted)", fontSize: 12 }}>Routability</dt><dd style={{ margin: "5px 0 0" }}><StatusBadge status={model.routable ? "up" : "idle"}>{model.routable ? "Routable" : "Credential needed"}</StatusBadge></dd></div><Value label="Endpoint kinds" value={stringList(model.endpointKinds).join(", ") || "No endpoints reported"} /><Value label="Context limit" value={`${formatLimit(model.limits.contextTokens)} tokens`} /><Value label="Output limit" value={`${formatLimit(model.limits.outputTokens)} tokens`} /></dl></Card>
      </div>
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Capabilities</h2><div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>{capabilityEntries(model.capabilities).map(([label, state]) => <div key={label} style={{ border: "1px solid var(--border)", borderRadius: 6, display: "flex", justifyContent: "space-between", padding: "9px 10px" }}><span>{label}</span><span style={{ color: state === "supported" ? "var(--up)" : state === "unknown" ? "var(--verifying)" : "var(--fg-muted)" }}>{state}</span></div>)}</div></Card>
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Pricing</h2>{price ? <><dl style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", margin: 0 }}><Value label="Input per MTok" value={formatMicrousd(price.inputPerMtokMicrousd)} /><Value label="Output per MTok" value={formatMicrousd(price.outputPerMtokMicrousd)} /><Value label="Fidelity" value={fidelityLabel(price.fidelity)} /><Value label="Provenance" value={price.source ?? "Unknown"} /><Value label="Effective from" value={formatDate(price.effectiveFrom)} /></dl><p style={{ color: "var(--fg-muted)", fontSize: 12, margin: "16px 0 0" }}>All displayed prices are exact microdollars per million tokens. Missing price classes remain unknown.</p></> : <p style={{ color: "var(--fg-muted)", margin: 0 }}>No active price revision is available. This offering is hard-budget ineligible.</p>}{canOverride ? <div style={{ borderTop: "1px solid var(--border)", display: "grid", gap: 8, marginTop: 16, paddingTop: 16 }}><strong>Operator price override</strong><p className="console-muted" style={{ margin: 0 }}>Creates an immutable workspace-scoped price revision. The new price is staged and does not change a gateway until Publish.</p><div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><label className="console-field"><span>Input µUSD / MTok</span><Input inputMode="numeric" onChange={(event) => setOverrideInput(event.target.value)} value={overrideInput} /></label><label className="console-field"><span>Output µUSD / MTok</span><Input inputMode="numeric" onChange={(event) => setOverrideOutput(event.target.value)} value={overrideOutput} /></label></div><div><Button disabled={overriding} onClick={() => void override()} variant="outline">{overriding ? "Saving override" : "Stage price override"}</Button></div></div> : null}</Card>
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 8px" }}>/v1/models profile preview</h2><p className="console-muted">Shows names from current staged route revisions for one ingress profile. The actual gateway response comes only from its published signed snapshot.</p><div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 8 }}><label className="console-field" style={{ flex: "1 1 260px" }}><span>Ingress profile ID</span><Input onChange={(event) => setProfileId(event.target.value)} placeholder="prof_…" value={profileId} /></label><Button onClick={() => void runPreview()} variant="outline">Preview</Button></div>{previewError ? <AlertBanner title="Preview unavailable" tone="down">{previewError}</AlertBanner> : null}{preview ? <div style={{ marginTop: 12 }}><p className="console-muted">{preview.profile.hostname} · {preview.profile.available ? "available" : "disabled"}</p>{preview.data.length ? <ul className="console-muted">{preview.data.map((item) => <li key={`${item.endpointKind}:${item.model}`}><span className="cp-mono">{item.model}</span> · {item.endpointKind} · {item.provider}/{item.providerModelId}</li>)}</ul> : <p className="console-muted">No staged routes expose a model for this profile’s installation.</p>}<p className="console-muted">{preview.note}</p></div> : null}</Card>
    </div>
  </PageFrame>;
}

function Value({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt style={{ color: "var(--fg-muted)", fontSize: 12 }}>{label}</dt><dd className={mono ? "cp-mono" : undefined} style={{ margin: "5px 0 0", overflowWrap: "anywhere" }}>{value}</dd></div>; }
function formatDate(value: string | null) { if (!value) return "Unknown"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
