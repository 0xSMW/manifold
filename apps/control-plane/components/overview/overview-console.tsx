"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { telemetryHref, TelemetryFilterControls, useTelemetryFilters, type TelemetryProfile, type TelemetryRange } from "@/components/telemetry/telemetry-filters";
import styles from "./overview.module.css";
import { StatusBadge, StatusDot, type Status } from "@/components/ui/status";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

type Range = TelemetryRange;
type Profile = TelemetryProfile;

interface Health { status: "ok" | "degraded" | "down"; ingest_lag_seconds: number | null; }
interface Me {
  scopes: string[];
  availableIngressProfiles: Array<{ id: string; installationId: string; installationName?: string; hostname?: string; mode: Profile }>;
}
interface Page<T> { data: T[]; nextCursor?: string | null; next_cursor?: string | null; }
interface Provider { id: string; provider: string; status: string; }
interface Route { id: string; publicName?: string; }
interface Key { id: string; revoked?: boolean; expired?: boolean; }
interface Observation {
  trace_id: string; profile_mode: Profile; provider: string | null; status: string;
  route: { public_name: string | null }; input_tokens: string | null; output_tokens: string | null;
  cost_microusd: string | null; latency_ms: number | null; occurred_at: string; failovers: number;
}
interface Observations extends Page<Observation> { ingest_lag_seconds: number | null; }
interface LatencySummary { sample_count: string; p50_ms: number | null; p95_ms: number | null; }
interface Usage {
  bucket_start: string; dimension_value: string | null; dims: Record<string, string | null>;
  requests: string; input_tokens: string; output_tokens: string; cost_microusd: string;
  errors: string; failovers: string; latency_ms_sum: string; latency_ms_p95: number | null;
}
interface Budget {
  id: string; scope: { type: string; id: string | null }; unit: string; limitAmount: string;
  counters: { current: string }; burn: { ratio?: number; percent?: number } | null;
}
interface CostCenter { id: string; name: string; slug: string; }
interface Snapshot {
  health: Health; me: Me; observations: Observations; latencySummary: LatencySummary; providerUsage: Usage[]; costCenterUsage: Usage[];
  budgets: Budget[] | null; costCenters: CostCenter[] | null; providers: Provider[] | null; routes: Route[]; keys: Key[] | null;
  from: string; to: string; profile: Profile;
}
interface Metrics {
  requests: bigint; input: bigint; output: bigint; spend: bigint; errors: bigint; failovers: bigint;
  p50: string; p95: string;
}

const numberFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const wholeFormat = new Intl.NumberFormat("en-US");

function errorText(error: unknown): string {
  return error instanceof ControlPlaneApiError ? error.payload.remediation ?? error.message : error instanceof Error ? error.message : "Unable to load overview";
}
function sum(rows: Usage[], field: keyof Pick<Usage, "requests" | "input_tokens" | "output_tokens" | "cost_microusd" | "errors" | "failovers" | "latency_ms_sum">): bigint {
  return rows.reduce((total, row) => { try { return total + BigInt(row[field]); } catch { return total; } }, 0n);
}
function percent(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return "Unavailable";
  return `${(Number(numerator * 10_000n / denominator) / 100).toFixed(2)}%`;
}
function money(value: bigint): string {
  const dollars = Number(value) / 1_000_000;
  return Number.isFinite(dollars) ? dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : `${value.toString()} µ$`;
}
function compact(value: bigint): string { return Number.isSafeInteger(Number(value)) ? numberFormat.format(Number(value)) : value.toString(); }
function asStatus(value: string): Status { return value === "ok" || value === "valid" || value === "healthy" ? "up" : value === "down" || value === "error" || value === "invalid" ? "down" : "idle"; }
function timeRange(range: Range): { from: string; to: string } { const to = new Date(); const ms: Record<Range, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }; return { from: new Date(to.getTime() - ms[range]).toISOString(), to: to.toISOString() }; }
function query(from: string, to: string, profile: Profile, extra = ""): string { return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&profile=${profile}${extra}`; }

export function OverviewConsole() {
  const { profile, range, setTelemetryFilters } = useTelemetryFilters();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (nextRange = range, requestedProfile?: Profile) => {
    setError(null);
    const { from, to } = timeRange(nextRange);
    try {
      const me = await apiRequest<Me>("/me");
      const available = [...new Set(me.availableIngressProfiles.map((item) => item.mode))];
      const nextProfile = requestedProfile && available.includes(requestedProfile) ? requestedProfile : available.includes(profile) ? profile : available[0] ?? "public_app";
      const filters = query(from, to, nextProfile);
      const canRead = (scope: string) => me.scopes.includes(scope);
      const canReadBudgets = nextProfile === "enterprise_egress" && canRead("budgets:read");
      const [health, observations, latencySummary, providerUsage, costCenterUsage, budgets, costCenters, providers, routes, keys] = await Promise.all([
        apiRequest<Health>("/health"),
        apiRequest<Observations>(`/observations${filters}&limit=10`),
        apiRequest<LatencySummary>(`/observations/summary${filters}`),
        apiRequest<Page<Usage>>(`/usage${filters}&grain=hourly&dimension=provider&limit=200`),
        nextProfile === "enterprise_egress" ? apiRequest<Page<Usage>>(`/usage${filters}&grain=hourly&dimension=cost_center&limit=200`) : Promise.resolve({ data: [] }),
        canReadBudgets ? apiRequest<Page<Budget>>("/budgets?limit=100") : Promise.resolve(null),
        canReadBudgets ? apiRequest<Page<CostCenter>>("/cost-centers?limit=100") : Promise.resolve(null),
        canRead("providers:read") ? apiRequest<Page<Provider>>("/providers") : Promise.resolve(null),
        apiRequest<Page<Route>>("/routes"),
        canRead("keys:read") ? apiRequest<Page<Key>>("/keys") : Promise.resolve(null),
      ]);
      setSnapshot({ health, me, observations, latencySummary, providerUsage: providerUsage.data, costCenterUsage: costCenterUsage.data, budgets: budgets?.data ?? null, costCenters: costCenters?.data ?? null, providers: providers?.data ?? null, routes: routes.data, keys: keys?.data ?? null, from, to, profile: nextProfile });
    } catch (caught) { setError(errorText(caught)); }
  }, [profile, range]);

  useEffect(() => { void load(); }, [load]);

  const metrics = useMemo(() => {
    const rows = snapshot?.providerUsage ?? [];
    const requests = sum(rows, "requests"), input = sum(rows, "input_tokens"), output = sum(rows, "output_tokens"), spend = sum(rows, "cost_microusd"), errors = sum(rows, "errors"), failovers = sum(rows, "failovers");
    const latency = snapshot?.latencySummary;
    const latencyLabel = (value: number | null | undefined) => value === null || value === undefined ? "Unavailable" : `${wholeFormat.format(value)} ms`;
    return { requests, input, output, spend, errors, failovers, p50: latencyLabel(latency?.p50_ms), p95: latencyLabel(latency?.p95_ms) };
  }, [snapshot]);
  const hasTraffic = metrics.requests > 0n || (snapshot?.observations.data.length ?? 0) > 0;
  const profileOptions = [...new Set(snapshot?.me.availableIngressProfiles.map((item) => item.mode) ?? [])];
  const selectedProfile = snapshot?.me.availableIngressProfiles.find((item) => item.mode === profile);
  const configuredUrl = selectedProfile?.hostname ? `https://${selectedProfile.hostname}` : null;
  const curl = configuredUrl ? `curl ${configuredUrl}/v1/models -H "Authorization: Bearer $MANIFOLD_KEY"` : null;
  const copyCurl = async () => { if (!curl) return; await navigator.clipboard.writeText(curl); setCopied(true); window.setTimeout(() => setCopied(false), 1600); };

  return <PageFrame title="Overview" description="Gateway health, traffic, and spend at a glance" actions={<Button onClick={() => void load()}>Refresh</Button>}>
    <div style={{ display: "grid", gap: 16 }}>
      <Card style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, padding: 10 }}>
        <TelemetryFilterControls onChange={setTelemetryFilters} profile={profile} range={range} />
        {profileOptions.length === 1 ? <span className="console-muted" style={{ marginLeft: "auto" }}>{profile}</span> : null}
      </Card>
      {error ? <AlertBanner title="Overview could not load" tone="down">{error} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner> : null}
      {!snapshot ? <Loading /> : <>
        {snapshot.observations.ingest_lag_seconds !== null && snapshot.observations.ingest_lag_seconds > 5 ? <AlertBanner title="Request numbers are behind" tone="verifying">Ingest lag is {snapshot.observations.ingest_lag_seconds} seconds.</AlertBanner> : null}
        <Kpis metrics={metrics} />
        {!hasTraffic ? <FirstRun configuredUrl={configuredUrl} copyCurl={copyCurl} copied={copied} providers={snapshot.providers} routes={snapshot.routes} keys={snapshot.keys} /> : <>
          <div className={styles.trafficLayout}>
            <TrafficChart rows={snapshot.providerUsage} />
            <SideCards rows={snapshot.providerUsage} providers={snapshot.providers} />
          </div>
          <RecentTraces rows={snapshot.observations.data} />
          {snapshot.profile === "enterprise_egress" ? <BudgetBurn budgets={snapshot.budgets} costCenters={snapshot.costCenters} rows={snapshot.costCenterUsage} /> : null}
        </>}
      </>}
    </div>
  </PageFrame>;
}

function Loading() { return <div className="console-grid" aria-label="Loading overview">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} style={{ height: 94 }} />)}</div>; }
function Kpis({ metrics }: { metrics: Metrics }) { return <div className="console-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
  <Metric label="Requests" value={compact(metrics.requests)} /><Metric label="Input tokens" value={compact(metrics.input)} /><Metric label="Output tokens" value={compact(metrics.output)} /><Metric label="Spend" value={money(metrics.spend)} /><Metric label="P50 latency" value={metrics.p50} /><Metric label="P95 latency" value={metrics.p95} /><Metric label="Error rate" value={percent(metrics.errors, metrics.requests)} /><Metric label="Fallback rate" value={percent(metrics.failovers, metrics.requests)} />
</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <Card className="console-kpi"><div className="console-kpi-label">{label}</div><div className="console-kpi-value cp-mono" style={{ fontSize: 19 }}>{value}</div></Card>; }
function TrafficChart({ rows }: { rows: Usage[] }) {
  const bucketKeys = [...new Set(rows.map((row) => row.bucket_start))].sort();
  const providers = [...new Set(rows.map((row) => row.dimension_value ?? "Unavailable"))].sort();
  const value = new Map(rows.map((row) => [`${row.bucket_start}:${row.dimension_value ?? "Unavailable"}`, BigInt(row.requests)]));
  const totals = bucketKeys.map((bucket) => providers.reduce((total, provider) => total + (value.get(`${bucket}:${provider}`) ?? 0n), 0n));
  const max = totals.reduce((largest, total) => total > largest ? total : largest, 0n);
  const y = (total: bigint) => max === 0n ? 100 : 100 - Number(total * 92n / max);
  let lower = bucketKeys.map(() => 0n);
  const areas = providers.map((provider) => { const upper = lower.map((total, index) => total + (value.get(`${bucketKeys[index]}:${provider}`) ?? 0n)); const at = (index: number) => bucketKeys.length < 2 ? 0 : index / (bucketKeys.length - 1) * 100; const points = [...upper.map((total, index) => `${at(index)},${y(total)}`), ...lower.map((total, index) => `${at(lower.length - 1 - index)},${y(lower[lower.length - 1 - index])}`)].join(" "); lower = upper; return { provider, points }; });
  return <Card style={{ minWidth: 0, padding: 16 }}><div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between" }}><div><strong>Traffic by final provider</strong><div className="console-muted">Requests over the selected range</div></div><span className="cp-mono console-muted">{bucketKeys.length} buckets</span></div><svg aria-label="Stacked requests by final provider over time" preserveAspectRatio="none" role="img" style={{ display: "block", height: 180, marginTop: 16, width: "100%" }} viewBox="0 0 100 100"><line stroke="var(--border)" strokeWidth=".5" x1="0" x2="100" y1="100" y2="100" />{areas.map((area, index) => <polygon fill="var(--fg)" fillOpacity={.08 + index * .12} key={area.provider} points={area.points} stroke="var(--fg)" strokeOpacity={.32 + index * .1} strokeWidth=".5" vectorEffect="non-scaling-stroke" />)}</svg><div aria-label="Provider chart legend" className="console-muted" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}><span>{bucketKeys[0] ? new Date(bucketKeys[0]).toLocaleString() : "No buckets"}</span>{providers.map((provider) => <span className="cp-mono" key={provider}>{provider}</span>)}<span>{bucketKeys.at(-1) ? new Date(bucketKeys.at(-1)!).toLocaleString() : ""}</span></div></Card>;
}
function SideCards({ rows, providers }: { rows: Usage[]; providers: Provider[] | null }) { const spend = rows.map((row) => BigInt(row.cost_microusd)); const max = spend.reduce((total, value) => value > total ? value : total, 0n); const points = spend.slice().reverse().map((value, index, list) => `${list.length < 2 ? 0 : index / (list.length - 1) * 100},${max === 0n ? 100 : 100 - Number(value * 92n / max)}`).join(" "); return <div style={{ display: "grid", gap: 16 }}><Card style={{ padding: 16 }}><strong>Spend</strong><svg aria-label="Spend over time" preserveAspectRatio="none" role="img" style={{ display: "block", height: 64, marginTop: 10, width: "100%" }} viewBox="0 0 100 100"><polyline fill="none" points={points} stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg><span className="console-muted">Selected range</span></Card><Card style={{ padding: 16 }}><strong>Provider health</strong><div aria-label="Provider health" style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 12 }}>{providers === null ? <span className="console-muted">Unavailable</span> : providers.length === 0 ? <span className="console-muted">No providers configured</span> : providers.map((provider) => <span className="cp-mono" key={provider.id} style={{ alignItems: "center", display: "inline-flex", gap: 6 }}><StatusDot label={`${provider.provider}: ${provider.status}`} status={asStatus(provider.status)} />{provider.provider}</span>)}</div></Card></div>; }
function RecentTraces({ rows }: { rows: Observation[] }) { const { profile, range } = useTelemetryFilters(); return <Card style={{ overflow: "hidden" }}><div style={{ alignItems: "baseline", display: "flex", justifyContent: "space-between", padding: "14px 16px" }}><div><strong>Recent traces</strong><div className="console-muted">Most recent 10 requests</div></div><a className="cp-button" data-variant="outline" href={telemetryHref("/logs", range, profile)}>View all</a></div><div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse", width: "100%" }}><thead><tr style={{ color: "var(--fg-muted)", fontSize: 12, textAlign: "left" }}><th style={cell}>Time</th><th style={cell}>Trace</th><th style={cell}>Route</th><th style={cell}>Provider</th><th style={cell}>Status</th><th style={cell}>Latency</th></tr></thead><tbody>{rows.map((row) => <tr key={row.trace_id}><td className="cp-mono" style={cell}>{new Date(row.occurred_at).toLocaleTimeString()}</td><td style={cell}><a className="cp-mono" href={`/logs/${encodeURIComponent(row.trace_id)}?range=${range}&profile=${profile}`} style={{ color: "var(--accent)" }}>{row.trace_id}</a></td><td style={cell}>{row.route.public_name ?? "Unavailable"}</td><td style={cell}>{row.provider ?? "Unavailable"}</td><td style={cell}><StatusBadge status={asStatus(row.status)}>{row.status}</StatusBadge></td><td className="cp-mono" style={cell}>{row.latency_ms === null ? "Unavailable" : `${wholeFormat.format(row.latency_ms)} ms`}</td></tr>)}</tbody></table></div></Card>; }
const cell = { borderTop: "1px solid var(--border)", padding: "10px 16px", whiteSpace: "nowrap" as const };
function BudgetBurn({ budgets, costCenters, rows }: { budgets: Budget[] | null; costCenters: CostCenter[] | null; rows: Usage[] }) { const costs = new Map<string, bigint>(); rows.forEach((row) => { const key = row.dimension_value ?? "Unattributed"; costs.set(key, (costs.get(key) ?? 0n) + BigInt(row.cost_microusd)); }); const names = new Map(costCenters?.map((center) => [center.id, center.name]) ?? []); const budgetByCenter = new Map(budgets?.filter((budget) => budget.scope.type === "cost_center" && budget.unit === "cost_microusd").map((budget) => [budget.scope.id, budget]) ?? []); const top = [...costs.entries()].sort((a, b) => a[1] > b[1] ? -1 : 1).slice(0, 5); return <Card style={{ padding: 16 }}><strong>Top cost-center burn</strong><div className="console-muted">Spend in the selected range</div>{budgets === null || costCenters === null ? <p className="console-muted">Unavailable with this access.</p> : top.length === 0 ? <p className="console-muted">No cost-center spend in this range.</p> : <div style={{ display: "grid", gap: 10, marginTop: 14 }}>{top.map(([center, cost]) => { const budget = budgetByCenter.get(center); return <div key={center} style={{ alignItems: "center", display: "grid", gap: 3, gridTemplateColumns: "minmax(0, 1fr) auto" }}><span>{names.get(center) ?? center}</span><span className="cp-mono">{money(cost)}</span>{budget ? <span className="console-muted" style={{ gridColumn: "1 / -1" }}>Current budget window: {money(BigInt(budget.counters.current))} of {money(BigInt(budget.limitAmount))}</span> : null}</div>; })}</div>}</Card>; }
function FirstRun({ configuredUrl, copyCurl, copied, providers, routes, keys }: { configuredUrl: string | null; copyCurl: () => void; copied: boolean; providers: Provider[] | null; routes: Route[]; keys: Key[] | null }) { const providerReady = providers !== null && providers.length > 0; const routeReady = routes.length > 0; const keyReady = keys !== null && keys.some((key) => !key.revoked && !key.expired); return <Card><EmptyState title="Send your first request" description="Configure the gateway, publish its route, mint a key, then make one request to create your first trace." action={<div style={{ display: "grid", gap: 12, justifyItems: "center" }}><div className="console-actions"><a className="cp-button" data-variant={providerReady ? "outline" : "primary"} href="/providers">{providerReady ? "Providers ready" : "1. Add provider"}</a><a className="cp-button" data-variant={routeReady ? "outline" : "primary"} href="/routes">{routeReady ? "Route ready" : "2. Create route"}</a><a className="cp-button" data-variant="outline" href="/publish">3. Publish</a><a className="cp-button" data-variant={keyReady ? "outline" : "primary"} href="/keys">{keyReady ? "Key ready" : "4. Mint key"}</a><a className="cp-button" data-variant="outline" href="/logs">5. See first request</a></div>{configuredUrl ? <div style={{ display: "grid", gap: 8, maxWidth: "100%" }}><code className="console-code" style={{ overflowX: "auto" }}>{`base_url=${configuredUrl}/v1`}</code><code className="console-code" style={{ overflowX: "auto" }}>{`curl ${configuredUrl}/v1/models -H "Authorization: Bearer $MANIFOLD_KEY"`}</code><Button onClick={copyCurl} variant="outline">{copied ? "Copied" : "Copy curl"}</Button></div> : <p className="console-muted">Publish an ingress profile to reveal the configured base URL.</p>}</div>} /></Card>; }
