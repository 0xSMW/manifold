"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/overlay";
import { StatusBadge, type Status } from "@/components/ui/status";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError, type PageResult } from "@/lib/api-client";

export interface ProviderCredential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  status: string;
  lastValidatedAt: string | null;
  createdAt: string;
}

interface ModelOffering { provider: string }
interface CreateProviderResult { id: string; provider: string; label: string; status: string }

const fallbackCatalog = ["anthropic", "azure-openai", "bedrock", "google", "groq", "mistral", "openai", "together"];

export function labelForProvider(provider: string) {
  return provider.split(/[-_]/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function statusTone(status: string): Status {
  if (status === "valid") return "up";
  if (status === "unvalidated") return "verifying";
  if (status === "invalid" || status === "revoked") return "down";
  return "idle";
}

export function statusLabel(status: string) {
  if (status === "valid") return "Validated";
  if (status === "unvalidated") return "Unvalidated";
  if (status === "invalid") return "Invalid";
  if (status === "revoked") return "Revoked";
  return labelForProvider(status);
}

export function formatDate(value: string | null) {
  if (!value) return "Not yet validated";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function errorMessage(caught: unknown) {
  if (caught instanceof ControlPlaneApiError) return caught.message;
  return caught instanceof Error ? caught.message : "Something went wrong";
}

export function ProvidersConsole() {
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [catalog, setCatalog] = useState<string[]>(fallbackCatalog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [providers, models] = await Promise.all([
        apiRequest<PageResult<ProviderCredential>>("/providers"),
        apiRequest<PageResult<ModelOffering>>("/models?limit=100").catch(() => null),
      ]);
      setCredentials(providers.data);
      setCatalog([...new Set([...fallbackCatalog, ...(models?.data.map((model) => model.provider).filter(Boolean) ?? [])])].sort());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const providerCount = useMemo(() => new Set(credentials.map((item) => item.provider)).size, [credentials]);

  return <PageFrame title="Providers" description="Manage credentials used to route requests to upstream model providers" actions={<Button onClick={() => setSheetOpen(true)} variant="primary">Add credential</Button>}>
    {loading ? <ProviderSkeleton /> : null}
    {!loading && error ? <Card className="console-card-body"><AlertBanner title="Could not load providers" tone="down">{error}</AlertBanner><div style={{ marginTop: 14 }}><Button onClick={() => void load()}>Try again</Button></div></Card> : null}
    {!loading && !error && credentials.length === 0 ? <Card><EmptyState title="No provider credentials" description="Add a credential to make models from a provider available to this workspace." action={<Button onClick={() => setSheetOpen(true)} variant="primary">Add credential</Button>} /></Card> : null}
    {!loading && !error && credentials.length > 0 ? <><div className="console-grid"><Kpi label="Credentials" value={credentials.length} /><Kpi label="Providers" value={providerCount} /><Kpi label="Validated" value={credentials.filter((item) => item.status === "valid").length} /></div><ProviderTable credentials={credentials} /></> : null}
    <AddCredentialSheet catalog={catalog} onClose={() => setSheetOpen(false)} onCreated={(created) => { setCredentials((items) => [created, ...items]); setSheetOpen(false); }} open={sheetOpen} />
  </PageFrame>;
}

function Kpi({ label, value }: { label: string; value: number }) { return <Card className="console-kpi"><div className="console-kpi-label">{label}</div><div className="console-kpi-value">{value}</div></Card>; }
function ProviderSkeleton() { return <Card className="console-card-body"><div className="console-stack"><Skeleton style={{ height: 20, width: "28%" }} /><Skeleton style={{ height: 48 }} /><Skeleton style={{ height: 48 }} /><Skeleton style={{ height: 48 }} /></div></Card>; }

function ProviderTable({ credentials }: { credentials: ProviderCredential[] }) {
  return <div className="console-table-wrap"><table className="console-table"><thead><tr><th>Credential</th><th>Provider</th><th>Status</th><th>Base URL</th><th>Last validation</th><th aria-label="Actions" /></tr></thead><tbody>{credentials.map((credential) => <tr key={credential.id}><td><a href={`/providers/${credential.id}`} style={{ color: "var(--accent)", fontWeight: 650 }}>{credential.label}</a><div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 2 }}>{credential.id}</div></td><td>{labelForProvider(credential.provider)}</td><td><StatusBadge status={statusTone(credential.status)}>{statusLabel(credential.status)}</StatusBadge></td><td className="console-mono console-muted">{credential.baseUrl ?? "Provider default"}</td><td className="console-muted">{formatDate(credential.lastValidatedAt)}</td><td><a className="cp-button" href={`/providers/${credential.id}`}>Manage</a></td></tr>)}</tbody></table></div>;
}

function AddCredentialSheet({ catalog, onClose, onCreated, open }: { catalog: string[]; onClose: () => void; onCreated: (credential: ProviderCredential) => void; open: boolean }) {
  const [provider, setProvider] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!open) { setProvider(""); setLabel(""); setSecret(""); setBaseUrl(""); setAllowedHosts(""); setError(null); } }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!provider || !label.trim() || !secret) { setError("Provider, label, and secret are required."); return; }
    const submittedSecret = secret;
    const submittedBaseUrl = baseUrl.trim();
    setSecret("");
    setSubmitting(true);
    try {
      const result = await apiRequest<CreateProviderResult>("/providers", { method: "POST", body: { provider, label: label.trim(), secret: submittedSecret, baseUrl: submittedBaseUrl || undefined, allowedHosts: allowedHosts.split(",").map((host) => host.trim()).filter(Boolean) } });
      onCreated({ id: result.id, provider: result.provider, label: result.label, baseUrl: submittedBaseUrl || null, status: result.status, lastValidatedAt: null, createdAt: new Date().toISOString() });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return <Sheet onClose={onClose} open={open} title="Add provider credential"><form className="console-form" onSubmit={submit}><Field label="Provider"><Select onChange={(event) => setProvider(event.target.value)} required value={provider}><option value="">Choose a provider</option>{catalog.map((item) => <option key={item} value={item}>{labelForProvider(item)}</option>)}</Select></Field><Field label="Credential label"><Input onChange={(event) => setLabel(event.target.value)} placeholder="Production primary" required value={label} /></Field><Field label="Secret"><Input autoComplete="off" onChange={(event) => setSecret(event.target.value)} placeholder="Paste API key" required type="password" value={secret} /><Hint>Cleared from this form as soon as it is submitted.</Hint></Field><Field label="Base URL optional"><Input inputMode="url" onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" type="url" value={baseUrl} /></Field><Field label="Allowed hosts optional"><Input onChange={(event) => setAllowedHosts(event.target.value)} placeholder="api.example.com, proxy.example.com" value={allowedHosts} /><Hint>Comma-separated hostnames. Include the base URL hostname when using a custom base URL.</Hint></Field>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<FormActions disabled={submitting} onCancel={onClose} submitLabel={submitting ? "Adding credential" : "Add credential"} /></form></Sheet>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="console-field"><span>{label}</span>{children}</label>; }
function Hint({ children }: { children: React.ReactNode }) { return <small className="console-muted">{children}</small>; }
function FormActions({ disabled, onCancel, submitLabel }: { disabled: boolean; onCancel: () => void; submitLabel: string }) { return <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}><Button disabled={disabled} onClick={onCancel}>Cancel</Button><Button disabled={disabled} type="submit" variant="primary">{submitLabel}</Button></div>; }
