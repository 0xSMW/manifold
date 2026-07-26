import { ManifoldError, requireString } from "@/lib/http";
import type { Principal } from "@/lib/auth";

export const MEMBER_ROLES = ["owner", "admin", "editor", "viewer", "billing"] as const;
type MemberRole = (typeof MEMBER_ROLES)[number];
const RANK: Record<MemberRole, number> = { billing: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };

export function string(body: Record<string, unknown>, field: string, max = 120): string {
  const value = requireString(body, field).trim();
  if (!value || value.length > max) throw invalid(field, `${field} must be between 1 and ${max} characters`);
  return value;
}

export function nullableString(body: Record<string, unknown>, field: string, max = 120): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length > max) throw invalid(field, `${field} must be a string up to ${max} characters or null`);
  return value.trim() || null;
}

export function slug(body: Record<string, unknown>): string {
  const value = string(body, "slug", 80);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw invalid("slug", "slug must use lowercase letters, numbers, and hyphens");
  return value;
}

export function exactFields(body: Record<string, unknown>, fields: readonly string[], operation: string): void {
  const unknown = Object.keys(body).filter((key) => !fields.includes(key));
  if (unknown.length) throw new ManifoldError({ status: 422, code: "VALIDATION", message: `${operation} does not accept ${unknown.join(", ")}`, reasonCodes: [], details: { issues: unknown.map((path) => ({ path, message: "unsupported field" })) } });
}

export function role(body: Record<string, unknown>): MemberRole {
  const value = string(body, "role", 20);
  if (!(MEMBER_ROLES as readonly string[]).includes(value)) throw invalid("role", "role must be owner, admin, editor, viewer, or billing");
  return value as MemberRole;
}

/** Admins manage strictly lower roles; owners may appoint peers. */
export function enforceRoleCeiling(principal: Principal, target: MemberRole): void {
  const actor = principal.member?.role as MemberRole | undefined;
  if (!actor || !(actor in RANK) || (actor !== "owner" && RANK[target] >= RANK[actor])) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "the requested role exceeds your management ceiling", reasonCodes: ["ROLE_CEILING"] });
  }
}

export function enforceTargetCeiling(principal: Principal, target: string): void {
  const actor = principal.member?.role as MemberRole | undefined;
  if (!actor || !(actor in RANK) || !(target in RANK) || (actor !== "owner" && RANK[target as MemberRole] >= RANK[actor])) {
    throw new ManifoldError({ status: 403, code: "FORBIDDEN", message: "you cannot manage a member at or above your role", reasonCodes: ["ROLE_CEILING"] });
  }
}

export function invalid(field: string, message: string): ManifoldError {
  return new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path: field, message }] } });
}

export function notFound(kind: string): ManifoldError {
  return new ManifoldError({ status: 404, code: "NOT_FOUND", message: `${kind} not found`, reasonCodes: [] });
}
