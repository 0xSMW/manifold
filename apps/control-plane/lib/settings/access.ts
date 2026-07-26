import { authorize, type Principal } from "@/lib/auth";
import { ManifoldError } from "@/lib/http";

/** Settings are administrative. Browser sessions must also belong to an admin or owner. */
export async function authorizeSettings(req: Request, scope: "config:read" | "config:write" | "cli:approve"): Promise<Principal> {
  const principal = await authorize(req, scope);
  if (!principal.member || (principal.member.role !== "owner" && principal.member.role !== "admin")) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "settings require an owner or admin membership", reasonCodes: [] });
  }
  return principal;
}

export function strictBody(body: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ManifoldError({ status: 422, code: "VALIDATION", message: `unsupported field(s): ${unknown.join(", ")}`, reasonCodes: [], details: { issues: unknown.map((path) => ({ path, message: "unsupported field" })) } });
}
