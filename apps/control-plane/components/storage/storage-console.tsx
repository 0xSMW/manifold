"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { StatusBadge, type Status } from "@/components/ui/status";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

type Thresholds = { warnPct: number; highPct: number; critPct: number };

type Compaction = {
  id: string;
  status: string;
  queuedAt: string;
  claimedAt: string | null;
  updatedAt: string;
  error: unknown;
  freedBytes: number | null;
  progress?: { steps?: string[]; blocker?: { missing?: string[] } } | null;
};

type StorageResponse = {
  measuredAt: string | null;
  usedBytes: string | null;
  ceilingBytes: string | null;
  usedPct: number | null;
  tier: string | null;
  pressure: { captureMode: "none" | "metadata" | "redacted" | "full"; payloadSampleRate: number; journalMode: "full" | "aggregate_only"; source: "persisted" | "fallback" } | null;
  thresholds: Thresholds | null;
  tables: Record<string, string | number> | null;
  indexesBytes: string | null;
  toastBytes: string | null;
  growthBytesPerDay: string | null;
  forecastExhaustionAt: string | null;
  retention: { available: true; observationRetentionDays: number | null; exportTarget: "disabled" | "local_filesystem" | "object_storage"; exportConfigured: boolean; enabled: boolean; destructiveDeletion: string; checkpoints: Record<string, number> };
  lastCompaction: Compaction | null;
};

type ThresholdResult = {
  thresholds: Thresholds;
  ceilingBytes: string | null;
  measuredAt: string | null;
  usedPct: number | null;
  tier: string | null;
};

type CompactResult = { jobId: string; status: "queued"; freedBytes: null };
type RetentionResult = { configured: boolean; observationRetentionDays: number | null; exportTarget: string; exportConfigured: boolean; destructiveDeletion: string; remediation: string | null; updatedAt?: string };

function errorMessage(error: unknown) {
  if (error instanceof ControlPlaneApiError) return error.message;
  return error instanceof Error ? error.message : "Unable to complete the request";
}

function formatBytes(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "Unavailable";
  try {
    let bytes = typeof value === "number" ? BigInt(Math.trunc(value)) : BigInt(value);
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let index = 0;
    const divisor = 1024n;
    while (bytes >= divisor && index < units.length - 1) {
      bytes /= divisor;
      index += 1;
    }
    return `${bytes.toLocaleString()} ${units[index]}`;
  } catch {
    return "Unavailable";
  }
}

function formatRate(value: string | null) {
  if (value === null) return "Unavailable";
  const bytes = formatBytes(value);
  return bytes === "Unavailable" ? bytes : `${bytes} per day`;
}

function formatDate(value: string | null) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function tierLabel(tier: string | null) {
  if (!tier) return "Unavailable";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function tierStatus(tier: string | null): Status {
  if (tier === "normal") return "up";
  if (tier === "warning" || tier === "high") return "verifying";
  if (tier === "critical" || tier === "emergency") return "down";
  return "idle";
}

function tierFor(usedPct: number | null, thresholds: Thresholds | null) {
  if (usedPct === null || !thresholds) return null;
  if (usedPct >= 100) return "emergency";
  if (usedPct >= thresholds.critPct) return "critical";
  if (usedPct >= thresholds.highPct) return "high";
  if (usedPct >= thresholds.warnPct) return "warning";
  return "normal";
}

function numberInput(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : null;
}

export function StorageConsole() {
  const [storage, setStorage] = useState<StorageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [values, setValues] = useState({ warnPct: "", highPct: "", critPct: "" });
  const [retentionDays, setRetentionDays] = useState(30);
  const [exportTarget, setExportTarget] = useState<"disabled" | "local_filesystem" | "object_storage">("disabled");
  const [exportLocation, setExportLocation] = useState("");
  const [retentionEnabled, setRetentionEnabled] = useState(false);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [savingRetention, setSavingRetention] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await apiRequest<StorageResponse>("/storage");
      setStorage(result);
      if (result.thresholds) {
        setValues({
          warnPct: String(result.thresholds.warnPct),
          highPct: String(result.thresholds.highPct),
          critPct: String(result.thresholds.critPct),
        });
      }
      if (result.retention.observationRetentionDays !== null) setRetentionDays(result.retention.observationRetentionDays);
      setExportTarget(result.retention.exportTarget);
      setRetentionEnabled(result.retention.enabled);
    } catch (caught) {
      setError(errorMessage(caught));
      setStorage(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const draftThresholds = useMemo<Thresholds | null>(() => {
    const warnPct = numberInput(values.warnPct);
    const highPct = numberInput(values.highPct);
    const critPct = numberInput(values.critPct);
    return warnPct !== null && highPct !== null && critPct !== null ? { warnPct, highPct, critPct } : null;
  }, [values]);
  const ordered = Boolean(draftThresholds && draftThresholds.warnPct < draftThresholds.highPct && draftThresholds.highPct < draftThresholds.critPct);
  const previewTier = ordered ? tierFor(storage?.usedPct ?? null, draftThresholds) : null;

  const saveThresholds = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setThresholdError(null);
    setNotice(null);
    if (!draftThresholds || !ordered) {
      setThresholdError("Enter whole percentages from 1 to 100 in ascending order");
      return;
    }
    setSaving(true);
    try {
      const result = await apiRequest<ThresholdResult>("/storage/thresholds", { method: "POST", body: draftThresholds });
      setStorage((current) => current ? { ...current, thresholds: result.thresholds, ceilingBytes: result.ceilingBytes, measuredAt: result.measuredAt, usedPct: result.usedPct, tier: result.tier } : current);
      setNotice("Storage thresholds updated");
    } catch (caught) {
      setThresholdError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const saveRetention = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setRetentionError(null); setNotice(null);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) { setRetentionError("Retention days must be a whole number from 1 to 3650"); return; }
    if (retentionEnabled && exportTarget === "disabled") { setRetentionError("Choose an export target before enabling retention"); return; }
    setSavingRetention(true);
    try {
      const result = await apiRequest<RetentionResult>("/storage/retention", { method: "POST", body: { observationRetentionDays: retentionDays, exportTarget, exportLocation: exportTarget === "disabled" ? undefined : exportLocation, enabled: retentionEnabled } });
      setNotice(result.destructiveDeletion === "eligible_after_verified_export" ? "Retention saved. A compactor still verifies each export before any partition drop" : `Retention saved. ${result.remediation ?? "Destructive work remains blocked"}`.replace(";", ","));
      await load();
    } catch (caught) { setRetentionError(errorMessage(caught)); } finally { setSavingRetention(false); }
  };

  const compact = async () => {
    setNotice(null);
    setCompacting(true);
    try {
      const result = await apiRequest<CompactResult>("/storage/compact", { method: "POST" });
      setNotice(`Compaction job ${result.jobId} queued. The scheduler will process it; freed bytes appear after completion.`);
      await load();
    } catch (caught) {
      setNotice(`Compaction could not be queued: ${errorMessage(caught)}`);
    } finally {
      setCompacting(false);
    }
  };

  return <PageFrame actions={<Button disabled={!storage || compacting || storage.lastCompaction?.status === "pending" || storage.lastCompaction?.status === "claimed"} onClick={() => void compact()} variant="primary">{compacting ? "Queueing compaction" : "Queue compaction"}</Button>} description="Monitor the measured workspace footprint and queue compaction work" title="Storage">
    {error ? <AlertBanner title="Storage unavailable" tone="down">{error} <Button onClick={() => void load()} variant="ghost">Try again</Button></AlertBanner> : null}
    {notice ? <AlertBanner title="Storage update" tone="verifying">{notice}</AlertBanner> : null}
    {!storage && !error ? <StorageSkeleton /> : null}
    {storage ? <>
      <Footprint storage={storage} />
      <div className="console-grid">
        <Card className="console-card-body"><div className="console-kpi-label">Retention safety</div><div style={{ marginTop: 9 }}><StatusBadge status={storage.retention.destructiveDeletion === "eligible_after_verified_export" ? "verifying" : "idle"}>{storage.retention.destructiveDeletion === "eligible_after_verified_export" ? "Export-gated" : "Blocked"}</StatusBadge></div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>Verified exports: {storage.retention.checkpoints.export_verified ?? 0}, dropped partitions: {storage.retention.checkpoints.dropped ?? 0}</p></Card>
        <Card className="console-card-body"><div className="console-kpi-label">Capture posture</div><div style={{ marginTop: 9 }}><StatusBadge status={tierStatus(storage.tier)}>{storage.pressure ? `${storage.pressure.captureMode} · ${storage.pressure.journalMode === "aggregate_only" ? "aggregate-only" : `${Math.round(storage.pressure.payloadSampleRate * 100)}% sample`}` : "Awaiting measurement"}</StatusBadge></div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{storage.pressure?.source === "fallback" ? "No persisted pressure state yet; standard capture is active." : "Derived from the latest durable storage-pressure measurement."}</p></Card>
        <Card className="console-card-body"><div className="console-kpi-label">Growth rate</div><div className="console-kpi-value" style={{ fontSize: 18 }}>{formatRate(storage.growthBytesPerDay)}</div><p className="console-muted" style={{ fontSize: 13, margin: "10px 0 0" }}>Forecast exhaustion: {formatDate(storage.forecastExhaustionAt)}</p></Card>
      </div>
      <div className="console-grid">
        <TableBreakdown storage={storage} />
        <ThresholdForm error={thresholdError} onChange={setValues} onSubmit={saveThresholds} ordered={ordered} previewTier={previewTier} saving={saving} values={values} usedPct={storage.usedPct} />
      </div>
      <RetentionForm days={retentionDays} enabled={retentionEnabled} error={retentionError} exportLocation={exportLocation} exportTarget={exportTarget} onDays={setRetentionDays} onEnabled={setRetentionEnabled} onLocation={setExportLocation} onTarget={setExportTarget} onSubmit={saveRetention} saving={savingRetention} />
      <CompactionCard compaction={storage.lastCompaction} />
    </> : null}
  </PageFrame>;
}

function RetentionForm({ days, enabled, error, exportLocation, exportTarget, onDays, onEnabled, onLocation, onSubmit, onTarget, saving }: { days: number; enabled: boolean; error: string | null; exportLocation: string; exportTarget: "disabled" | "local_filesystem" | "object_storage"; onDays: (value: number) => void; onEnabled: (value: boolean) => void; onLocation: (value: string) => void; onTarget: (value: "disabled" | "local_filesystem" | "object_storage") => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; saving: boolean }) {
  return <Card className="console-card-body"><div className="console-kpi-label">Retention and export</div><form className="console-form" onSubmit={onSubmit} style={{ marginTop: 14 }}><div className="console-form-row"><label className="console-field"><span>Observation retention days</span><Input min="1" max="3650" onChange={(event) => onDays(Number(event.target.value))} required type="number" value={days} /></label><label className="console-field"><span>Export target</span><select onChange={(event) => onTarget(event.target.value as typeof exportTarget)} value={exportTarget}><option value="disabled">Disabled</option><option value="local_filesystem">Local filesystem (non-production)</option><option value="object_storage">Object storage</option></select></label></div>{exportTarget !== "disabled" ? <label className="console-field"><span>Operator-managed export location</span><Input onChange={(event) => onLocation(event.target.value)} required value={exportLocation} /></label> : null}<label className="console-checkbox"><input checked={enabled} onChange={(event) => onEnabled(event.target.checked)} type="checkbox" /> Enable retention after verified export</label><p className="console-muted" style={{ fontSize: 13, margin: 0 }}>Compaction will only drop allowlisted observation partitions after a durable manifest hash and checkpoint are verified. Audit, budget, config, and aggregate lineage are never retention targets.</p>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<div><Button disabled={saving} type="submit" variant="primary">{saving ? "Saving retention" : "Save retention"}</Button></div></form></Card>;
}

function StorageSkeleton() {
  return <Card className="console-card-body"><div className="console-stack"><Skeleton style={{ height: 26, width: "26%" }} /><Skeleton style={{ height: 128 }} /><Skeleton style={{ height: 48 }} /></div></Card>;
}

function Footprint({ storage }: { storage: StorageResponse }) {
  const gaugeValue = storage.usedPct === null ? 0 : Math.min(100, Math.max(0, storage.usedPct));
  const gaugeLabel = storage.usedPct === null ? "Unavailable" : `${storage.usedPct.toFixed(1)}%`;
  return <Card className="console-card-body"><div style={{ alignItems: "center", display: "grid", gap: 20, gridTemplateColumns: "minmax(160px, 230px) minmax(0, 1fr)" }}>
    <div aria-label={`Storage footprint ${gaugeLabel}`} role="img" style={{ alignItems: "center", aspectRatio: "1", background: `conic-gradient(var(--${tierStatus(storage.tier) === "down" ? "down" : tierStatus(storage.tier) === "verifying" ? "verifying" : "up"}) ${gaugeValue * 3.6}deg, var(--surface-raised) 0)`, borderRadius: "50%", display: "grid", justifyItems: "center", margin: "0 auto", maxWidth: 210, padding: 18 }}><div style={{ alignItems: "center", background: "var(--surface)", borderRadius: "50%", display: "grid", height: "100%", justifyItems: "center", textAlign: "center", width: "100%" }}><strong className="console-mono" style={{ fontSize: 25 }}>{gaugeLabel}</strong><span className="console-muted" style={{ fontSize: 12 }}>of ceiling</span></div></div>
    <div className="console-stack"><div><div className="console-kpi-label">Measured footprint</div><div className="console-kpi-value">{formatBytes(storage.usedBytes)}</div></div><div className="console-grid"><Metric label="Tier" value={<StatusBadge status={tierStatus(storage.tier)}>{tierLabel(storage.tier)}</StatusBadge>} /><Metric label="Ceiling" value={formatBytes(storage.ceilingBytes)} /><Metric label="Measured" value={formatDate(storage.measuredAt)} /></div></div>
  </div></Card>;
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="console-kpi-label">{label}</div><div className="console-mono" style={{ fontSize: 14, marginTop: 7 }}>{value}</div></div>;
}

function TableBreakdown({ storage }: { storage: StorageResponse }) {
  const tables = Object.entries(storage.tables ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return <Card className="console-card-body"><div className="console-kpi-label">Measured breakdown</div><div className="console-stack" style={{ marginTop: 14 }}><Metric label="Indexes" value={formatBytes(storage.indexesBytes)} /><Metric label="TOAST" value={formatBytes(storage.toastBytes)} /></div><div style={{ marginTop: 16 }}>{tables.length ? <div className="console-table-wrap"><table className="console-table" style={{ minWidth: 0 }}><thead><tr><th>Table</th><th>Bytes</th></tr></thead><tbody>{tables.map(([name, bytes]) => <tr key={name}><td className="console-mono">{name}</td><td className="console-mono">{formatBytes(bytes)}</td></tr>)}</tbody></table></div> : <EmptyState description="The latest measurement does not include per-table data." title="No table breakdown" />}</div></Card>;
}

function ThresholdForm({ error, onChange, onSubmit, ordered, previewTier, saving, usedPct, values }: { error: string | null; onChange: React.Dispatch<React.SetStateAction<{ warnPct: string; highPct: string; critPct: string }>>; onSubmit: (event: FormEvent<HTMLFormElement>) => void; ordered: boolean; previewTier: string | null; saving: boolean; usedPct: number | null; values: { warnPct: string; highPct: string; critPct: string } }) {
  return <Card className="console-card-body"><div className="console-kpi-label">Thresholds</div><form className="console-form" onSubmit={onSubmit} style={{ marginTop: 14 }}><div className="console-form-row">{(["warnPct", "highPct", "critPct"] as const).map((field) => <label className="console-field" key={field}><span>{field === "warnPct" ? "Warning" : field === "highPct" ? "High" : "Critical"}</span><Input inputMode="numeric" max="100" min="1" onChange={(event) => onChange((current) => ({ ...current, [field]: event.target.value }))} required type="number" value={values[field]} /></label>)}</div><p className="console-muted" style={{ fontSize: 13, margin: 0 }}>{usedPct === null ? "A live boundary preview is unavailable until a storage measurement exists" : !ordered ? "Set warning, high, and critical boundaries in ascending order" : <>At the current {usedPct.toFixed(1)}% footprint, this would be <StatusBadge status={tierStatus(previewTier)}>{tierLabel(previewTier)}</StatusBadge></>}</p>{error ? <p className="console-form-error" role="alert">{error}</p> : null}<div><Button disabled={saving} type="submit" variant="primary">{saving ? "Saving thresholds" : "Save thresholds"}</Button></div></form></Card>;
}

function CompactionCard({ compaction }: { compaction: Compaction | null }) {
  if (!compaction) return <Card><EmptyState description="Queue a compaction request when maintenance is needed. The worker reports verified export progress when configured." title="No compaction jobs" /></Card>;
  const status = compaction.status === "failed" || compaction.status === "dead" ? "down" : compaction.status === "done" ? "up" : "verifying";
  return <Card className="console-card-body"><div className="console-kpi-label">Last compaction job</div><div className="console-grid" style={{ marginTop: 14 }}><Metric label="Job" value={compaction.id} /><Metric label="Status" value={<StatusBadge status={status}>{tierLabel(compaction.status)}</StatusBadge>} /><Metric label="Queued" value={formatDate(compaction.queuedAt)} /><Metric label="Claimed" value={formatDate(compaction.claimedAt)} /><Metric label="Last update" value={formatDate(compaction.updatedAt)} /><Metric label="Bytes freed" value={formatBytes(compaction.freedBytes)} /></div>{compaction.progress?.steps?.length ? <p className="console-muted" style={{ fontSize: 13, margin: "14px 0 0" }}>Progress: {compaction.progress.steps.join(" → ")}{compaction.progress.blocker?.missing?.length ? `, blocked by ${compaction.progress.blocker.missing.join(", ")}` : ""}</p> : null}{compaction.error ? <p className="console-muted" style={{ fontSize: 13, margin: "8px 0 0" }}>The job recorded a failure. See the remediation in its progress state.</p> : null}</Card>;
}
