"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest } from "@/lib/api-client";
import { capabilityEntries, fidelityLabel, formatLimit, formatMicrousd, hasCompleteCorePrice, stringList, type ModelOffering, type ModelPage } from "./model-types";

const cellStyle = { borderBottom: "1px solid var(--border)", padding: "11px 12px", textAlign: "left" as const, verticalAlign: "top" };
const rowHeight = 126;
const virtualHeight = 560;
const overscan = 5;

function message(error: unknown) { return error instanceof Error ? error.message : "Unable to load models"; }
function optionLabel(value: string) { return value.split(/[-_]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "); }

export function ModelsConsole() {
  const [models, setModels] = useState<ModelOffering[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [family, setFamily] = useState("all");
  const [routable, setRoutable] = useState("all");
  const [fidelity, setFidelity] = useState("all");

  const load = useCallback(async (cursor: string | null, replace: boolean) => {
    replace ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      if (query.trim()) params.set("q", query.trim());
      if (provider !== "all") params.set("provider", provider);
      if (family !== "all") params.set("family", family);
      if (routable !== "all") params.set("routable", routable);
      if (fidelity !== "all") params.set("priceFidelity", fidelity);
      const result = await apiRequest<ModelPage>(`/models?${params}`);
      setModels((current) => replace ? result.data : [...current, ...result.data.filter((item) => !current.some((known) => known.id === item.id))]);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(message(caught));
      if (replace) setModels([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [family, fidelity, provider, query, routable]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(null, true); }, query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const providers = useMemo(() => [...new Set(models.map((model) => model.provider))].sort(), [models]);
  const families = useMemo(() => [...new Set(models.map((model) => model.canonicalModel.family).filter((item): item is string => Boolean(item)))].sort(), [models]);
  return <PageFrame description="Search provider offerings, price provenance, capabilities, and route readiness" title="Models">
    <div style={{ display: "grid", gap: 16 }}>
      {error ? <AlertBanner title="Models could not load" tone="down">{error} <Button onClick={() => void load(null, true)} variant="outline">Retry</Button></AlertBanner> : null}
      <Card style={{ overflow: "hidden" }}>
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, padding: 12 }}>
          <Input aria-label="Search models" onChange={(event) => setQuery(event.target.value)} placeholder="Search name or canonical slug" style={{ flex: "1 1 220px", maxWidth: 360 }} value={query} />
          <Select aria-label="Filter provider" onChange={(event) => setProvider(event.target.value)} value={provider}><option value="all">All providers</option>{providers.map((item) => <option key={item} value={item}>{optionLabel(item)}</option>)}</Select>
          <Select aria-label="Filter family" onChange={(event) => setFamily(event.target.value)} value={family}><option value="all">All families</option>{families.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
          <Select aria-label="Filter routability" onChange={(event) => setRoutable(event.target.value)} value={routable}><option value="all">All routability</option><option value="true">Routable</option><option value="false">Not routable</option></Select>
          <Select aria-label="Filter price fidelity" onChange={(event) => setFidelity(event.target.value)} value={fidelity}><option value="all">All price fidelity</option><option value="provider_verified">Provider verified</option><option value="operator_override">Operator override</option><option value="aggregator">Aggregator</option><option value="unknown">Unknown</option></Select>
          <span style={{ color: "var(--fg-muted)", fontSize: 12, marginLeft: "auto" }}>{models.length} loaded</span>
        </div>
        <p style={{ color: "var(--fg-muted)", fontSize: 12, margin: 0, padding: "0 12px 12px" }}>All filters query the catalog and apply across cursor pages.</p>
        {loading ? <CatalogSkeleton /> : null}
        {!loading && !error && models.length === 0 ? <EmptyState description="No offerings are currently available to this workspace." title="No models found" /> : null}
        {models.length > 0 ? <VirtualModelsTable key={`${query}|${provider}|${family}|${routable}|${fidelity}`} models={models} /> : null}
        {!loading && nextCursor ? <div style={{ display: "flex", justifyContent: "center", padding: 12 }}><Button disabled={loadingMore} onClick={() => void load(nextCursor, false)} variant="outline">{loadingMore ? "Loading models" : "Load more models"}</Button></div> : null}
      </Card>
    </div>
  </PageFrame>;
}

function VirtualModelsTable({ models }: { models: ModelOffering[] }) {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(models.length, start + Math.ceil(virtualHeight / rowHeight) + overscan * 2);
  const windowed = models.slice(start, end);

  return <div aria-label="Model catalog results" data-model-count={models.length} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} role="region" style={{ height: virtualHeight, overflow: "auto" }}>
    <div aria-rowcount={models.length + 1} role="table" style={{ minWidth: 1050 }}>
      <div role="rowgroup" style={{ background: "var(--bg)", position: "sticky", top: 0, zIndex: 1 }}><div role="row" style={{ color: "var(--fg-muted)", display: "grid", fontSize: 12, gridTemplateColumns: "2fr 1fr 1.4fr 1fr 2fr 1.3fr" }}><div role="columnheader" style={cellStyle}>Model</div><div role="columnheader" style={cellStyle}>Provider</div><div role="columnheader" style={cellStyle}>Capabilities</div><div role="columnheader" style={cellStyle}>Limits</div><div role="columnheader" style={cellStyle}>Pricing per MTok</div><div role="columnheader" style={cellStyle}>Route</div></div></div>
      <div role="rowgroup"><div aria-hidden="true" style={{ height: start * rowHeight }} />{windowed.map((model, index) => <VirtualModelRow key={model.id} model={model} rowIndex={start + index + 2} />)}<div aria-hidden="true" style={{ height: (models.length - end) * rowHeight }} /></div>
    </div>
  </div>;
}

function VirtualModelRow({ model, rowIndex }: { model: ModelOffering; rowIndex: number }) {
  const capabilities = capabilityEntries(model.capabilities);
  const pricingKnown = hasCompleteCorePrice(model);
  const cell = { ...cellStyle, display: "block" };
  return <div aria-rowindex={rowIndex} role="row" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.4fr 1fr 2fr 1.3fr", minHeight: rowHeight }}>
    <div role="cell" style={cell}><a href={`/models/${encodeURIComponent(model.id)}`} style={{ color: "var(--accent)", fontWeight: 650 }}>{model.canonicalModel.displayName}</a><div className="cp-mono" style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.providerModelId}</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.canonicalModel.family ?? "Unclassified"}</div></div>
    <div role="cell" style={cell}>{optionLabel(model.provider)}<div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.region ?? "Any region"}</div></div>
    <div role="cell" style={cell}><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{capabilities.slice(0, 3).map(([label, state]) => <Capability key={label} label={label} state={state} />)}{capabilities.length > 3 ? <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>+{capabilities.length - 3}</span> : null}</div></div>
    <div role="cell" style={cell}><div>{formatLimit(model.limits.contextTokens)} context</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{formatLimit(model.limits.outputTokens)} output</div></div>
    <div role="cell" style={cell}>{pricingKnown ? <><div>In {formatMicrousd(model.activePrice?.inputPerMtokMicrousd)}</div><div>Out {formatMicrousd(model.activePrice?.outputPerMtokMicrousd)}</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{fidelityLabel(model.activePrice?.fidelity)} · {model.activePrice?.source ?? "No provenance"}</div></> : <><div style={{ fontWeight: 650 }}>Unknown pricing</div><div style={{ color: "var(--down)", fontSize: 12, marginTop: 4 }}>Hard-budget ineligible</div></>}</div>
    <div role="cell" style={cell}><StatusBadge status={model.routable ? "up" : "idle"}>{model.routable ? "Routable" : "Credential needed"}</StatusBadge><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6 }}>{stringList(model.endpointKinds).join(", ") || "No endpoints reported"}</div></div>
  </div>;
}

function ModelRow({ model }: { model: ModelOffering }) {
  const capabilities = capabilityEntries(model.capabilities);
  const pricingKnown = hasCompleteCorePrice(model);
  return <tr style={{ height: rowHeight }}>
    <td style={cellStyle}><a href={`/models/${encodeURIComponent(model.id)}`} style={{ color: "var(--accent)", fontWeight: 650 }}>{model.canonicalModel.displayName}</a><div className="cp-mono" style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.providerModelId}</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.canonicalModel.family ?? "Unclassified"}</div></td>
    <td style={cellStyle}>{optionLabel(model.provider)}<div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{model.region ?? "Any region"}</div></td>
    <td style={cellStyle}><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{capabilities.slice(0, 3).map(([label, state]) => <Capability key={label} label={label} state={state} />)}{capabilities.length > 3 ? <span style={{ color: "var(--fg-muted)", fontSize: 12 }}>+{capabilities.length - 3}</span> : null}</div></td>
    <td style={cellStyle}><div>{formatLimit(model.limits.contextTokens)} context</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{formatLimit(model.limits.outputTokens)} output</div></td>
    <td style={cellStyle}>{pricingKnown ? <><div>In {formatMicrousd(model.activePrice?.inputPerMtokMicrousd)}</div><div>Out {formatMicrousd(model.activePrice?.outputPerMtokMicrousd)}</div><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{fidelityLabel(model.activePrice?.fidelity)} · {model.activePrice?.source ?? "No provenance"}</div></> : <><div style={{ fontWeight: 650 }}>Unknown pricing</div><div style={{ color: "var(--down)", fontSize: 12, marginTop: 4 }}>Hard-budget ineligible</div></>}</td>
    <td style={cellStyle}><StatusBadge status={model.routable ? "up" : "idle"}>{model.routable ? "Routable" : "Credential needed"}</StatusBadge><div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6 }}>{stringList(model.endpointKinds).join(", ") || "No endpoints reported"}</div></td>
  </tr>;
}

function Capability({ label, state }: { label: string; state: string }) { const color = state === "supported" ? "var(--up)" : state === "unsupported" ? "var(--fg-muted)" : "var(--verifying)"; return <span title={`${label}: ${state}`} style={{ border: "1px solid var(--border)", borderRadius: 999, color, fontSize: 11, padding: "2px 6px" }}>{label}: {state}</span>; }
function CatalogSkeleton() { return <div style={{ display: "grid", gap: 8, padding: 12 }}><Skeleton style={{ height: 54 }} /><Skeleton style={{ height: 54 }} /><Skeleton style={{ height: 54 }} /></div>; }
