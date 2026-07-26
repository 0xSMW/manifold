"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { ConfirmDialog, Sheet } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import { errorMessage, formatDate, labelForProvider, statusLabel, statusTone } from "./providers-console";

interface ActivePrice { inputPerMtokMicrousd: string | null; outputPerMtokMicrousd: string | null; fidelity: string | null; effectiveFrom: string | null }
interface Offering { id: string; canonicalModel: { id: string; slug: string; displayName: string }; providerModelId: string; endpointKinds: unknown; capabilities: unknown; region: string | null; activePrice: ActivePrice | null }
interface ProviderDetailData { id: string; provider: string; label: string; baseUrl: string | null; deployment: unknown; allowedHosts: unknown; status: string; lastValidatedAt: string | null; revokedAt: string | null; createdAt: string; updatedAt: string; offerings: Offering[] }
interface ValidationResult { status: string; validated: boolean; outcome: "valid" | "invalid" | "unsupported"; classification: string; upstreamStatus: number | null; message: string; responseTruncated: boolean }

function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function formatPrice(value: string | null) { if (value === null) return "Unknown"; const microdollars = Number(value); return Number.isFinite(microdollars) ? `$${(microdollars / 1_000_000).toFixed(6)}` : "Unknown"; }

export function ProviderDetail({ credentialId }: { credentialId: string }) {
  const router = useRouter();
  const [credential, setCredential] = useState<ProviderDetailData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const load = useCallback(async () => {
    setError(null); setCredential(undefined);
    try { setCredential(await apiRequest<ProviderDetailData>(`/providers/${encodeURIComponent(credentialId)}`)); }
    catch (caught) { setError(errorMessage(caught)); setCredential(null); }
  }, [credentialId]);
  useEffect(() => { void load(); }, [load]);

  const validate = async () => {
    if (!credential) return;
    setValidating(true); setValidation(null);
    try {
      const result = await apiRequest<ValidationResult>(`/providers/${encodeURIComponent(credential.id)}/validate`, { method: "POST" });
      setValidation(result);
      setCredential((current) => current ? { ...current, status: result.status, lastValidatedAt: new Date().toISOString() } : current);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally { setValidating(false); }
  };
  const revoke = async () => {
    if (!credential) return;
    try { await apiRequest(`/providers/${encodeURIComponent(credential.id)}/revoke`, { method: "POST" }); router.push("/providers"); router.refresh(); }
    catch (caught) { setError(errorMessage(caught)); setRevokeOpen(false); }
  };

  if (credential === undefined) return <PageFrame title="Provider credential" description="Loading credential details"><Card style={{ padding: 16 }}><Skeleton style={{ height: 160 }} /></Card></PageFrame>;
  if (credential === null) return <PageFrame title="Provider credential" description="Credential details">{error ? <AlertBanner title="Credential could not load" tone="down">{error} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner> : <EmptyState action={<a className="cp-button" href="/providers">Back to providers</a>} description="The credential may have been revoked or is outside this workspace." title="Credential not found" />}</PageFrame>;
  return <PageFrame title={credential.label} description={`${labelForProvider(credential.provider)} credential lifecycle and catalog`} actions={<div style={{ display: "flex", gap: 8 }}><a className="cp-button" href="/providers">Back to providers</a><Button onClick={() => setRotateOpen(true)}>Rotate secret</Button><Button onClick={() => setRevokeOpen(true)} variant="danger-outline">Revoke</Button></div>}>
    <div style={{ display: "grid", gap: 16 }}>
      {error ? <AlertBanner title="Provider action failed" tone="down">{error}</AlertBanner> : null}
      {validation ? <ValidationOutcome result={validation} /> : null}
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Credential</h2><dl style={{ display: "grid", gap: 12, margin: 0 }}><Value label="Provider" value={labelForProvider(credential.provider)} /><Value label="Credential ID" mono value={credential.id} /><Value label="Created" value={formatDate(credential.createdAt)} /><Value label="Updated" value={formatDate(credential.updatedAt)} /></dl></Card>
        <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Validation</h2><dl style={{ display: "grid", gap: 12, margin: 0 }}><div><dt style={{ color: "var(--fg-muted)", fontSize: 12 }}>Status</dt><dd style={{ margin: "5px 0 0" }}><StatusBadge status={statusTone(credential.status)}>{statusLabel(credential.status)}</StatusBadge></dd></div><Value label="Last validation" value={formatDate(credential.lastValidatedAt)} /></dl><div style={{ marginTop: 16 }}><Button disabled={validating} onClick={() => void validate()} variant="primary">{validating ? "Validating" : "Validate credential"}</Button></div></Card>
      </div>
      <Card style={{ padding: 16 }}><h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Network configuration</h2><dl style={{ display: "grid", gap: 12, margin: 0 }}><Value label="Base URL" mono value={credential.baseUrl ?? "Provider default"} /><Value label="Allowed hosts" mono value={stringList(credential.allowedHosts).join(", ") || "No hosts configured"} /></dl></Card>
      <Offerings offerings={credential.offerings} />
    </div>
    <RotateSecretSheet credentialId={credential.id} onClose={() => setRotateOpen(false)} onRotated={() => { setRotateOpen(false); setValidation(null); void load(); }} open={rotateOpen} />
    <ConfirmDialog confirmLabel="Revoke credential" confirmText="REVOKE" onClose={() => setRevokeOpen(false)} onConfirm={() => void revoke()} open={revokeOpen} title="Revoke this credential" description="This permanently removes the credential from routing. Type REVOKE to continue." />
  </PageFrame>;
}

function ValidationOutcome({ result }: { result: ValidationResult }) { const title = result.outcome === "valid" ? "Validation succeeded" : result.outcome === "unsupported" ? "Validation unsupported" : "Validation failed"; return <AlertBanner title={title} tone={result.outcome === "valid" ? "up" : result.outcome === "unsupported" ? "idle" : "down"}><dl style={{ display: "grid", gap: 6, margin: "10px 0 0" }}><Value label="Classification" mono value={result.classification} /><Value label="Upstream status" value={result.upstreamStatus === null ? "No HTTP response" : String(result.upstreamStatus)} /><Value label="Provider message" value={result.message} />{result.responseTruncated ? <Value label="Response capture" value="Truncated" /> : null}</dl></AlertBanner>; }
function Offerings({ offerings }: { offerings: Offering[] }) { return <Card style={{ overflow: "hidden" }}><div style={{ padding: "16px 16px 8px" }}><h2 style={{ fontSize: 15, margin: 0 }}>Catalog offerings</h2><p className="console-muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Current provider models, regions, endpoint kinds, and active prices per million tokens</p></div>{offerings.length === 0 ? <EmptyState title="No catalog offerings" description="No offerings are currently available for this provider." /> : <div className="console-table-wrap" style={{ border: 0, borderRadius: 0 }}><table className="console-table"><thead><tr><th>Model</th><th>Provider model</th><th>Region</th><th>Endpoints</th><th>Input per MTok</th><th>Output per MTok</th></tr></thead><tbody>{offerings.map((offering) => <tr key={offering.id}><td><strong>{offering.canonicalModel.displayName}</strong><div className="console-faint console-mono" style={{ fontSize: 11, marginTop: 2 }}>{offering.canonicalModel.slug}</div></td><td className="console-mono">{offering.providerModelId}</td><td>{offering.region ?? "Any region"}</td><td>{stringList(offering.endpointKinds).join(", ") || "Unknown"}</td><td>{formatPrice(offering.activePrice?.inputPerMtokMicrousd ?? null)}</td><td>{formatPrice(offering.activePrice?.outputPerMtokMicrousd ?? null)}</td></tr>)}</tbody></table></div>}</Card>; }
function Value({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><dt style={{ color: "var(--fg-muted)", fontSize: 12 }}>{label}</dt><dd className={mono ? "cp-mono" : undefined} style={{ margin: "5px 0 0", overflowWrap: "anywhere" }}>{value}</dd></div>; }

function RotateSecretSheet({ credentialId, onClose, onRotated, open }: { credentialId: string; onClose: () => void; onRotated: () => void; open: boolean }) {
  const [secret, setSecret] = useState(""); const [error, setError] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (!open) { setSecret(""); setError(null); } }, [open]);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!secret) { setError("A replacement secret is required."); return; } const submittedSecret = secret; setSecret(""); setError(null); setSubmitting(true); try { await apiRequest(`/providers/${encodeURIComponent(credentialId)}/rotate`, { method: "POST", body: { secret: submittedSecret } }); onRotated(); } catch (caught) { setError(errorMessage(caught)); } finally { setSubmitting(false); } };
  return <Sheet onClose={onClose} open={open} title="Rotate secret"><form className="console-form" onSubmit={submit}><p className="console-muted" style={{ margin: 0 }}>Rotation replaces the current secret and returns this credential to the unvalidated state.</p><Field label="Replacement secret"><Input autoComplete="off" onChange={(event) => setSecret(event.target.value)} required type="password" value={secret} /><Hint>Cleared from this form as soon as it is submitted.</Hint></Field>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button disabled={submitting} onClick={onClose}>Cancel</Button><Button disabled={submitting} type="submit" variant="primary">{submitting ? "Rotating secret" : "Rotate secret"}</Button></div></form></Sheet>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="console-field"><span>{label}</span>{children}</label>; }
function Hint({ children }: { children: React.ReactNode }) { return <small className="console-muted">{children}</small>; }
