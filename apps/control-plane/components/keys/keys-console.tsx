"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { ConfirmDialog, Sheet } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { apiRequest } from "@/lib/api-client";

type Attribution = { teamId: string | null; costCenterId: string | null; budgetAccountId: string | null };
type RateLimit = { rpm?: number; tpm?: number; burst?: number };
type Key = {
  id: string;
  displayPrefix: string;
  profileId: string;
  profileMode: string;
  scopes: unknown;
  allowedAppIds: string[];
  defaultAppId: string | null;
  defaultActionId: string | null;
  attribution: Attribution;
  rateLimit: RateLimit | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revoked: boolean;
  expired: boolean;
  successorKeyId: string | null;
  successorActive: boolean;
  graceExpiresAt: string | null;
  rotating: boolean;
  createdAt: string;
};
type Context = {
  installations: Array<{ id: string; name: string; profiles: Array<{ id: string; hostname: string; mode: string; available: boolean }> }>;
  apps: Array<{ id: string; slug: string; name: string; status: string; actions: Array<{ id: string; slug: string; name: string | null }> }>;
  teams: Array<{ id: string; slug: string; name: string; costCenterId: string | null }>;
  costCenters: Array<{ id: string; slug: string; name: string; parentId: string | null }>;
  budgets: Array<{ id: string; scope: { type: string; id: string | null }; window: string; enforcement: string }>;
};
type KeysResponse = { data: Key[]; nextCursor: string | null };
type BudgetsResponse = { data: Context["budgets"]; nextCursor: string | null };
type MintResponse = { keyId: string; displayPrefix: string; plaintext: string; published: boolean };
type RotateResponse = { predecessorKeyId: string; successorKeyId: string; displayPrefix: string; plaintext: string; graceExpiresAt: string; graceSemantics: string; published: boolean };
type RevokeResponse = { id: string; revoked: true; published: boolean };
type Secret = { displayPrefix: string; plaintext: string; published: boolean; title: string; graceExpiresAt?: string };
type Values = { profileId: string; scopes: string; allowedAppIds: string[]; defaultAppId: string; defaultActionId: string; teamId: string; costCenterId: string; budgetAccountId: string; rateRpm: string; rateTpm: string; rateBurst: string; expiresAt: string };

const blankValues: Values = { profileId: "", scopes: "", allowedAppIds: [], defaultAppId: "", defaultActionId: "", teamId: "", costCenterId: "", budgetAccountId: "", rateRpm: "", rateTpm: "", rateBurst: "", expiresAt: "" };

function dateTime(value: string | null): string { if (!value) return "Never"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function scopes(value: unknown): string { return Array.isArray(value) && value.length ? value.filter((item): item is string => typeof item === "string").join(", ") : "No explicit scopes"; }
function profile(context: Context | null, profileId: string) { return context?.installations.flatMap((installation) => installation.profiles.map((item) => ({ ...item, label: `${item.hostname} (${installation.name})` }))).find((item) => item.id === profileId); }
function formValues(key: Key): Values { return { profileId: key.profileId, scopes: Array.isArray(key.scopes) ? key.scopes.filter((item): item is string => typeof item === "string").join(", ") : "", allowedAppIds: key.allowedAppIds, defaultAppId: key.defaultAppId ?? "", defaultActionId: key.defaultActionId ?? "", teamId: key.attribution.teamId ?? "", costCenterId: key.attribution.costCenterId ?? "", budgetAccountId: key.attribution.budgetAccountId ?? "", rateRpm: key.rateLimit?.rpm?.toString() ?? "", rateTpm: key.rateLimit?.tpm?.toString() ?? "", rateBurst: key.rateLimit?.burst?.toString() ?? "", expiresAt: key.expiresAt ? key.expiresAt.slice(0, 16) : "" }; }
function requestBody(values: Values) {
  const rateLimit = Object.fromEntries([["rpm", values.rateRpm], ["tpm", values.rateTpm], ["burst", values.rateBurst]].filter(([, value]) => value.trim()).map(([key, value]) => [key, Number(value)]));
  return { scopes: values.scopes.split(",").map((value) => value.trim()).filter(Boolean), allowedAppIds: values.allowedAppIds, defaultAppId: values.defaultAppId || null, defaultActionId: values.defaultActionId || null, teamId: values.teamId || null, costCenterId: values.costCenterId || null, budgetAccountId: values.budgetAccountId || null, rateLimit: Object.keys(rateLimit).length ? rateLimit : null, expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : null };
}

export function KeysConsole() {
  const toast = useToast();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mintOpen, setMintOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Key | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Key | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Key | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<Secret | null>(null);
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [keyResult, contextResult, budgetResult] = await Promise.all([
        apiRequest<KeysResponse>("/keys"),
        apiRequest<Omit<Context, "budgets">>("/context"),
        apiRequest<BudgetsResponse>("/budgets?limit=200"),
      ]);
      setKeys(keyResult.data);
      setContext({ ...contextResult, budgets: budgetResult.data });
    }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Unable to load keys"); setKeys(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const replace = (updated: Key) => setKeys((items) => items?.map((item) => item.id === updated.id ? updated : item) ?? null);
  const openEdit = async (key: Key) => {
    try { setEditTarget(await apiRequest<Key>(`/keys/${encodeURIComponent(key.id)}`)); }
    catch (error) { toast(error instanceof Error ? error.message : "Unable to load key", "down"); }
  };
  const revoke = async () => {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    try { const result = await apiRequest<RevokeResponse>(`/keys/${encodeURIComponent(revokeTarget.id)}/revoke`, { method: "POST" }); replace({ ...revokeTarget, revoked: true }); setRevokeTarget(null); toast(result.published ? "Revoke key published to gateway" : "Revoke key saved without an active snapshot", result.published ? "up" : "idle"); }
    catch (error) { toast(error instanceof Error ? error.message : "Unable to revoke key", "down"); }
    finally { setRevoking(false); }
  };
  const rotate = async (graceSeconds: number) => {
    if (!rotateTarget || rotating) return;
    setRotating(true);
    try { const result = await apiRequest<RotateResponse>(`/keys/${encodeURIComponent(rotateTarget.id)}/rotate`, { method: "POST", body: { graceSeconds } }); replace({ ...rotateTarget, successorKeyId: result.successorKeyId, graceExpiresAt: result.graceExpiresAt, rotating: true, successorActive: true, expiresAt: result.graceExpiresAt }); setRotateTarget(null); setSecret({ displayPrefix: result.displayPrefix, plaintext: result.plaintext, published: result.published, title: "Copy successor key", graceExpiresAt: result.graceExpiresAt }); }
    catch (error) { toast(error instanceof Error ? error.message : "Unable to rotate key", "down"); }
    finally { setRotating(false); }
  };
  return <PageFrame title="Keys" description="Mint scoped virtual keys and manage gateway access" actions={<Button disabled={!context} onClick={() => setMintOpen(true)} variant="primary">Mint key</Button>}>
    {loadError ? <AlertBanner tone="down" title="Keys unavailable">{loadError} <Button onClick={() => void load()} variant="ghost">Retry load</Button></AlertBanner> : null}
    {keys === null && !loadError ? <LoadingTable /> : null}
    {keys?.length === 0 ? <Card><EmptyState action={<Button disabled={!context} onClick={() => setMintOpen(true)} variant="primary">Mint key</Button>} description="Create a virtual key for controlled gateway access" title="No keys yet" /></Card> : null}
    {keys?.length ? <KeysTable context={context} keys={keys} onEdit={(key) => void openEdit(key)} onRevoke={setRevokeTarget} onRotate={setRotateTarget} /> : null}
    <KeySheet context={context} keyValue={null} onClose={() => setMintOpen(false)} onMinted={(result, values) => { setKeys((items) => items ? [{ id: result.keyId, displayPrefix: result.displayPrefix, profileId: values.profileId, profileMode: profile(context, values.profileId)?.mode ?? "", scopes: requestBody(values).scopes, allowedAppIds: values.allowedAppIds, defaultAppId: values.defaultAppId || null, defaultActionId: values.defaultActionId || null, attribution: { teamId: values.teamId || null, costCenterId: values.costCenterId || null, budgetAccountId: values.budgetAccountId || null }, rateLimit: requestBody(values).rateLimit as RateLimit | null, expiresAt: requestBody(values).expiresAt, lastUsedAt: null, revoked: false, expired: false, successorKeyId: null, successorActive: false, graceExpiresAt: null, rotating: false, createdAt: new Date().toISOString() }, ...items] : items); setMintOpen(false); setSecret({ displayPrefix: result.displayPrefix, plaintext: result.plaintext, published: result.published, title: "Copy new key" }); }} open={mintOpen} />
    <KeySheet context={context} keyValue={editTarget} onClose={() => setEditTarget(null)} onUpdated={(updated) => { replace(updated); setEditTarget(null); toast("Update key saved", "up"); }} open={Boolean(editTarget)} />
    <RotateDialog keyValue={rotateTarget} onClose={() => !rotating && setRotateTarget(null)} onRotate={(graceSeconds) => void rotate(graceSeconds)} open={Boolean(rotateTarget)} rotating={rotating} />
    <ConfirmDialog confirmLabel={revoking ? "Revoking key" : "Revoke key"} confirmText={revokeTarget?.displayPrefix} description={`This permanently disables ${revokeTarget?.displayPrefix ?? "this key"}. Type its prefix to confirm`} onClose={() => !revoking && setRevokeTarget(null)} onConfirm={() => void revoke()} open={Boolean(revokeTarget)} title="Revoke key" />
    <SecretDialog onClose={() => setSecret(null)} secret={secret} />
  </PageFrame>;
}

function LoadingTable() { return <Card className="console-card-body"><div className="console-stack"><Skeleton style={{ height: 30 }} /><Skeleton style={{ height: 48 }} /><Skeleton style={{ height: 48 }} /><Skeleton style={{ height: 48 }} /></div></Card>; }
function KeysTable({ keys, context, onEdit, onRevoke, onRotate }: { keys: Key[]; context: Context | null; onEdit: (key: Key) => void; onRevoke: (key: Key) => void; onRotate: (key: Key) => void }) { return <div className="console-table-wrap"><table className="console-table"><thead><tr><th>Key</th><th>Profile and scope</th><th>Attribution</th><th>Limit</th><th>Usage and expiry</th><th>Status</th><th aria-label="Actions" /></tr></thead><tbody>{keys.map((key) => { const profileInfo = profile(context, key.profileId); const team = context?.teams.find((item) => item.id === key.attribution.teamId); const costCenter = context?.costCenters.find((item) => item.id === key.attribution.costCenterId); const budget = context?.budgets.find((item) => item.id === key.attribution.budgetAccountId); const attribution = [team && `Team ${team.name}`, costCenter && `Cost center ${costCenter.name}`, budget && `${budget.enforcement} ${budget.window} budget`].filter(Boolean).join(" · ") || "No attribution"; const limit = key.rateLimit ? [key.rateLimit.rpm && `${key.rateLimit.rpm} RPM`, key.rateLimit.tpm && `${key.rateLimit.tpm} TPM`, key.rateLimit.burst && `${key.rateLimit.burst} burst`].filter(Boolean).join(" · ") : "No rate limit"; const state = key.revoked ? "Revoked" : key.expired ? "Expired" : key.rotating ? "Rotating" : "Active"; return <tr key={key.id}><td><span className="console-mono">{key.displayPrefix}</span><div className="console-faint">Created {dateTime(key.createdAt)}</div></td><td>{profileInfo?.label ?? "Unavailable profile"}<div className="console-faint">{scopes(key.scopes)}</div><div className="console-faint">{key.allowedAppIds.length ? `${key.allowedAppIds.length} allowed app${key.allowedAppIds.length === 1 ? "" : "s"}` : "All apps allowed"}</div></td><td>{attribution}</td><td>{limit}</td><td>Last used {dateTime(key.lastUsedAt)}<div className="console-faint">Expires {dateTime(key.expiresAt)}</div>{key.graceExpiresAt ? <div className="console-faint">Grace ends {dateTime(key.graceExpiresAt)}</div> : null}</td><td><StatusBadge status={key.revoked || key.expired ? "down" : key.rotating ? "idle" : "up"}>{state}</StatusBadge>{key.successorActive ? <div className="console-faint">Successor active</div> : null}</td><td><div style={{ display: "flex", gap: 6 }}><Button disabled={key.revoked || key.expired || key.rotating} onClick={() => onEdit(key)} variant="outline">Edit key</Button><Button disabled={key.revoked || key.expired || key.rotating} onClick={() => onRotate(key)} variant="outline">Rotate key</Button>{key.revoked ? null : <Button onClick={() => onRevoke(key)} variant="danger-outline">Revoke key</Button>}</div></td></tr>; })}</tbody></table></div>; }

function KeySheet({ open, onClose, context, keyValue, onMinted, onUpdated }: { open: boolean; onClose: () => void; context: Context | null; keyValue: Key | null; onMinted?: (result: MintResponse, values: Values) => void; onUpdated?: (result: Key) => void }) {
  const [values, setValues] = useState<Values>(blankValues); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const profiles = useMemo(() => context?.installations.flatMap((installation) => installation.profiles.filter((item) => item.available).map((item) => ({ ...item, label: `${item.hostname} (${installation.name})` }))) ?? [], [context]);
  const selected = profiles.find((item) => item.id === values.profileId); const isPublic = selected?.mode === "public_app";
  useEffect(() => { if (open) setValues(keyValue ? formValues(keyValue) : { ...blankValues, profileId: profiles[0]?.id ?? "" }); if (!open) setError(null); }, [open, keyValue, profiles]);
  const set = <K extends keyof Values>(field: K, value: Values[K]) => setValues((current) => ({ ...current, [field]: value }));
  const toggleApp = (id: string) => setValues((current) => ({ ...current, allowedAppIds: current.allowedAppIds.includes(id) ? current.allowedAppIds.filter((item) => item !== id) : [...current.allowedAppIds, id] }));
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (!values.profileId) { setError("Select an available ingress profile"); return; } setSaving(true); setError(null); try { const body = requestBody(values); if (keyValue) { const result = await apiRequest<Key>(`/keys/${encodeURIComponent(keyValue.id)}`, { method: "PATCH", body }); onUpdated?.(result); } else { const result = await apiRequest<MintResponse>("/keys", { method: "POST", body: { profileId: values.profileId, ...body } }); onMinted?.(result, values); setValues(blankValues); } } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to save key"); } finally { setSaving(false); } };
  const actions = context?.apps.find((app) => app.id === values.defaultAppId)?.actions ?? [];
  return <Sheet onClose={() => !saving && onClose()} open={open} title={keyValue ? "Edit key" : "Mint key"}><form className="console-form" onSubmit={save}><p className="console-muted" style={{ margin: 0 }}>{keyValue ? "Update the active key policy" : "The secret is shown once after minting"}</p><label className="console-field"><span>Ingress profile</span><Select disabled={saving || Boolean(keyValue)} onChange={(event) => set("profileId", event.target.value)} value={values.profileId}><option value="">Select a profile</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></label><label className="console-field"><span>Scopes</span><Input disabled={saving} onChange={(event) => set("scopes", event.target.value)} placeholder="chat:complete, models:read" value={values.scopes} /><small className="console-muted">Separate scopes with commas</small></label><fieldset className="console-field" disabled={saving}><legend>Allowed apps</legend><div className="console-stack">{context?.apps.map((app) => <label key={app.id}><input checked={values.allowedAppIds.includes(app.id)} onChange={() => toggleApp(app.id)} type="checkbox" /> {app.name} <span className="console-faint">({app.slug})</span></label>)}</div><small className="console-muted">Leave all apps unselected to allow every app</small></fieldset><label className="console-field"><span>Default app</span><Select disabled={saving} onChange={(event) => { set("defaultAppId", event.target.value); set("defaultActionId", ""); }} value={values.defaultAppId}><option value="">No default app</option>{context?.apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</Select></label><label className="console-field"><span>Default action</span><Select disabled={saving || !values.defaultAppId} onChange={(event) => set("defaultActionId", event.target.value)} value={values.defaultActionId}><option value="">No default action</option>{actions.map((action) => <option key={action.id} value={action.id}>{action.name ?? action.slug}</option>)}</Select></label>{isPublic ? <p className="console-muted" style={{ margin: 0 }}>Public keys use app allowlists and rate limits. Enterprise attribution is unavailable for this profile</p> : <><label className="console-field"><span>Team</span><Select disabled={saving} onChange={(event) => set("teamId", event.target.value)} value={values.teamId}><option value="">No team</option>{context?.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</Select></label><label className="console-field"><span>Cost center</span><Select disabled={saving} onChange={(event) => set("costCenterId", event.target.value)} value={values.costCenterId}><option value="">No cost center</option>{context?.costCenters.map((center) => <option key={center.id} value={center.id}>{center.name}</option>)}</Select></label><label className="console-field"><span>Budget account</span><Select disabled={saving} onChange={(event) => set("budgetAccountId", event.target.value)} value={values.budgetAccountId}><option value="">No budget account</option>{context?.budgets.map((budget) => <option key={budget.id} value={budget.id}>{budget.enforcement} {budget.window} {budget.scope.type} budget</option>)}</Select></label></>}<fieldset className="console-field" disabled={saving}><legend>Rate limit</legend><div style={{ display: "flex", gap: 8 }}><Input inputMode="numeric" min="1" onChange={(event) => set("rateRpm", event.target.value)} placeholder="RPM" type="number" value={values.rateRpm} /><Input inputMode="numeric" min="1" onChange={(event) => set("rateTpm", event.target.value)} placeholder="TPM" type="number" value={values.rateTpm} /><Input inputMode="numeric" min="1" onChange={(event) => set("rateBurst", event.target.value)} placeholder="Burst" type="number" value={values.rateBurst} /></div></fieldset><label className="console-field"><span>Expiry</span><Input disabled={saving} min={new Date().toISOString().slice(0, 16)} onChange={(event) => set("expiresAt", event.target.value)} type="datetime-local" value={values.expiresAt} /></label>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button disabled={saving} onClick={onClose}>Cancel</Button><Button disabled={saving || !profiles.length} type="submit" variant="primary">{saving ? keyValue ? "Saving key" : "Minting key" : keyValue ? "Save key" : "Mint key"}</Button></div></form></Sheet>;
}

function RotateDialog({ open, onClose, onRotate, keyValue, rotating }: { open: boolean; onClose: () => void; onRotate: (graceSeconds: number) => void; keyValue: Key | null; rotating: boolean }) {
  const [seconds, setSeconds] = useState("900");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setSeconds("900"); setError(null); } }, [open]);
  const submit = (event: React.FormEvent) => { event.preventDefault(); const value = Number(seconds); if (!Number.isSafeInteger(value) || value < 60 || value > 86400) { setError("Enter a whole number from 60 to 86400 seconds"); return; } onRotate(value); };
  return <Sheet onClose={() => !rotating && onClose()} open={open} title="Rotate key"><form className="console-form" onSubmit={submit}><p className="console-muted" style={{ margin: 0 }}>Mint a successor for {keyValue?.displayPrefix ?? "this key"}. The predecessor remains active only during this grace window</p><label className="console-field"><span>Grace seconds</span><Input disabled={rotating} inputMode="numeric" max="86400" min="60" onChange={(event) => setSeconds(event.target.value)} type="number" value={seconds} /><small className="console-muted">Choose from 60 seconds to 24 hours</small></label>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button disabled={rotating} onClick={onClose}>Cancel</Button><Button disabled={rotating} type="submit" variant="primary">{rotating ? "Rotating key" : "Rotate key"}</Button></div></form></Sheet>;
}

function SecretDialog({ secret, onClose }: { secret: Secret | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null); const dialogRef = useRef<HTMLDivElement>(null); const previousFocus = useRef<HTMLElement | null>(null); const [copied, setCopied] = useState(false);
  useEffect(() => { if (!secret) return; previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; closeRef.current?.focus(); const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); if (event.key !== "Tab") return; const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]") ?? []).filter((element) => !element.hasAttribute("disabled")); const current = focusable.indexOf(document.activeElement as HTMLElement); if (!focusable.length) return; if (event.shiftKey && current <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); } if (!event.shiftKey && current === focusable.length - 1) { event.preventDefault(); focusable[0]?.focus(); } }; document.addEventListener("keydown", onKey); return () => { document.removeEventListener("keydown", onKey); previousFocus.current?.focus(); }; }, [secret, onClose]);
  useEffect(() => { if (secret) setCopied(false); }, [secret]);
  if (!secret) return null;
  const copy = async () => { await navigator.clipboard.writeText(secret.plaintext); setCopied(true); };
  return <div className="cp-dialog-backdrop" onMouseDown={onClose} role="presentation"><div aria-describedby="key-secret-description" aria-labelledby="key-secret-title" aria-modal="true" className="cp-dialog" onMouseDown={(event) => event.stopPropagation()} ref={dialogRef} role="dialog"><h2 id="key-secret-title" style={{ fontSize: 16, margin: "0 0 8px" }}>{secret.title}</h2><p id="key-secret-description" className="console-muted" style={{ margin: "0 0 16px" }}>This is the only time the plaintext key can be displayed. Copy it now and store it securely</p><code className="console-code">{secret.plaintext}</code>{secret.graceExpiresAt ? <p className="console-muted">Predecessor grace ends {dateTime(secret.graceExpiresAt)}</p> : null}<p className="console-muted" style={{ fontSize: 12 }}>Gateway publish status: {secret.published ? "published" : "awaiting the first full apply"}</p><footer style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}><Button onClick={() => void copy()} variant="secondary">{copied ? "Copied key" : "Copy key"}</Button><Button onClick={onClose} ref={closeRef} variant="primary">Close key</Button></footer></div></div>;
}
