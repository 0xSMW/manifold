import { scheduleStorageCompaction } from "@/lib/storage-scheduler-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> { return scheduleStorageCompaction(req, "monthly"); }
