"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import { TelemetryFilterControls, type TelemetryRange, useTelemetryFilters } from "@/components/telemetry/telemetry-filters";

type Grain = "hourly" | "daily" | "monthly";
type Dimension = "route" | "provider" | "app" | "team" | "cost_center" | "model" | "status" | "profile";
type StringInteger = string;

type UsageRow = {
  grain: Grain;
  bucket_start: string;
  dimension: Dimension;
  dimension_value: string | null;
  dims: Record<string, string | null>;
  requests: StringInteger;
  input_tokens: StringInteger;
  output_tokens: StringInteger;
  cache_read_tokens: StringInteger;
  reasoning_tokens: StringInteger;
  cost_microusd: StringInteger;
  errors: StringInteger;
  failovers: StringInteger;
  latency_ms_sum: StringInteger;
  latency_ms_p95: number | null;
  updated_at: string;
};

type UsageResponse = {
  data: UsageRow[];
  next_cursor: string | null;
  compaction_boundary_note: { requested_grain: Grain; fallback_grain: Grain | null; boundary: string | null; message: string } | null;
};

type DiscoveryResponse = { data: Array<Record<string, unknown>>; nextCursor?: string | null };
type Filters = { grain: Grain; dimension: Dimension; dimensionValue: string };

const dimensions: Array<{ value: Dimension; label: string }> = [
  { value: "route", label: "Route" }, { value: "provider", label: "Provider" }, { value: "app", label: "App" },
  { value: "team", label: "Team" }, { value: "cost_center", label: "Cost center" }, { value: "model", label: "Model" },
  { value: "status", label: "Status" }, { value: "profile", label: "Profile" },
];

function defaultFilters(): Filters { return { grain: "hourly", dimension: "provider", dimensionValue: "" }; }

function timeRange(range: TelemetryRange) {
  const to = new Date();
  const duration: Record<TelemetryRange, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
  return { from: new Date(to.valueOf() - duration[range]).toISOString(), to: to.toISOString() };
}

function errorMessage(error: unknown) {
  if (error instanceof ControlPlaneApiError) return error.message;
  return error instanceof Error ? error.message : "Unable to load usage";
}

function integer(value: string | number | bigint): bigint {
  try { return BigInt(String(value)); } catch { return 0n; }
}

function grouped(value: string | number | bigint) {
  const source = integer(value).toString();
  const sign = source.startsWith("-") ? "-" : "";
  const digits = sign ? source.slice(1) : source;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

// Values are kept as integer strings from the API. This only rounds the visible USD cents.
function microusd(value: string | number | bigint) {
  const raw = integer(value);
  const sign = raw < 0n ? "-" : "";
  const absolute = raw < 0n ? -raw : raw;
  let cents = absolute / 10_000n;
  const remainder = absolute % 10_000n;
  if (remainder > 5_000n || (remainder === 5_000n && cents % 2n === 1n)) cents += 1n;
  const whole = cents / 100n;
  return `${sign}$${grouped(whole)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function dateLabel(value: string, grain: Grain) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const options: Intl.DateTimeFormatOptions = grain === "hourly"
    ? { month: "short", day: "numeric", hour: "numeric" }
    : grain === "daily" ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function keyFor(row: UsageRow) { return `${row.bucket_start}|${row.grain}|${row.dimension_value ?? "unattributed"}`; }

function seriesColor(index: number) {
  const colors = ["var(--accent)", "var(--up)", "var(--verifying)", "#b58cff", "#4bc4bd", "#e47fba", "#d2b36b", "#8396e8"];
  return colors[index % colors.length];
}

function queryFor(filters: Filters, cursor: string | null, range: TelemetryRange, profile: string) {
  const params = new URLSearchParams({ limit: "100", grain: filters.grain, dimension: filters.dimension });
  const { from, to } = timeRange(range);
  params.set("from", from); params.set("to", to);
  if (cursor) params.set("cursor", cursor);
  if (filters.dimensionValue.trim()) params.set("dimension_value", filters.dimensionValue.trim());
  params.set("profile", profile);
  return params;
}

function labelFor(row: UsageRow, names: Map<string, string>) {
  const value = row.dimension_value;
  if (!value) return "Unattributed";
  return names.get(value) ?? value;
}

export function UsageConsole() {
  const { profile, range, setTelemetryFilters } = useTelemetryFilters();
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [applied, setApplied] = useState<Filters>(filters);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [boundaryNote, setBoundaryNote] = useState<UsageResponse["compaction_boundary_note"]>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null, replace: boolean, active = applied) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    setError(null);
    try {
      const result = await apiRequest<UsageResponse>(`/usage?${queryFor(active, cursor, range, profile).toString()}`);
      setRows((current) => replace ? result.data : [...current, ...result.data.filter((row) => !current.some((known) => keyFor(known) === keyFor(row)))]);
      setNextCursor(result.next_cursor);
      setBoundaryNote(result.compaction_boundary_note);
    } catch (caught) {
      setError(errorMessage(caught));
      if (replace) { setRows([]); setNextCursor(null); setBoundaryNote(null); }
    } finally { setLoading(false); setLoadingMore(false); }
  }, [applied, profile, range]);

  useEffect(() => { void load(null, true); }, [load]);
  useEffect(() => { void discoverNames(applied.dimension).then(setNames); }, [applied.dimension]);

  const totals = useMemo(() => rows.reduce((total, row) => ({
    cost: total.cost + integer(row.cost_microusd), input: total.input + integer(row.input_tokens), output: total.output + integer(row.output_tokens),
    requests: total.requests + integer(row.requests), errors: total.errors + integer(row.errors), failovers: total.failovers + integer(row.failovers),
  }), { cost: 0n, input: 0n, output: 0n, requests: 0n, errors: 0n, failovers: 0n }), [rows]);
  const activeFilterCount = useMemo(() => [applied.dimensionValue].filter(Boolean).length, [applied]);
  const apply = () => setApplied({ ...filters });
  const clear = () => { const next = defaultFilters(); setFilters(next); setApplied(next); };

  return <PageFrame title="Usage & Costs" description="Durable token and spend aggregates across request compaction">
    <div className="console-stack" style={{ gap: 16 }}>
      <Card style={{ padding: 12 }}>
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <TelemetryFilterControls onChange={setTelemetryFilters} profile={profile} range={range} />
          <label className="console-field"><span>Grain</span><Select aria-label="Usage grain" onChange={(e) => setFilters((v) => ({ ...v, grain: e.target.value as Grain }))} value={filters.grain}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="monthly">Monthly</option></Select></label>
          <label className="console-field"><span>Pivot</span><Select aria-label="Usage dimension pivot" onChange={(e) => setFilters((v) => ({ ...v, dimension: e.target.value as Dimension, dimensionValue: "" }))} value={filters.dimension}>{dimensions.map((dimension) => <option key={dimension.value} value={dimension.value}>{dimension.label}</option>)}</Select></label>
          <label className="console-field"><span>Dimension value</span><Input aria-label="Filter pivot dimension value" onChange={(e) => setFilters((v) => ({ ...v, dimensionValue: e.target.value }))} placeholder="Exact ID or value" value={filters.dimensionValue} /></label>
        </div>
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}><Button onClick={apply} variant="primary">Apply filters</Button><Button onClick={clear} variant="ghost">Clear</Button><span className="console-muted" style={{ fontSize: 12 }}>Aggregate values are retained after request detail is compacted.</span></div>
      </Card>
      {boundaryNote ? <AlertBanner title="Compaction boundary" tone="verifying">{boundaryNote.message}</AlertBanner> : null}
      {error ? <AlertBanner title="Usage unavailable" tone="down">{error} <Button onClick={() => void load(null, true)} variant="outline">Retry</Button></AlertBanner> : null}
      {loading ? <UsageSkeleton /> : null}
      {!loading && !error && rows.length === 0 ? <EmptyState title="No usage in range" description={activeFilterCount ? "Try broadening or clearing the active filters." : "Usage aggregates will appear here as requests are recorded."} action={activeFilterCount ? <Button onClick={clear} variant="outline">Clear filters</Button> : undefined} /> : null}
      {!loading && rows.length > 0 ? <>
        <div className="console-grid"><Metric label="Cost" value={microusd(totals.cost)} /><Metric label="Input tokens" value={grouped(totals.input)} /><Metric label="Output tokens" value={grouped(totals.output)} /><Metric label="Requests" value={grouped(totals.requests)} /></div>
        <UsageChart names={names} rows={rows} />
        <TokenSplit input={totals.input} output={totals.output} />
        <UsageTable names={names} rows={rows} />
        {nextCursor ? <div style={{ display: "flex", justifyContent: "center" }}><Button disabled={loadingMore} onClick={() => void load(nextCursor, false)} variant="outline">{loadingMore ? "Loading more aggregates" : "Load more aggregates"}</Button></div> : null}
      </> : null}
    </div>
  </PageFrame>;
}

function Metric({ label, value }: { label: string; value: string }) { return <Card className="console-kpi"><div className="console-kpi-label">{label}</div><div className="console-kpi-value">{value}</div></Card>; }

function UsageSkeleton() { return <><div className="console-grid"><Skeleton style={{ height: 92 }} /><Skeleton style={{ height: 92 }} /><Skeleton style={{ height: 92 }} /><Skeleton style={{ height: 92 }} /></div><Card style={{ padding: 16 }}><Skeleton style={{ height: 16, width: "30%" }} /><Skeleton style={{ height: 244, marginTop: 16 }} /></Card><Card style={{ padding: 16 }}><Skeleton style={{ height: 220 }} /></Card></>; }

function UsageChart({ names, rows }: { names: Map<string, string>; rows: UsageRow[] }) {
  const buckets = useMemo(() => [...new Map(rows.map((row) => [`${row.bucket_start}|${row.grain}`, { start: row.bucket_start, grain: row.grain }])).values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), [rows]);
  const series = useMemo(() => [...new Set(rows.map((row) => labelFor(row, names)))].slice(0, 8), [names, rows]);
  const amounts = useMemo(() => new Map(rows.map((row) => [`${row.bucket_start}|${row.grain}|${labelFor(row, names)}`, integer(row.cost_microusd)])), [names, rows]);
  const max = useMemo(() => buckets.reduce((highest, bucket) => {
    const total = series.reduce((sum, label) => sum + (amounts.get(`${bucket.start}|${bucket.grain}|${label}`) ?? 0n), 0n);
    return total > highest ? total : highest;
  }, 0n), [amounts, buckets, series]);
  const width = Math.max(560, buckets.length * 56); const height = 250; const plotHeight = 180; const base = 204;
  const ratio = (amount: bigint) => max === 0n ? 0 : Number((amount * 10000n) / max) / 10000;
  return <Card style={{ overflow: "hidden", padding: 16 }}><div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}><div><div className="console-kpi-label">Cost over returned buckets</div><p className="console-muted" style={{ fontSize: 12, margin: "5px 0 0" }}>Stacked by {rows[0]?.dimension ?? "dimension"} with each row retaining its reported grain.</p></div><span className="console-muted console-mono" style={{ fontSize: 12 }}>µUSD → USD display</span></div><div aria-label="Scrollable cost chart" role="region" style={{ overflowX: "auto", paddingTop: 12 }} tabIndex={0}><svg aria-label="Stacked cost chart" height={height} role="img" style={{ display: "block", minWidth: width, width: "100%" }} viewBox={`0 0 ${width} ${height}`}><title>Cost over time, stacked by the selected pivot</title><line stroke="var(--border)" x1="0" x2={width} y1={base} y2={base} />{buckets.map((bucket, index) => { const x = index * (width / buckets.length) + 8; const barWidth = Math.max(10, width / buckets.length - 16); let accumulated = 0; return <g key={`${bucket.start}|${bucket.grain}`}><title>{`${dateLabel(bucket.start, bucket.grain)} (${bucket.grain})`}</title>{series.map((label, seriesIndex) => { const amount = amounts.get(`${bucket.start}|${bucket.grain}|${label}`) ?? 0n; const barHeight = ratio(amount) * plotHeight; accumulated += barHeight; return barHeight > 0 ? <rect fill={seriesColor(seriesIndex)} height={barHeight} key={label} opacity=".9" rx="2" width={barWidth} x={x} y={base - accumulated}><title>{`${label}: ${microusd(amount)}`}</title></rect> : null; })}<text fill="var(--fg-faint)" fontSize="10" textAnchor="middle" x={x + barWidth / 2} y="224">{dateLabel(bucket.start, bucket.grain)}</text><text fill="var(--fg-faint)" fontSize="9" textAnchor="middle" x={x + barWidth / 2} y="238">{bucket.grain}</text></g>; })}</svg></div><div aria-label="Chart legend" style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 8 }}>{series.map((label, index) => <span className="console-muted" key={label} style={{ alignItems: "center", display: "inline-flex", fontSize: 12, gap: 5 }}><span aria-hidden="true" style={{ background: seriesColor(index), borderRadius: 2, height: 9, width: 9 }} />{label}</span>)}</div></Card>;
}

function TokenSplit({ input, output }: { input: bigint; output: bigint }) { const total = input + output; const share = total > 0n ? Number((input * 10000n) / total) / 100 : 0; return <Card className="console-card-body"><div className="console-kpi-label">Token split</div><div aria-label={`Input ${grouped(input)} tokens, output ${grouped(output)} tokens`} role="img" style={{ background: "var(--surface-hover)", borderRadius: 99, display: "flex", height: 12, marginTop: 12, overflow: "hidden" }}><span style={{ background: "var(--accent)", width: `${share}%` }} /><span style={{ background: "var(--up)", width: `${100 - share}%` }} /></div><div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 9 }}><span className="console-muted"><span aria-hidden="true" style={{ color: "var(--accent)" }}>●</span> Input {grouped(input)}</span><span className="console-muted"><span aria-hidden="true" style={{ color: "var(--up)" }}>●</span> Output {grouped(output)}</span></div></Card>; }

function UsageTable({ names, rows }: { names: Map<string, string>; rows: UsageRow[] }) { return <Card style={{ overflow: "hidden" }}><div style={{ padding: "14px 16px 0" }}><div className="console-kpi-label">Aggregate rows</div><p className="console-muted" style={{ fontSize: 12, margin: "5px 0 12px" }}>String integers are displayed without numeric coercion. Cost is shown in USD rounded from µUSD.</p></div><div aria-label="Scrollable usage aggregate table" className="console-table-wrap" role="region" style={{ borderLeft: 0, borderRadius: 0, borderRight: 0 }} tabIndex={0}><table className="console-table" style={{ minWidth: 1180 }}><thead><tr><th>Bucket</th><th>Grain</th><th>Pivot</th><th>Input / output</th><th>Requests</th><th>Errors / failovers</th><th>P95 latency</th><th>Cost</th></tr></thead><tbody>{rows.map((row) => <tr key={keyFor(row)}><td className="console-muted" style={{ whiteSpace: "nowrap" }}>{dateLabel(row.bucket_start, row.grain)}</td><td><span className="console-mono" style={{ fontSize: 12 }}>{row.grain}</span></td><td title={row.dimension_value ?? undefined}>{labelFor(row, names)}</td><td className="console-mono" style={{ whiteSpace: "nowrap" }}>{grouped(row.input_tokens)} / {grouped(row.output_tokens)}</td><td className="console-mono">{grouped(row.requests)}</td><td className="console-mono">{grouped(row.errors)} / {grouped(row.failovers)}</td><td className="console-mono">{row.latency_ms_p95 === null ? "—" : `${grouped(row.latency_ms_p95)} ms`}</td><td className="console-mono" title={`${grouped(row.cost_microusd)} µUSD`}>{microusd(row.cost_microusd)}</td></tr>)}</tbody></table></div></Card>; }

async function discoverNames(dimension: Dimension): Promise<Map<string, string>> {
  const endpoint = dimension === "route" ? "/routes?limit=100" : dimension === "app" ? "/apps?limit=100" : dimension === "team" ? "/teams?limit=100" : dimension === "cost_center" ? "/cost-centers?limit=100" : dimension === "model" ? "/models?limit=100" : dimension === "profile" ? "/profiles?limit=100" : null;
  if (!endpoint) return new Map();
  try {
    const result = await apiRequest<DiscoveryResponse>(endpoint);
    return new Map(result.data.flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : null;
      if (!id) return [];
      const canonical = item.canonicalModel as Record<string, unknown> | undefined;
      const label = typeof item.publicName === "string" ? item.publicName : typeof item.name === "string" ? item.name : typeof item.hostname === "string" ? item.hostname : typeof canonical?.displayName === "string" ? canonical.displayName : typeof canonical?.slug === "string" ? canonical.slug : null;
      const pairs: Array<[string, string]> = label ? [[id, label]] : [];
      if (dimension === "model" && typeof canonical?.id === "string" && label) pairs.push([canonical.id, label]);
      return pairs;
    }));
  } catch { return new Map(); }
}
