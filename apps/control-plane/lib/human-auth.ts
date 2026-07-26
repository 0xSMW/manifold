import { hashAuthToken, generateAuthActionToken } from "@/lib/auth-secret";
import { chargeAuthCapabilityCompletion, chargePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { rawSql } from "@/lib/db";
import { genId } from "@/lib/ids";
import { hashPassword, verifyDummyPassword, verifyPassword } from "@/lib/password";
import { createHumanSession, type CreatedSession } from "@/lib/session";
import { scopesForMemberRole } from "@/lib/auth";
import { ManifoldError } from "@/lib/http";
import { sendAuthEmail } from "@/lib/auth-email";

const ACTION_TTL_MS = 60 * 60 * 1000;
type Identity = { user_id: string; member_id: string; workspace_id: string; email: string; name: string | null; role: string; session_version: number };
type LoginRow = Omit<Identity, "name" | "role"> & {
  member_name: string | null;
  member_role: string;
  password_hash: string;
  user_disabled_at: string | null;
  email_verified_at: string | null;
  locked_until: string | null;
  member_disabled_at: string | null;
  member_accepted_at: string | null;
};

function unavailable(): ManifoldError { return new ManifoldError({ status: 401, code: "UNAUTHENTICATED", message: "invalid email or password", reasonCodes: ["AUTH_LOGIN_INVALID"] }); }
function sessionFrom(identity: Identity, userAgent: string | null): Promise<CreatedSession> {
  return createHumanSession({ workspaceId: identity.workspace_id, userId: identity.user_id, sessionVersion: identity.session_version, scopes: scopesForMemberRole(identity.role), member: { id: identity.member_id, email: identity.email, name: identity.name, role: identity.role }, userAgent });
}
function expiresAt() { return new Date(Date.now() + ACTION_TTL_MS); }

export async function activationStatus(): Promise<boolean> { return Boolean((await rawSql()<{ auth_initial_activation_status: boolean }[]>`SELECT auth_initial_activation_status()`)[0]?.auth_initial_activation_status); }

export async function requestActivation(email: string, request: Request): Promise<void> {
  await chargePublicAuthRateLimit("activation", email, request, 3, 60 * 60 * 1000);
  const token = generateAuthActionToken(); const expires = expiresAt();
  const rows = await rawSql()<{ email: string; workspace_id: string; workspace_name: string; member_id: string }[]>`SELECT * FROM auth_prepare_initial_activation(${email}, ${genId("usr")}, ${genId("aet")}, ${hashAuthToken(token)}, ${expires.toISOString()})`;
  if (rows[0]) await sendAuthEmail({ to: rows[0].email, kind: "activation", token, expiresAt: expires });
}

export async function completeActivation(token: string, name: string, password: string, userAgent: string | null, request: Request): Promise<CreatedSession> {
  await chargeAuthCapabilityCompletion("activation-complete", request);
  const rows = await rawSql()<Identity[]>`SELECT * FROM auth_complete_activation(${hashAuthToken(token)}, ${name}, ${await hashPassword(password)})`;
  if (!rows[0]) throw unavailable();
  return sessionFrom(rows[0], userAgent);
}

export async function passwordLogin(email: string, password: string, userAgent: string | null, request: Request): Promise<CreatedSession> {
  await chargePublicAuthRateLimit("login", email, request, 10, 15 * 60 * 1000);
  const row = (await rawSql()<LoginRow[]>`SELECT * FROM auth_lookup_password_login(${email})`)[0];
  const valid = await verifyPassword(password, row?.password_hash);
  if (!row || !valid || row.user_disabled_at || !row.email_verified_at || row.locked_until && new Date(row.locked_until).getTime() > Date.now() || row.member_disabled_at || !row.member_accepted_at) {
    // A locked account is already throttled until its recorded deadline. Re-recording each bad
    // attempt would let an attacker continually push that deadline forward.
    if (row && (!row.locked_until || new Date(row.locked_until).getTime() <= Date.now())) await rawSql()`SELECT auth_record_login_failure(${email})`;
    throw unavailable();
  }
  await rawSql()`SELECT auth_record_login_success(${email})`;
  return sessionFrom({ ...row, name: row.member_name, role: row.member_role }, userAgent);
}

export async function requestPasswordReset(email: string, request: Request): Promise<void> {
  await chargePublicAuthRateLimit("password-reset", email, request, 3, 60 * 60 * 1000);
  const token = generateAuthActionToken(); const expires = expiresAt();
  const rows = await rawSql()<{ email: string }[]>`SELECT * FROM auth_issue_password_reset(${email}, ${genId("aet")}, ${hashAuthToken(token)}, ${expires.toISOString()})`;
  if (rows[0]) await sendAuthEmail({ to: rows[0].email, kind: "password-reset", token, expiresAt: expires });
}

export async function resetPassword(token: string, password: string, request: Request): Promise<boolean> {
  await chargeAuthCapabilityCompletion("password-reset-complete", request);
  return Boolean((await rawSql()<{ auth_complete_password_reset: boolean }[]>`SELECT auth_complete_password_reset(${hashAuthToken(token)}, ${await hashPassword(password)})`)[0]?.auth_complete_password_reset);
}

export async function inspectInvitation(token: string) {
  const row = (await rawSql()<{ email: string; workspace_name: string; role: "owner" | "admin" | "editor" | "viewer" | "billing"; expires_at: string }[]>`SELECT * FROM auth_lookup_workspace_invitation(${hashAuthToken(token)})`)[0];
  if (!row) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "invitation is unavailable", reasonCodes: ["INVITATION_INVALID"] });
  return { workspace: { name: row.workspace_name }, email: row.email, role: row.role, expiresAt: row.expires_at };
}

export async function acceptInvitation(token: string, name: string, password: string, userAgent: string | null, request: Request): Promise<CreatedSession> {
  await chargeAuthCapabilityCompletion("invitation-accept", request);
  const rows = await rawSql()<Identity[]>`SELECT * FROM auth_accept_workspace_invitation(${hashAuthToken(token)}, ${genId("usr")}, ${name}, ${await hashPassword(password)})`;
  if (!rows[0]) throw new ManifoldError({ status: 400, code: "VALIDATION", message: "invitation is unavailable", reasonCodes: ["INVITATION_INVALID"] });
  return sessionFrom(rows[0], userAgent);
}

/** Constant-work generic response for malformed/unknown public action tokens. */
export async function dummyPublicTokenWork(): Promise<void> { await verifyDummyPassword(); }
