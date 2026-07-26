"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";
import { formatAmount, scopeLabel } from "./budget-format";
import type { Budget, Context, Key, Page, ScopeType } from "./budget-types";

function errorMessage(error: unknown) { return error instanceof ControlPlaneApiError ? error.payload.remediation ?? error.message : error instanceof Error ? error.message : "Unable to load budgets"; }

export function BudgetsConsole() {
  const toast = useToast();
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState("all");
  const [enforcement, setEnforcement] = useState("all");
  const [overBudget, setOverBudget] = useState("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async (cursor?: string | null) => {
    setError(null);
    const search = new URLSearchParams({ limit: "50" });
    if (cursor) search.set("cursor", cursor);
    if (scopeType !== "all") search.set("scopeType", scopeType);
    if (enforcement !== "all") search.set("enforcement", enforcement);
    if (overBudget !== "all") search.set("overBudget", overBudget);
    try {
      const [result, nextContext, nextKeys] = await Promise.all([
        apiRequest<Page<Budget>>(`/budgets?${search}`),
        context ? Promise.resolve(context) : apiRequest<Context>("/context"),
        keys ? Promise.resolve(keys) : apiRequest<Page<Key>>("/keys").then((result) => result.data).catch(() => null),
      ]);
      setBudgets((current) => cursor ? [...(current ?? []), ...result.data] : result.data);
      setNextCursor(result.nextCursor);
      setContext(nextContext);
      setKeys(nextKeys);
    } catch (caught) { setError(errorMessage(caught)); if (!cursor) setBudgets([]); }
  }, [context, enforcement, keys, overBudget, scopeType]);

  useEffect(() => { void load(); }, [load]);
  const hierarchy = useMemo(() => orderHierarchy(budgets ?? []), [budgets]);

  return <PageFrame actions={<Button onClick={() => setSheetOpen(true)} variant="primary">New budget</Button>} description="Set advisory or hard caps, inspect consumption, then Publish staged enforcement" title="Budgets">
    <div className="console-stack">
      {error ? <AlertBanner title="Budgets could not load" tone="down">{error} <Button onClick={() => void load()} variant="outline">Retry</Button></AlertBanner> : null}
      <AlertBanner title="Enforcement is staged" tone="verifying">Creating a budget or allocation changes desired configuration. <a href="/publish" style={{ color: "var(--accent)" }}>Open Publish</a> before gateway enforcement can change.</AlertBanner>
      <Card style={{ overflow: "hidden" }}>
        <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, padding: 12 }}>
          <Select aria-label="Filter scope" onChange={(event) => setScopeType(event.target.value)} value={scopeType}><option value="all">All scopes</option><option value="workspace">Workspace</option><option value="team">Teams</option><option value="app">Apps</option><option value="cost_center">Cost centers</option><option value="key">Keys</option></Select>
          <Select aria-label="Filter enforcement" onChange={(event) => setEnforcement(event.target.value)} value={enforcement}><option value="all">All enforcement</option><option value="advisory">Advisory</option><option value="hard">Hard</option></Select>
          <Select aria-label="Filter budget state" onChange={(event) => setOverBudget(event.target.value)} value={overBudget}><option value="all">All budget states</option><option value="true">Over budget</option><option value="false">Within budget</option></Select>
        </div>
        {budgets === null ? <div style={{ display: "grid", gap: 8, padding: 12 }}><Skeleton style={{ height: 46 }} /><Skeleton style={{ height: 46 }} /><Skeleton style={{ height: 46 }} /></div> : null}
        {budgets?.length === 0 && !error ? <EmptyState action={<Button onClick={() => setSheetOpen(true)} variant="primary">Create budget</Button>} description="Create a staged budget to begin tracking cost or token consumption" title="No budgets yet" /> : null}
        {hierarchy.length > 0 ? <div style={{ overflowX: "auto" }}><table className="console-table"><thead><tr><th>Scope</th><th>Cap</th><th>Current</th><th>Forecast</th><th>Enforcement</th><th>State</th></tr></thead><tbody>{hierarchy.map(({ budget, depth }) => <tr key={budget.id}><td><a href={`/budgets/${budget.id}`} style={{ color: "var(--accent)", fontWeight: 650, paddingLeft: depth * 18 }}>{scopeLabel(budget.scope, context, keys)}</a><div className="console-muted" style={{ fontSize: 12, paddingLeft: depth * 18 }}>{budget.window.replaceAll("_", " ")}</div></td><td className="console-mono">{formatAmount(budget.limitAmount, budget.unit)}</td><td className="console-mono">{formatAmount(budget.counters.current, budget.unit)}</td><td className="console-mono">{budget.burn.forecastAmount ? formatAmount(budget.burn.forecastAmount, budget.unit) : "Unavailable"}</td><td><StatusBadge status={budget.enforcement === "hard" ? "verifying" : "idle"}>{budget.enforcement}</StatusBadge></td><td><StatusBadge status={budget.overBudget ? "down" : "verifying"}>{budget.overBudget ? "Over cap" : "Staged"}</StatusBadge></td></tr>)}</tbody></table></div> : null}
        {nextCursor ? <div style={{ padding: 12 }}><Button onClick={() => void load(nextCursor)}>Load more budgets</Button></div> : null}
      </Card>
    </div>
    <CreateBudgetSheet accounts={budgets ?? []} context={context} keys={keys} onClose={() => setSheetOpen(false)} onCreated={(budget) => { setBudgets((current) => [budget, ...(current ?? [])]); setSheetOpen(false); toast("Budget staged for Publish", "verifying"); }} open={sheetOpen} />
  </PageFrame>;
}

function orderHierarchy(budgets: Budget[]) {
  const children = new Map<string | null, Budget[]>();
  for (const budget of budgets) children.set(budget.parentId, [...(children.get(budget.parentId) ?? []), budget]);
  const output: Array<{ budget: Budget; depth: number }> = [];
  const visit = (items: Budget[], depth: number) => items.sort((a, b) => a.id.localeCompare(b.id)).forEach((budget) => { output.push({ budget, depth }); visit(children.get(budget.id) ?? [], depth + 1); });
  visit(children.get(null) ?? [], 0);
  for (const budget of budgets) if (!output.some((item) => item.budget.id === budget.id)) visit([budget], 0);
  return output;
}

function CreateBudgetSheet({ accounts, context, keys, onClose, onCreated, open }: { accounts: Budget[]; context: Context | null; keys: Key[] | null; onClose: () => void; onCreated: (budget: Budget) => void; open: boolean }) {
  const [scopeType, setScopeType] = useState<ScopeType>("workspace"); const [scopeId, setScopeId] = useState(""); const [parentId, setParentId] = useState(""); const [unit, setUnit] = useState<Budget["unit"]>("cost_microusd"); const [window, setWindow] = useState("monthly"); const [limitAmount, setLimitAmount] = useState(""); const [enforcement, setEnforcement] = useState<Budget["enforcement"]>("advisory"); const [catalog, setCatalog] = useState(""); const [error, setError] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  const scopeOptions = scopeType === "team" ? context?.teams ?? [] : scopeType === "app" ? context?.apps ?? [] : scopeType === "cost_center" ? context?.costCenters ?? [] : scopeType === "key" ? (keys ?? []).map((item) => ({ ...item, name: item.displayPrefix, slug: item.displayPrefix })) : [];
  const matchingParents = accounts.filter((item) => item.unit === unit && item.window === window);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); if (!/^\d+$/.test(limitAmount)) { setError("Enter a non-negative whole-number cap"); return; } if (scopeType !== "workspace" && !scopeId) { setError("Select a scope"); return; } if (enforcement === "hard" && !catalog.trim()) { setError("Hard caps require a verified pricing catalog revision"); return; } setSaving(true); try { const result = await apiRequest<{ id: string }>("/budgets", { method: "POST", body: { scopeType, scopeId: scopeType === "workspace" ? null : scopeId, parentId: parentId || null, unit, currency: "USD", window, limitAmount, enforcement, pricingCatalogRevisionId: enforcement === "hard" ? catalog.trim() : null } }); onCreated({ id: result.id, scope: { type: scopeType, id: scopeType === "workspace" ? null : scopeId }, parentId: parentId || null, unit, currency: "USD", window, limitAmount, enforcement, pricingCatalogRevisionId: enforcement === "hard" ? catalog.trim() : null, counters: { committed: "0", reserved: "0", current: "0" }, overBudget: false, status: "staged", publishRequired: true, burn: { model: "linear_window_run_rate", status: "available", currentAmount: "0", forecastAmount: "0" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); } catch (caught) { setError(errorMessage(caught)); } finally { setSaving(false); } };
  return <Sheet onClose={onClose} open={open} title="New budget"><form className="console-form" onSubmit={submit}><p className="console-muted" style={{ margin: 0 }}>This creates desired budget configuration. It is staged until Publish and the current schema has no budget revision history.</p>{error ? <AlertBanner title="Budget could not be created" tone="down">{error}</AlertBanner> : null}<label className="console-field"><span>Scope</span><Select onChange={(event) => { setScopeType(event.target.value as ScopeType); setScopeId(""); }} value={scopeType}><option value="workspace">Workspace</option><option value="team">Team</option><option value="app">App</option><option value="cost_center">Cost center</option><option value="key">Key</option></Select></label>{scopeType !== "workspace" ? <label className="console-field"><span>Scoped entity</span><Select disabled={!context && scopeType !== "key"} onChange={(event) => setScopeId(event.target.value)} value={scopeId}><option value="">Select scope</option>{scopeOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label> : null}<label className="console-field"><span>Parent budget</span><Select onChange={(event) => setParentId(event.target.value)} value={parentId}><option value="">No parent</option>{matchingParents.map((item) => <option key={item.id} value={item.id}>{scopeLabel(item.scope, context, keys)}</option>)}</Select></label><div className="console-form-row"><label className="console-field"><span>Unit</span><Select onChange={(event) => setUnit(event.target.value as Budget["unit"])} value={unit}><option value="cost_microusd">micro-USD</option><option value="tokens">Tokens</option></Select></label><label className="console-field"><span>Window</span><Select onChange={(event) => setWindow(event.target.value)} value={window}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="rolling_30d">Rolling 30 days</option><option value="total">Total</option></Select></label></div><label className="console-field"><span>Limit amount</span><Input inputMode="numeric" onChange={(event) => setLimitAmount(event.target.value)} required value={limitAmount} /></label><label className="console-field"><span>Enforcement</span><Select onChange={(event) => setEnforcement(event.target.value as Budget["enforcement"])} value={enforcement}><option value="advisory">Advisory</option><option value="hard">Hard</option></Select></label>{enforcement === "hard" ? <><AlertBanner title="Hard caps fail closed" tone="down">The server accepts only a non-empty catalog whose active prices are provider verified or schema-level operator override. Unknown and aggregator prices cannot create a hard cap.</AlertBanner><label className="console-field"><span>Pricing catalog revision</span><Input onChange={(event) => setCatalog(event.target.value)} placeholder="Catalog revision ID" required value={catalog} /></label></> : null}<div className="console-actions"><Button onClick={onClose}>Cancel</Button><Button disabled={saving} type="submit" variant="primary">{saving ? "Staging budget" : "Stage budget"}</Button></div></form></Sheet>;
}
