import { timingSafeEqual } from "node:crypto";
import { ManifoldError } from "@/lib/http";

/** ADR-0021: this deployment is bound to exactly one workspace database. */
export const STORAGE_SCHEDULER_WORKSPACE_LIMIT = 1;
/** One compaction invocation can perform export I/O, so never serialize a backlog in one Cron fire. */
export const STORAGE_SCHEDULER_DRAIN_LIMIT = 1;
/** Leave shutdown time inside the dedicated 60-second Vercel function duration. */
export const STORAGE_SCHEDULER_DRAIN_BUDGET_MS = 50_000;

export function storageSchedulerDeadline(now = Date.now()): number {
  return now + STORAGE_SCHEDULER_DRAIN_BUDGET_MS;
}

export function storageSchedulerHasTime(deadline: number, now = Date.now()): boolean {
  return now < deadline;
}

/** Constant-time exact Bearer secret comparison shared by every storage Cron route. */
export function requireStorageCronAuthorization(req: Request): void {
  const expected = process.env.CRON_SECRET;
  const presented = req.headers.get("authorization");
  // A padded configured secret is an operator error. Do not silently normalize credentials.
  if (!expected || expected.trim() !== expected || !presented || !presented.startsWith("Bearer ")) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
  }
  const actual = Buffer.from(presented.slice(7));
  const secret = Buffer.from(expected);
  if (actual.length !== secret.length || !timingSafeEqual(actual, secret)) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "invalid or missing cron secret", reasonCodes: [] });
  }
}
