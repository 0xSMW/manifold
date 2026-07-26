import assert from "node:assert/strict";
import test from "node:test";
import { buildColdExportManifest, retentionDurationMs } from "../src/postgres.js";
import { COMPACTION_TRUTH_TABLE_EXCLUSIONS, CompactionDeferred, PartitionCompactionError, StorageCompactor, type CompactionBlocker, type CompactionProgress, type StorageRepository } from "../src/compactor.js";

class FakeRepository implements StorageRepository {
  locked = true;
  claimed = true;
  measurements = [1000, 1000];
  aggregateCalls = 0;
  hours = [new Date("2026-07-24T10:00:00Z")];
  pruneCalls = 0;
  progress: CompactionProgress[] = [];
  failures: CompactionBlocker[] = [];
  missing: readonly string[] = ["retention_settings"];
  async tryLock(): Promise<boolean> { return this.locked; }
  async claim(): Promise<any> { return this.claimed ? { id: "job_1", workspaceId: "ws_1", payload: {}, status: "pending" } : null; }
  async measure(): Promise<number> { return this.measurements.shift() ?? 1000; }
  async listUncheckpointedClosedHours(_: string, __: Date, limit?: number): Promise<readonly Date[]> {
    return limit === undefined ? this.hours : this.hours.slice(0, limit);
  }
  async aggregateClosedHour(): Promise<void> { this.aggregateCalls += 1; }
  async rollupClosedWindows(): Promise<void> { /* tested against real Postgres */ }
  async retentionPrerequisites(): Promise<readonly string[]> { return this.missing; }
  async compactEligiblePartitions() { return []; }
  async pruneExpiredCaptures(): Promise<number> { return 0; }
  async pruneExpiredAggregateGrains(): Promise<number> { return 0; }
  async pruneCompactedTraceProjections(): Promise<number> { this.pruneCalls += 1; return 0; }
  async updateProgress(_: string, __: string, progress: CompactionProgress): Promise<void> { this.progress.push(progress); }
  async fail(_: string, __: string, progress: CompactionProgress, blocker: CompactionBlocker): Promise<void> { this.progress.push(progress); this.failures.push(blocker); }
  async complete(_: string, __: string, progress: CompactionProgress): Promise<void> { this.progress.push(progress); }
}

test("lock contention exits before claim or mutation", async () => {
  const repo = new FakeRepository(); repo.locked = false;
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.deepEqual(result, { status: "contention", code: "COMPACTION_IN_PROGRESS" });
  assert.equal(repo.aggregateCalls, 0);
});

test("a configured repository only deletes through the explicit export/checkpoint seam", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  let calls = 0;
  repo.compactEligiblePartitions = async () => { calls += 1; return []; };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.equal(result.status, "done");
  assert.equal(calls, 1);
  assert.equal(repo.pruneCalls, 1);
});

test("resumable progress aggregates before fail-closed blocker", async () => {
  const repo = new FakeRepository();
  const result = await new StorageCompactor(repo, () => new Date("2026-07-24T12:34:00Z")).run("job_1", "ws_1", "worker");
  assert.equal(result.status, "blocked");
  assert.equal(repo.aggregateCalls, 1);
  assert.deepEqual(repo.failures[0]?.missing, ["retention_settings"]);
  assert.ok(repo.progress.some((p) => p.steps.includes("hourly_aggregated")));
  assert.deepEqual(repo.progress.find((p) => p.steps.includes("hourly_aggregated"))?.closedHours,
    ["2026-07-24T10:00:00.000Z"]);
  assert.ok(repo.progress.at(-1)?.steps.includes("blocked"));
});

test("every missed closed hour is enumerated and checkpointed before retention", async () => {
  const repo = new FakeRepository();
  repo.hours = [
    new Date("2026-07-24T07:00:00Z"),
    new Date("2026-07-24T09:00:00Z"),
    new Date("2026-07-24T10:00:00Z"),
  ];
  await new StorageCompactor(repo, () => new Date("2026-07-24T12:34:00Z")).run("job_1", "ws_1", "worker");
  assert.equal(repo.aggregateCalls, 3);
  assert.deepEqual(repo.progress.find((p) => p.steps.includes("hourly_aggregated"))?.closedHours, [
    "2026-07-24T07:00:00.000Z",
    "2026-07-24T09:00:00.000Z",
    "2026-07-24T10:00:00.000Z",
  ]);
});

test("a bounded scheduler unit persists progress and never marks a full page done", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  repo.hours = [new Date("2026-07-24T07:00:00Z"), new Date("2026-07-24T08:00:00Z")];
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker", { maxClosedHours: 1, maxPartitions: 1 });
  assert.deepEqual(result, { status: "incomplete", beforeBytes: 1000 });
  assert.equal(repo.aggregateCalls, 1);
  assert.equal(repo.progress.at(-1)?.steps.includes("hourly_aggregated"), true);
  assert.equal(repo.progress.some((progress) => progress.steps.includes("measured_after")), false);
});

test("an expired scheduler deadline persists the claim without starting another unit", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker", { deadline: 0, maxClosedHours: 1, maxPartitions: 1 });
  assert.deepEqual(result, { status: "incomplete", beforeBytes: 1000 });
  assert.equal(repo.aggregateCalls, 0);
  assert.equal(repo.progress.some((progress) => progress.steps.includes("measured_after")), false);
});

test("an expired final progress write still returns incomplete for lease-based resumption", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  let progressWrites = 0;
  repo.updateProgress = async (_jobId, _workspaceId, progress) => {
    progressWrites += 1;
    if (progressWrites === 2) throw new CompactionDeferred("deadline reached");
    repo.progress.push(progress);
  };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker", {
    deadline: 0,
    maxClosedHours: 1,
    maxPartitions: 1,
  });
  assert.deepEqual(result, { status: "incomplete", beforeBytes: 1000 });
  assert.equal(progressWrites, 2);
});

test("a deadline deferral during closed-hour discovery leaves the job incomplete", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  repo.listUncheckpointedClosedHours = async () => { throw new CompactionDeferred("deadline reached"); };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.deepEqual(result, { status: "incomplete", beforeBytes: 1000 });
  assert.equal(repo.aggregateCalls, 0);
  assert.equal(repo.progress.at(-1)?.steps.includes("measured_before"), true);
  assert.equal(repo.progress.some((progress) => progress.steps.includes("measured_after")), false);
});

test("a non-deferral error during closed-hour discovery propagates", async () => {
  const repo = new FakeRepository();
  repo.listUncheckpointedClosedHours = async () => { throw new Error("database unavailable"); };
  await assert.rejects(
    new StorageCompactor(repo).run("job_1", "ws_1", "worker"),
    /database unavailable/,
  );
});

test("a deadline deferral during projection pruning leaves the job incomplete", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  repo.pruneCompactedTraceProjections = async () => { throw new CompactionDeferred("deadline reached"); };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.deepEqual(result, { status: "incomplete", beforeBytes: 1000 });
  assert.equal(repo.failures.length, 0);
  assert.equal(repo.progress.some((progress) => progress.steps.includes("blocked")), false);
});

test("truth-table exclusion is structural: prerequisite failure reports zero freed bytes", async () => {
  const repo = new FakeRepository(); repo.measurements = [1500, 900];
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.freedBytes, 0);
  assert.equal(repo.aggregateCalls, 1, "only aggregate work is permitted before blocker");
  assert.deepEqual(COMPACTION_TRUTH_TABLE_EXCLUSIONS, [
    "audit_event", "budget_account", "budget_allocation", "budget_reservation", "budget_window_state",
    "gateway_config_revision", "config_operation", "usage_aggregate",
  ]);
});

test("an export verification failure is persisted as a destructive-work blocker", async () => {
  const repo = new FakeRepository();
  repo.missing = [];
  repo.compactEligiblePartitions = async () => { throw new Error("object storage export verification failed"); };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.deepEqual(result.blocker, {
    code: "EXPORT_VERIFICATION_FAILED", missing: ["export_verification:object storage export verification failed"], destructiveWorkSkipped: true,
  });
  assert.equal(repo.failures.length, 1);
  assert.equal(repo.progress.at(-1)?.freedBytes, 0);
});

test("a later partition failure preserves completed partition outcomes in durable progress", async () => {
  const repo = new FakeRepository();
  repo.measurements = [1_000, 640];
  repo.missing = [];
  const completed = { partitionName: "observation_202601", manifestId: "sexp_1", rows: 1, bytes: 20 };
  repo.compactEligiblePartitions = async () => { throw new PartitionCompactionError("second partition checksum mismatch", [completed]); };
  const result = await new StorageCompactor(repo).run("job_1", "ws_1", "worker");
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.equal(result.freedBytes, 360);
    assert.equal(result.blocker.destructiveWorkSkipped, undefined);
  }
  assert.deepEqual(repo.progress.at(-1)?.partitionOutcomes, [completed]);
});

test("cold export manifest is immutable, verifiable, and names only the allowlisted partition payload", () => {
  const input = {
    sourceRelation: "observation_event", start: new Date("2026-07-01T00:00:00.000Z"), end: new Date("2026-08-01T00:00:00.000Z"),
    rowCount: 2, byteCount: 42, sha256: "a".repeat(64), objectUri: "s3://archive/ws_1-event.jsonl", exportedAt: "2026-08-02T03:04:05.000Z",
  };
  const first = buildColdExportManifest(input);
  const retry = buildColdExportManifest(input);
  assert.deepEqual(retry, first, "a retry with the recorded export timestamp produces the same immutable bytes");
  assert.equal(first.sha256, "a1ed929e307ab1bd4312ad2ac79d0cf60b99421428cb5fe6c1dc0dd01db18df4");
  assert.deepEqual(JSON.parse(first.bytes.toString("utf8")), {
    schema: "manifold.storage-export-manifest.v1",
    window: { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
    tables: ["observation_event"], row_counts: { observation_event: 2 }, sha256: "a".repeat(64), byte_count: 42,
    object_uri: "s3://archive/ws_1-event.jsonl", exported_at: "2026-08-02T03:04:05.000Z",
  });
});

test("retention authorization uses relation-specific floors and rejects unknown relations", () => {
  const settings = {
    min_detail_hours: 24,
    journal_retention_hours: 12,
    min_trace_days: 7,
    observation_retention_days: 3,
    cost_ledger_retention_days: 2,
    policy_decision_retention_days: 30,
  };
  assert.equal(retentionDurationMs(settings, "observation_event"), 24 * 3_600_000);
  assert.equal(retentionDurationMs(settings, "observation"), 7 * 86_400_000);
  assert.equal(retentionDurationMs(settings, "trace_summary"), 7 * 86_400_000);
  assert.equal(retentionDurationMs(settings, "usage_record"), 7 * 86_400_000);
  assert.equal(retentionDurationMs(settings, "cost_ledger"), 7 * 86_400_000);
  assert.equal(retentionDurationMs(settings, "policy_decision"), 90 * 86_400_000);
  assert.throws(() => retentionDurationMs(settings, "audit_event"), /retention class unavailable/);
});
