"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Sheet } from "@/components/ui/overlay";
import { StatusBadge, type Status } from "@/components/ui/status";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

type AuditTarget = { kind: string | null; id: string | null };
type AuditEvent = {
  id: string;
  actor: { kind: string; id: string | null };
  action: string;
  target: AuditTarget | null;
  hashes: { before: string | null; after: string | null };
  outcome: string | null;
  links: { requestRef: string | null; profileId: string | null; target: AuditTarget | null };
  createdAt: string;
  chain: { version: 1; previousHash: string | null; hash: string; sealedAt: string } | null;
  chainVerification: { status: "sealed" | "legacy_unsealed"; reason: string };
  compaction: { status: "not_applicable" };
};

type PolicyDecision = {
  kind: "policy_decision";
  id: string;
  outcome: string;
  reasonCodes: string[];
  target: AuditTarget | null;
  links: { requestId: string; traceId: string | null; policyRevisionId: string | null; subject: null; model: null };
  createdAt: string;
};

type AuditTimelineItem = ({ kind: "audit_event" } & AuditEvent) | PolicyDecision;

type AuditPageResponse = {
  data: AuditTimelineItem[];
  nextCursor: string | null;
  capabilities: {
    chainVerification: "available";
    destinations: "available";
    compaction: "not_applicable";
  };
};

type Filters = {
  actor: string;
  action: string;
  hash: string;
  outcome: string;
  from: string;
  to: string;
  profileId: string;
  targetKind: string;
  targetId: string;
};

const emptyFilters: Filters = { actor: "", action: "", hash: "", outcome: "", from: "", to: "", profileId: "", targetKind: "", targetId: "" };

function errorMessage(error: unknown) {
  if (error instanceof ControlPlaneApiError) return error.message;
  return error instanceof Error ? error.message : "Unable to load audit events";
}

function asApiTime(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function short(value: string | null) {
  if (!value) return "—";
  return value.length > 22 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value;
}

function outcomeStatus(outcome: string | null): Status {
  if (outcome === "allow" || outcome === "ok" || outcome === "valid" || outcome === "accepted") return "up";
  if (outcome === "deny" || outcome === "error" || outcome === "invalid" || outcome === "rejected") return "down";
  return outcome ? "verifying" : "idle";
}

function queryFor(filters: Filters, cursor: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.hash.trim()) params.set("hash", filters.hash.trim());
  if (filters.outcome.trim()) params.set("outcome", filters.outcome.trim());
  if (filters.profileId.trim()) params.set("profileId", filters.profileId.trim());
  if (filters.targetKind.trim()) params.set("targetKind", filters.targetKind.trim());
  if (filters.targetId.trim()) params.set("targetId", filters.targetId.trim());
  const from = asApiTime(filters.from);
  const to = asApiTime(filters.to);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

export function AuditConsole() {
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(emptyFilters);
  const [events, setEvents] = useState<AuditTimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AuditPageResponse["capabilities"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [verification, setVerification] = useState<{ verified: boolean; checked: number; legacy: number; firstFailure?: { id: string; reason: string } } | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<Array<{ id: string; kind: string; label: string; status: string; delivery?: { state: string; pending: number; processing: number; delivered: number; dead: number } }>>([]);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const loadDestinations = useCallback(async () => {
    try { setDestinations((await apiRequest<{ data: Array<{ id: string; kind: string; label: string; status: string; delivery?: { state: string; pending: number; processing: number; delivered: number; dead: number } }> }>("/audit/destinations")).data); setDestinationError(null); }
    catch (caught) { setDestinationError(errorMessage(caught)); }
  }, []);

  const load = useCallback(async (cursor: string | null, replace: boolean, activeFilters = appliedFilters) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const result = await apiRequest<AuditPageResponse>(`/audit?${queryFor(activeFilters, cursor).toString()}`);
      setEvents((current) => replace ? result.data : [...current, ...result.data.filter((event) => !current.some((known) => known.kind === event.kind && known.id === event.id))]);
      setNextCursor(result.nextCursor);
      setCapabilities(result.capabilities);
    } catch (caught) {
      setError(errorMessage(caught));
      if (replace) {
        setEvents([]);
        setNextCursor(null);
        setCapabilities(null);
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [appliedFilters]);

  useEffect(() => { void load(null, true); }, [load]);
  useEffect(() => { void loadDestinations(); }, [loadDestinations]);

  const verify = useCallback(async () => {
    setVerificationError(null);
    try { setVerification((await apiRequest<{ data: { verified: boolean; checked: number; legacy: number; firstFailure?: { id: string; reason: string } } }>("/audit/verify")).data); }
    catch (caught) { setVerificationError(errorMessage(caught)); }
  }, []);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setSelected(null);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const result = await apiRequest<{ data: AuditEvent }>(`/audit/${encodeURIComponent(id)}`);
      setSelected(result.data);
    } catch (caught) {
      setDetailError(errorMessage(caught));
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const activeFilterCount = useMemo(() => Object.values(appliedFilters).filter(Boolean).length, [appliedFilters]);
  const apply = () => {
    setAppliedFilters(filters);
  };
  const clear = () => {
    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  };

  return <PageFrame description="Search the append-only record of workspace decisions and mutations" title="Audit">
    <div className="console-stack" style={{ gap: 16 }}>
      <CapabilityState capabilities={capabilities} destinations={destinations} onVerify={verify} verification={verification} verificationError={verificationError} />
      <DestinationManager destinations={destinations} error={destinationError} onChanged={loadDestinations} />
      {error ? <AlertBanner title="Audit timeline unavailable" tone="down">{error} <Button onClick={() => void load(null, true)} variant="outline">Retry</Button></AlertBanner> : null}
      <Card style={{ overflow: "hidden" }}>
        <FilterBar filters={filters} onApply={apply} onChange={setFilters} onClear={clear} />
        {loading ? <TimelineSkeleton /> : null}
        {!loading && !error && events.length === 0 ? <EmptyState description={activeFilterCount ? "Try broadening or clearing the active filters." : "Audit events will appear here as the workspace records activity."} title={activeFilterCount ? "No audit events match" : "No audit events yet"} action={activeFilterCount ? <Button onClick={clear} variant="outline">Clear filters</Button> : undefined} /> : null}
        {!loading && events.length > 0 ? <Timeline events={events} onOpen={openDetail} /> : null}
        {!loading && nextCursor ? <div style={{ display: "flex", justifyContent: "center", padding: 12 }}><Button disabled={loadingMore} onClick={() => void load(nextCursor, false)} variant="outline">{loadingMore ? "Loading older events" : "Load older events"}</Button></div> : null}
      </Card>
    </div>
    <AuditDetail error={detailError} event={selected} loading={loadingDetail} onClose={() => setSelectedId(null)} open={selectedId !== null} />
  </PageFrame>;
}

function DestinationManager({ destinations, error, onChanged }: { destinations: Array<{ id: string; kind: string; label: string; status: string; delivery?: { state: string } }>; error: string | null; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState("webhook"); const [label, setLabel] = useState(""); const [endpoint, setEndpoint] = useState(""); const [secret, setSecret] = useState(""); const [editing, setEditing] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const create = async () => { setBusy("create"); try { if (editing) await apiRequest(`/audit/destinations/${encodeURIComponent(editing)}`, { method: "PATCH", body: { label } }); else await apiRequest("/audit/destinations", { method: "POST", body: { kind, label, endpoint, secret: secret || null } }); setLabel(""); setEndpoint(""); setSecret(""); setEditing(null); await onChanged(); } finally { setBusy(null); } };
  const disable = async (id: string) => { setBusy(id); try { await apiRequest(`/audit/destinations/${encodeURIComponent(id)}`, { method: "DELETE" }); await onChanged(); } finally { setBusy(null); } };
  return <Card className="console-card-body"><div className="console-kpi-label">Audit delivery destinations</div><div style={{ display: "grid", gap: 8, gridTemplateColumns: "130px minmax(140px,1fr) minmax(220px,2fr) minmax(180px,1fr) auto", marginTop: 10 }}><select aria-label="Destination kind" className="cp-input" disabled={!!editing} onChange={(event) => setKind(event.target.value)} value={kind}><option value="webhook">Webhook</option><option value="siem">SIEM</option></select><Input aria-label="Destination label" maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="Label" value={label} /><Input aria-label="HTTPS endpoint" disabled={!!editing} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://collector.example/events" value={endpoint} /><Input aria-label="Signing secret" disabled={!!editing} onChange={(event) => setSecret(event.target.value)} placeholder="Optional signing secret" type="password" value={secret} /><Button disabled={busy !== null || !label.trim() || (!editing && !endpoint.trim())} onClick={() => void create()} variant="primary">{busy === "create" ? "Saving" : editing ? "Save" : "Add"}</Button></div>{error ? <p style={{ color: "var(--danger)", fontSize: 12 }}>{error}</p> : null}<div style={{ display: "grid", gap: 6, marginTop: 12 }}>{destinations.map((item) => <div key={item.id} style={{ alignItems: "center", display: "flex", gap: 8 }}><span>{item.label} <span className="console-faint">({item.kind}, {item.delivery?.state ?? "ready"})</span></span>{item.status !== "disabled" ? <><Button disabled={busy !== null} onClick={() => { setEditing(item.id); setKind(item.kind); setLabel(item.label); setEndpoint(""); setSecret(""); }} variant="outline">Edit label</Button><Button disabled={busy !== null} onClick={() => void disable(item.id)} variant="outline">{busy === item.id ? "Disabling" : "Disable"}</Button></> : null}</div>)}</div></Card>;
}

function CapabilityState({ capabilities, destinations, onVerify, verification, verificationError }: { capabilities: AuditPageResponse["capabilities"] | null; destinations: Array<{ id: string; kind: string; label: string; status: string; delivery?: { state: string; pending: number; processing: number; delivered: number; dead: number } }>; onVerify: () => void; verification: { verified: boolean; checked: number; legacy: number; firstFailure?: { id: string; reason: string } } | null; verificationError: string | null }) {
  const chain = capabilities?.chainVerification ?? "available";
  return <div className="console-grid">
    <Card className="console-card-body"><div className="console-kpi-label">Chain verification</div><div style={{ marginTop: 8 }}><StatusBadge status={verification?.verified ? "up" : verification ? "down" : "idle"}>{verification ? (verification.verified ? "Verified" : "Failed") : "Not run"}</StatusBadge></div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{verification ? `${verification.checked} sealed record${verification.checked === 1 ? "" : "s"} checked; ${verification.legacy} legacy record${verification.legacy === 1 ? "" : "s"} excluded.` : chain === "available" ? "Verify all sealed records in this workspace." : "Verification capability is unavailable."}</p>{verificationError ? <p style={{ color: "var(--danger)", fontSize: 12 }}>{verificationError}</p> : null}<Button onClick={onVerify} variant="outline">Verify chain</Button></Card>
    <Card className="console-card-body"><div className="console-kpi-label">SIEM and webhook destinations</div><div style={{ marginTop: 8 }}><StatusBadge status={destinations.some((item) => item.delivery?.state === "attention") ? "down" : destinations.length ? "up" : "idle"}>{destinations.length ? `${destinations.length} configured` : "None configured"}</StatusBadge></div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{destinations.length ? destinations.map((item) => `${item.label} (${item.delivery?.state ?? "ready"}${item.delivery?.pending ? `, ${item.delivery.pending} queued` : ""}${item.delivery?.dead ? `, ${item.delivery.dead} failed` : ""})`).join(", ") : "Destinations can be configured through the audit destination API."}</p></Card>
  </div>;
}

function FilterBar({ filters, onApply, onChange, onClear }: { filters: Filters; onApply: () => void; onChange: React.Dispatch<React.SetStateAction<Filters>>; onClear: () => void }) {
  const update = (field: keyof Filters, value: string) => onChange((current) => ({ ...current, [field]: value }));
  return <div style={{ display: "grid", gap: 10, padding: 12 }}>
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
      <Input aria-label="Filter actor ID" onChange={(event) => update("actor", event.target.value)} placeholder="Actor ID" value={filters.actor} />
      <Input aria-label="Filter action" onChange={(event) => update("action", event.target.value)} placeholder="Action" value={filters.action} />
      <Input aria-label="Filter content hash" onChange={(event) => update("hash", event.target.value)} placeholder="Content hash" value={filters.hash} />
      <Input aria-label="Filter outcome" onChange={(event) => update("outcome", event.target.value)} placeholder="Outcome" value={filters.outcome} />
      <Input aria-label="Filter target kind" onChange={(event) => update("targetKind", event.target.value)} placeholder="Target kind" value={filters.targetKind} />
      <Input aria-label="Filter target ID" onChange={(event) => update("targetId", event.target.value)} placeholder="Target ID" value={filters.targetId} />
      <Input aria-label="Filter profile ID" onChange={(event) => update("profileId", event.target.value)} placeholder="Profile ID" value={filters.profileId} />
      <Input aria-label="Filter from time" onChange={(event) => update("from", event.target.value)} title="From time" type="datetime-local" value={filters.from} />
      <Input aria-label="Filter to time" onChange={(event) => update("to", event.target.value)} title="To time" type="datetime-local" value={filters.to} />
    </div>
    <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}><Button onClick={onApply} variant="primary">Apply filters</Button><Button onClick={onClear} variant="ghost">Clear</Button><span className="console-muted" style={{ fontSize: 12 }}>Filters query the persisted audit projection.</span></div>
  </div>;
}

function Timeline({ events, onOpen }: { events: AuditTimelineItem[]; onOpen: (id: string) => void }) {
  return <div className="console-table-wrap" style={{ borderLeft: 0, borderRadius: 0, borderRight: 0 }}><table className="console-table" style={{ minWidth: 960 }}><thead><tr><th>Time</th><th>Actor</th><th>Action and target</th><th>Outcome</th><th>Hashes</th><th>Links</th><th aria-label="Open audit event" /></tr></thead><tbody>{events.map((event) => <tr key={`${event.kind}:${event.id}`}>
    <td className="console-muted" style={{ whiteSpace: "nowrap" }}>{time(event.createdAt)}</td>
    {event.kind === "audit_event" ? <>
      <td><div>{event.actor.kind}</div><div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 2 }}>{short(event.actor.id)}</div></td>
      <td><strong>{event.action}</strong>{event.target ? <div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 3 }}>{event.target.kind ?? "target"} · {short(event.target.id)}</div> : null}</td>
      <td>{event.outcome ? <StatusBadge status={outcomeStatus(event.outcome)}>{event.outcome}</StatusBadge> : <span className="console-faint">Not recorded</span>}</td>
      <td className="console-mono console-faint" style={{ fontSize: 11 }}><div title={event.hashes.before ?? undefined}>Before {short(event.hashes.before)}</div><div style={{ marginTop: 3 }} title={event.hashes.after ?? undefined}>After {short(event.hashes.after)}</div></td>
      <td>{event.links.requestRef ? <a href={`/logs?traceId=${encodeURIComponent(event.links.requestRef)}`} style={{ color: "var(--accent)" }}>Request</a> : <span className="console-faint">Not recorded</span>}</td>
      <td><Button aria-label={`Open audit event ${event.id}`} onClick={() => void onOpen(event.id)} variant="ghost">Details</Button></td>
    </> : <>
      <td><span className="console-faint">Not recorded</span></td>
      <td><strong>Policy decision</strong>{event.target ? <div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 3 }}>{event.target.kind} · {short(event.target.id)}</div> : null}</td>
      <td><StatusBadge status={outcomeStatus(event.outcome)}>{event.outcome}</StatusBadge>{event.reasonCodes.length ? <div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 3 }}>{event.reasonCodes.join(", ")}</div> : null}</td>
      <td className="console-faint">Not applicable</td>
      <td>{event.links.traceId ? <a href={`/logs?traceId=${encodeURIComponent(event.links.traceId)}`} style={{ color: "var(--accent)" }}>Trace</a> : <span className="console-faint">Request {short(event.links.requestId)}</span>}</td>
      <td><span className="console-faint">Policy</span></td>
    </>}
  </tr>)}</tbody></table></div>;
}

function TimelineSkeleton() { return <div style={{ display: "grid", gap: 8, padding: 12 }}><Skeleton style={{ height: 45 }} /><Skeleton style={{ height: 45 }} /><Skeleton style={{ height: 45 }} /><Skeleton style={{ height: 45 }} /></div>; }

function AuditDetail({ error, event, loading, onClose, open }: { error: string | null; event: AuditEvent | null; loading: boolean; onClose: () => void; open: boolean }) {
  return <Sheet onClose={onClose} open={open} title="Audit event detail">
    {loading ? <div className="console-stack"><Skeleton style={{ height: 22, width: "55%" }} /><Skeleton style={{ height: 180 }} /></div> : null}
    {error ? <AlertBanner title="Audit event unavailable" tone="down">{error}</AlertBanner> : null}
    {event ? <div className="console-stack" style={{ gap: 18 }}>
      <dl style={{ display: "grid", gap: 13, margin: 0 }}>
        <Value label="Event ID" mono value={event.id} /><Value label="Recorded" value={time(event.createdAt)} /><Value label="Actor" mono value={`${event.actor.kind} · ${event.actor.id ?? "unknown"}`} /><Value label="Action" value={event.action} /><Value label="Target" mono value={event.target ? `${event.target.kind ?? "target"} · ${event.target.id ?? "unknown"}` : "No target recorded"} /><Value label="Before hash" mono value={event.hashes.before ?? "No hash recorded"} /><Value label="After hash" mono value={event.hashes.after ?? "No hash recorded"} /><Value label="Profile" mono value={event.links.profileId ?? "No profile link recorded"} />
      </dl>
      {event.links.requestRef ? <a className="cp-button" data-variant="outline" href={`/logs?traceId=${encodeURIComponent(event.links.requestRef)}`}>Open linked request</a> : <p className="console-muted" style={{ fontSize: 13, margin: 0 }}>No linked request is recorded for this event.</p>}
      <Card className="console-card-body"><div className="console-kpi-label">Verification</div><div style={{ marginTop: 8 }}><StatusBadge status={event.chainVerification.status === "sealed" ? "up" : "idle"}>{event.chainVerification.status === "sealed" ? "Sealed" : "Legacy unsealed"}</StatusBadge></div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{event.chainVerification.reason}</p>{event.chain ? <p className="console-mono console-faint" style={{ fontSize: 11, overflowWrap: "anywhere" }}>Hash {event.chain.hash}</p> : null}</Card>
      <p className="console-muted" style={{ fontSize: 12, margin: 0 }}>Sensitive audit detail is intentionally not displayed. Reason codes are not present in the current audit projection.</p>
    </div> : null}
  </Sheet>;
}

function Value({ label, mono = false, value }: { label: string; mono?: boolean; value: string }) { return <div><dt className="console-muted" style={{ fontSize: 12 }}>{label}</dt><dd className={mono ? "console-mono" : undefined} style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>{value}</dd></div>; }
