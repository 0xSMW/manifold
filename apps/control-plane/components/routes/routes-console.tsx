"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import type { ContextResponse, Offering, PageResult, ProviderCredential, RouteSummary } from "./route-types";

const tableStyle = { borderCollapse: "collapse" as const, width: "100%" };
const cellStyle = { borderBottom: "1px solid var(--border)", padding: "12px", textAlign: "left" as const, verticalAlign: "middle" };

function endpointKinds(offering: Offering): string[] {
  return Array.isArray(offering.endpointKinds) ? offering.endpointKinds.filter((item): item is string => typeof item === "string") : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load routes";
}

export function RoutesConsole() {
  const toast = useToast();
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const loadRoutes = useCallback(async () => {
    setError(null);
    try {
      const result = await apiRequest<PageResult<RouteSummary>>("/routes");
      setRoutes(result.data);
    } catch (caught) {
      setError(errorMessage(caught));
      setRoutes([]);
    }
  }, []);

  useEffect(() => { void loadRoutes(); }, [loadRoutes]);

  const visibleRoutes = useMemo(() => (routes ?? []).filter((route) => {
    const matchesQuery = route.publicName.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (kind === "all" || route.endpointKind === kind) && (status === "all" || route.status === status);
  }), [kind, query, routes, status]);

  return (
    <PageFrame
      title="Routes"
      description="Map public endpoints to a provider target, then publish the staged revision"
      actions={<Button onClick={() => setSheetOpen(true)} variant="primary">New route</Button>}
    >
      <div style={{ display: "grid", gap: 16 }}>
        {error ? <AlertBanner title="Routes could not load" tone="down">{error} <Button onClick={() => void loadRoutes()} variant="outline">Retry</Button></AlertBanner> : null}
        <Card style={{ overflow: "hidden" }}>
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, padding: 12 }}>
            <Input aria-label="Search routes" onChange={(event) => setQuery(event.target.value)} placeholder="Search public name" style={{ maxWidth: 300 }} value={query} />
            <Select aria-label="Filter endpoint kind" onChange={(event) => setKind(event.target.value)} style={{ maxWidth: 170 }} value={kind}>
              <option value="all">All endpoint kinds</option>
              <option value="chat">Chat</option>
              <option value="responses">Responses</option>
              <option value="embeddings">Embeddings</option>
            </Select>
            <Select aria-label="Filter route status" onChange={(event) => setStatus(event.target.value)} style={{ maxWidth: 150 }} value={status}>
              <option value="all">All statuses</option>
              <option value="staged">Staged</option>
              <option value="draft">Draft</option>
            </Select>
            <span style={{ color: "var(--fg-muted)", fontSize: 12, marginLeft: "auto" }}>{visibleRoutes.length} route{visibleRoutes.length === 1 ? "" : "s"} loaded</span>
          </div>
          <p style={{ color: "var(--fg-muted)", fontSize: 12, margin: "0", padding: "0 12px 12px" }}>New routes create staged revisions. <a href="/publish" style={{ color: "var(--accent)", textDecoration: "underline" }}>Open Publish</a> to apply them.</p>
          {routes === null ? <div style={{ display: "grid", gap: 8, padding: 12 }}><Skeleton style={{ height: 38 }} /><Skeleton style={{ height: 38 }} /><Skeleton style={{ height: 38 }} /></div> : null}
          {routes !== null && !error && routes.length === 0 ? <EmptyState action={<Button onClick={() => setSheetOpen(true)} variant="primary">Create route</Button>} description="Create a route to expose a provider model through an installation." title="No routes yet" /> : null}
          {routes !== null && routes.length > 0 && visibleRoutes.length === 0 ? <EmptyState description="Try another public name or endpoint kind." title="No matching routes" /> : null}
          {visibleRoutes.length > 0 ? <div style={{ overflowX: "auto" }}><table style={tableStyle}><thead><tr style={{ color: "var(--fg-muted)", fontSize: 12 }}><th scope="col" style={cellStyle}>Public name</th><th scope="col" style={cellStyle}>Endpoint</th><th scope="col" style={cellStyle}>Revision</th><th scope="col" style={cellStyle}>Created</th></tr></thead><tbody>{visibleRoutes.map((route) => <tr key={route.id}><td style={cellStyle}><a href={`/routes/${route.id}`} style={{ color: "var(--accent)", fontWeight: 650 }}>{route.publicName}</a></td><td style={cellStyle}><span className="cp-mono">{route.endpointKind}</span></td><td style={cellStyle}><StatusBadge status={route.activeRevisionId ? "up" : "idle"}>{route.activeRevisionId ? "Staged revision" : "Draft"}</StatusBadge></td><td style={{ ...cellStyle, color: "var(--fg-muted)" }}>{new Date(route.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div> : null}
        </Card>
      </div>
      <NewRouteSheet
        onCreated={(route) => { setRoutes((current) => [route, ...(current ?? [])]); setSheetOpen(false); toast("Route created as a staged revision", "verifying"); }}
        onClose={() => setSheetOpen(false)}
        open={sheetOpen}
      />
    </PageFrame>
  );
}

function NewRouteSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (route: RouteSummary) => void }) {
  const [context, setContext] = useState<ContextResponse | null>(null);
  const [credentials, setCredentials] = useState<ProviderCredential[] | null>(null);
  const [offerings, setOfferings] = useState<Offering[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState("");
  const [publicName, setPublicName] = useState("");
  const [endpointKind, setEndpointKind] = useState<"chat" | "responses" | "embeddings">("chat");
  const [mode, setMode] = useState<"ordered" | "weighted">("ordered");
  const [credentialId, setCredentialId] = useState("");
  const [offeringId, setOfferingId] = useState("");
  const [weight, setWeight] = useState("1");
  const [priority, setPriority] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || context) return;
    Promise.all([
      apiRequest<ContextResponse>("/context"),
      apiRequest<PageResult<ProviderCredential>>("/providers"),
      apiRequest<PageResult<Offering>>("/models?limit=100"),
    ]).then(([nextContext, nextCredentials, nextOfferings]) => {
      setContext(nextContext);
      setCredentials(nextCredentials.data);
      setOfferings(nextOfferings.data);
      setInstallationId((current) => current || nextContext.installations.find((item) => item.status === "active")?.id || "");
    }).catch((caught) => setLoadError(errorMessage(caught)));
  }, [context, open]);

  const selectedCredential = credentials?.find((item) => item.id === credentialId) ?? null;
  const compatibleOfferings = useMemo(() => (offerings ?? []).filter((offering) => offering.provider === selectedCredential?.provider && endpointKinds(offering).includes(endpointKind)), [endpointKind, offerings, selectedCredential]);
  useEffect(() => { if (!compatibleOfferings.some((item) => item.id === offeringId)) setOfferingId(compatibleOfferings[0]?.id ?? ""); }, [compatibleOfferings, offeringId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!installationId || !publicName.trim() || !credentialId || !offeringId) return;
    setSubmitting(true);
    try {
      const result = await apiRequest<{ id: string; revisionId: string; status: string }>("/routes", {
        method: "POST",
        body: { installationId, publicName: publicName.trim(), endpointKind, mode, target: { providerCredentialId: credentialId, offeringId, weight: Number(weight), priority: Number(priority) } },
      });
      onCreated({ id: result.id, publicName: publicName.trim(), endpointKind, activeRevisionId: result.revisionId, status: result.status, createdAt: new Date().toISOString() });
    } catch (caught) {
      setLoadError(caught instanceof ControlPlaneApiError ? caught.payload.message : errorMessage(caught));
    } finally { setSubmitting(false); }
  };

  const activeInstallations = context?.installations.filter((item) => item.status === "active") ?? [];
  const validCredentials = credentials?.filter((item) => item.status === "valid") ?? [];
  const ready = Boolean(installationId && publicName.trim() && credentialId && offeringId);
  return <Sheet onClose={onClose} open={open} title="New route"><form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
    <p style={{ color: "var(--fg-muted)", margin: 0 }}>Creates one target and a staged revision. Publish it before the gateway uses it.</p>
    {loadError ? <AlertBanner title="Route setup unavailable" tone="down">{loadError}</AlertBanner> : null}
    {!context || !credentials || !offerings ? <div style={{ display: "grid", gap: 8 }}><Skeleton style={{ height: 34 }} /><Skeleton style={{ height: 34 }} /><Skeleton style={{ height: 34 }} /></div> : <>
      <Field label="Installation"><Select onChange={(event) => setInstallationId(event.target.value)} required value={installationId}><option value="">Select installation</option>{activeInstallations.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.edition})</option>)}</Select></Field>
      <Field label="Public name"><Input onChange={(event) => setPublicName(event.target.value)} placeholder="support-chat" required value={publicName} /></Field>
      <Field label="Endpoint kind"><Select onChange={(event) => setEndpointKind(event.target.value as typeof endpointKind)} value={endpointKind}><option value="chat">Chat</option><option value="responses">Responses</option><option value="embeddings">Embeddings</option></Select></Field>
      <Field label="Mode"><Select onChange={(event) => setMode(event.target.value as typeof mode)} value={mode}><option value="ordered">Ordered</option><option value="weighted">Weighted</option></Select></Field>
      <Field label="Provider credential"><Select onChange={(event) => setCredentialId(event.target.value)} required value={credentialId}><option value="">Select validated credential</option>{validCredentials.map((item) => <option key={item.id} value={item.id}>{item.label} ({item.provider})</option>)}</Select>{validCredentials.length === 0 ? <Hint>Create and validate a provider credential before creating a route.</Hint> : null}</Field>
      <Field label="Offering"><Select disabled={!selectedCredential || compatibleOfferings.length === 0} onChange={(event) => setOfferingId(event.target.value)} required value={offeringId}><option value="">Select offering</option>{compatibleOfferings.map((item) => <option key={item.id} value={item.id}>{item.canonicalModel.displayName} ({item.providerModelId})</option>)}</Select>{selectedCredential && compatibleOfferings.length === 0 ? <Hint>No {endpointKind} offerings are available for this credential provider.</Hint> : null}</Field>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}><Field label="Weight"><Input inputMode="decimal" min="0" onChange={(event) => setWeight(event.target.value)} step="any" type="number" value={weight} /></Field><Field label="Priority"><Input inputMode="numeric" onChange={(event) => setPriority(event.target.value)} step="1" type="number" value={priority} /></Field></div>
      <AlertBanner title="Staged revision" tone="verifying">This route will have one current target. <a href="/publish" style={{ color: "var(--accent)", textDecoration: "underline" }}>Open Publish</a> to apply it to the installation.</AlertBanner>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button onClick={onClose}>Cancel</Button><Button disabled={!ready || submitting} type="submit" variant="primary">{submitting ? "Creating route" : "Create staged route"}</Button></div>
    </>}
  </form></Sheet>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label style={{ display: "grid", fontSize: 12, fontWeight: 650, gap: 6 }}>{label}{children}</label>; }
function Hint({ children }: { children: React.ReactNode }) { return <span style={{ color: "var(--fg-muted)", fontSize: 12, fontWeight: 400 }}>{children}</span>; }
