import { createHash } from "node:crypto";

// Storage-pressure actions are deliberately an ingest/compactor concern. They are never a
// gateway admission input: provider traffic must remain independent of durable-store pressure.
export const STORAGE_PRESSURE_TIERS = ["normal", "warning", "high", "critical", "emergency"] as const;
export type StoragePressureTier = (typeof STORAGE_PRESSURE_TIERS)[number];
export type CaptureMode = "none" | "metadata" | "redacted" | "full";
export type JournalMode = "full" | "aggregate_only";

export type StoragePressurePolicy = Readonly<{
  tier: StoragePressureTier;
  captureMode: CaptureMode;
  payloadSampleRate: number;
  journalMode: JournalMode;
  triggerCompaction: boolean;
  compactEveryMeasure: boolean;
  blockNonEssentialGrowth: boolean;
}>;

export const DEFAULT_MIGRATION_HEADROOM_PCT = 8;
export const PRESSURE_GROWTH_SAMPLE_LIMIT = 96;

export type StorageGrowthSample = Readonly<{ measuredAt: Date; totalBytes: number }>;

/**
 * The ordinary-least-squares slope in bytes/day. Measurements are timestamped rather than
 * assumed to be perfectly 15-minute-spaced, so delayed measure jobs do not skew the forecast.
 */
export function growthBytesPerDay(samples: readonly StorageGrowthSample[]): number | null {
  if (samples.length < 2) return null;
  const points = samples.map(({ measuredAt, totalBytes }) => {
    const time = measuredAt.valueOf();
    if (!Number.isFinite(time) || !Number.isFinite(totalBytes) || totalBytes < 0) throw new Error("invalid storage growth sample");
    return { time: time / 86_400_000, bytes: totalBytes };
  });
  const meanTime = points.reduce((sum, point) => sum + point.time, 0) / points.length;
  const meanBytes = points.reduce((sum, point) => sum + point.bytes, 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point.time - meanTime) ** 2, 0);
  if (variance === 0) return null;
  const slope = points.reduce((sum, point) => sum + (point.time - meanTime) * (point.bytes - meanBytes), 0) / variance;
  return Number.isFinite(slope) ? slope : null;
}

export function forecastExhaustionAt(input: {
  measuredAt: Date;
  totalBytes: number;
  effectiveCeilingBytes: number;
  growthBytesPerDay: number | null;
}): Date | null {
  const { measuredAt, totalBytes, effectiveCeilingBytes: ceiling, growthBytesPerDay: growth } = input;
  if (!Number.isFinite(measuredAt.valueOf()) || !Number.isFinite(totalBytes) || !Number.isFinite(ceiling) || totalBytes < 0 || ceiling <= 0) throw new Error("invalid storage forecast input");
  if (growth === null || !Number.isFinite(growth) || growth <= 0) return null;
  const days = (ceiling - totalBytes) / growth;
  return new Date(measuredAt.valueOf() + days * 86_400_000);
}

/** Deterministic per-trace sampling; all events in a trace make the same capture decision. */
export function isTraceSampledIn(traceId: string, sampleRate: number): boolean {
  if (!traceId) throw new Error("trace id is required for deterministic sampling");
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error("payload sample rate must be between zero and one");
  if (sampleRate === 0) return false;
  if (sampleRate === 1) return true;
  const hash = createHash("sha256").update(traceId).digest();
  // Use the first 48 bits: exactly representable in JS and independent of process-local RNG.
  const bucket = hash.readUIntBE(0, 6) / 2 ** 48;
  return bucket < sampleRate;
}

export function effectiveCeilingBytes(input: {
  ceilingBytes: number;
  indexBytes: number;
  heapBytes: number;
  migrationHeadroomPct?: number;
}): number {
  const { ceilingBytes, indexBytes, heapBytes, migrationHeadroomPct = DEFAULT_MIGRATION_HEADROOM_PCT } = input;
  if (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0) throw new Error("storage ceiling must be positive");
  if (!Number.isFinite(indexBytes) || indexBytes < 0 || !Number.isFinite(heapBytes) || heapBytes < 0) throw new Error("storage measurement must be non-negative");
  const migrationHeadroom = Math.ceil(ceilingBytes * migrationHeadroomPct / 100);
  // Preserve the current index-to-heap footprint when compaction frees heap. This is the
  // conservative index-growth reserve specified in §13.2, without inventing a forecast.
  const indexGrowth = heapBytes === 0 ? indexBytes : Math.ceil(heapBytes * (indexBytes / heapBytes));
  const headroom = Math.max(migrationHeadroom, indexGrowth);
  return Math.max(1, ceilingBytes - Math.min(ceilingBytes - 1, headroom));
}

export function usedPct(totalBytes: number, effectiveCeiling: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes < 0 || !Number.isFinite(effectiveCeiling) || effectiveCeiling <= 0) throw new Error("invalid storage pressure measurement");
  return totalBytes * 100 / effectiveCeiling;
}

export function tierForStoragePressure(input: { usedPct: number; warnPct: number; highPct: number; critPct: number }): StoragePressureTier {
  const { usedPct: percentage, warnPct, highPct, critPct } = input;
  if (![percentage, warnPct, highPct, critPct].every(Number.isFinite) || percentage < 0 || !(0 < warnPct && warnPct < highPct && highPct < critPct && critPct <= 100)) {
    throw new Error("invalid storage pressure thresholds");
  }
  if (percentage >= 100) return "emergency";
  if (percentage >= critPct) return "critical";
  if (percentage >= highPct) return "high";
  if (percentage >= warnPct) return "warning";
  return "normal";
}

export function policyForStoragePressure(tier: StoragePressureTier): StoragePressurePolicy {
  switch (tier) {
    case "normal": return { tier, captureMode: "full", payloadSampleRate: 1, journalMode: "full", triggerCompaction: false, compactEveryMeasure: false, blockNonEssentialGrowth: false };
    case "warning": return { tier, captureMode: "full", payloadSampleRate: 0.5, journalMode: "full", triggerCompaction: true, compactEveryMeasure: false, blockNonEssentialGrowth: false };
    case "high": return { tier, captureMode: "redacted", payloadSampleRate: 0.1, journalMode: "full", triggerCompaction: true, compactEveryMeasure: true, blockNonEssentialGrowth: false };
    case "critical": return { tier, captureMode: "metadata", payloadSampleRate: 0, journalMode: "full", triggerCompaction: true, compactEveryMeasure: true, blockNonEssentialGrowth: true };
    case "emergency": return { tier, captureMode: "none", payloadSampleRate: 0, journalMode: "aggregate_only", triggerCompaction: true, compactEveryMeasure: true, blockNonEssentialGrowth: true };
  }
}
