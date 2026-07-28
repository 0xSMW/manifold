import { expect, test } from "./fixtures";

test("deployment diagnostics render persisted gateway outcomes and durable publication state", async ({ consolePage: page }) => {
  await page.route("**/api/v1/deployments/install-1/diagnostics", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      installationId: "install-1",
      lastHeartbeat: { observedAt: new Date().toISOString(), appliedConfigRevision: "revision-1", installationStatus: "active", reportingAvailable: true, limitation: "Heartbeat observations are stored by the control plane." },
      recentConfigOperations: [
        { id: "operation-pending", outcome: "accepted", operationKind: "apply", servingMode: "edge_config", acceleratorStatus: "pending", baseConfigHash: null, targetConfigHash: null, planHash: null, edgeConfigVersion: null, tripwireItems: [], error: null, reconciliationAttempts: 0, lastReconcileAt: null, completedAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
        { id: "operation-reconcile", outcome: "accepted", operationKind: "apply", servingMode: "edge_config", acceleratorStatus: "reconciliation_required", baseConfigHash: null, targetConfigHash: null, planHash: null, edgeConfigVersion: null, tripwireItems: [], error: { message: "retry" }, reconciliationAttempts: 2, lastReconcileAt: "2026-07-28T00:00:00.000Z", completedAt: null, createdAt: "2026-07-28T00:00:00.000Z" },
        { id: "operation-published", outcome: "accepted", operationKind: "apply", servingMode: "edge_config", acceleratorStatus: "published", baseConfigHash: null, targetConfigHash: null, planHash: null, edgeConfigVersion: "v1", tripwireItems: [], error: null, reconciliationAttempts: 0, lastReconcileAt: null, completedAt: "2026-07-28T00:00:00.000Z", createdAt: "2026-07-28T00:00:00.000Z" },
      ],
      syntheticTest: {
        available: true,
        lastResult: { id: "audit-failed", createdAt: new Date().toISOString(), detail: { kind: "gateway_response", installationId: "install-1", profileId: "profile-public", endpointKind: "chat", configRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", gatewayStatus: 503, traceId: null, responseTruncated: false } },
        activeConfigRevisionId: "revision-1",
        appliedConfigRevisionId: "revision-1",
        freshnessThresholdSeconds: 600,
        reason: "Synthetic diagnostics are configured.",
      },
    }),
  }));

  await page.goto("/deployments/install-1");
  await expect(page.getByText("Synthetic request failed")).toBeVisible();
  await expect(page.getByText("Last result: HTTP 503.")).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconciliation Required", { exact: true })).toBeVisible();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Retry attempts 2")).toBeVisible();
});

test("deployment controls remain available when readiness and diagnostics fail", async ({ consolePage: page }) => {
  await page.route("**/api/v1/deployments/install-1/readiness", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Readiness unavailable" } }) }));
  await page.route("**/api/v1/deployments/install-1/diagnostics", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Diagnostics unavailable" } }) }));

  await page.goto("/deployments/install-1");
  await expect(page.getByRole("heading", { name: "Gateway one", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bind trusted host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disable gateway" })).toBeVisible();
  await expect(page.getByText("Readiness could not load: Readiness unavailable")).toBeVisible();
  await expect(page.getByText("Diagnostics could not load: Diagnostics unavailable")).toBeVisible();
});

test("deployment diagnostics render the latest persisted execution failure", async ({ consolePage: page }) => {
  await page.route("**/api/v1/deployments/install-1/diagnostics", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      installationId: "install-1",
      lastHeartbeat: { observedAt: new Date().toISOString(), appliedConfigRevision: "revision-1", installationStatus: "active", reportingAvailable: true, limitation: "Heartbeat observations are stored by the control plane." },
      recentConfigOperations: [],
      syntheticTest: {
        available: true,
        lastResult: { id: "audit-timeout", createdAt: new Date().toISOString(), detail: { kind: "execution_failure", installationId: "install-1", profileId: "profile-public", endpointKind: "chat", configRevisionId: "revision-1", appliedConfigRevisionId: "revision-1", failureCode: "SYNTHETIC_TIMEOUT", retryable: true } },
        activeConfigRevisionId: "revision-1",
        appliedConfigRevisionId: "revision-1",
        freshnessThresholdSeconds: 600,
        reason: "Synthetic diagnostics are configured.",
      },
    }),
  }));

  await page.goto("/deployments/install-1");
  await expect(page.getByText("Synthetic request failed")).toBeVisible();
  await expect(page.getByText("Last result: Execution failed: timeout.")).toBeVisible();
});
