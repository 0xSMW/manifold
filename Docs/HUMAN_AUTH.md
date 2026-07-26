# Human access rollout

This runbook covers the first-party human experience for the Manifold control plane. It is an
operator procedure, not a place for credentials, recipient addresses, or action links.

## What ships

- The first seeded owner activates their account by email, chooses a password, then signs in with
  email and password.
- People join through invitations and choose their own passwords. Direct member provisioning is
  retired.
- Password-reset links restore account access without revealing whether an address exists.
- Each person can inspect and revoke their sessions. Password reset revokes that person's sessions.
- Personal API tokens belong to a human user. Service tokens belong to named service accounts and
  are for automation; they are not substitutes for a person's token.
- `manifold auth login --workspace-slug <slug>` starts browser-approved device authorization. The
  CLI stores the issued bearer token in the OS keyring, while its local context file contains only
  non-secret metadata. `--token` or `MANIFOLD_TOKEN` is the deliberate CI path.

## Configure delivery before enabling access

Set these control-plane variables in each Vercel environment:

| Variable | Requirement |
|---|---|
| `RESEND_API_KEY` | Secret Resend API key entered directly in the Manifold project |
| `RESEND_FROM_EMAIL` | Sender on a Resend-verified domain |
| `MANIFOLD_AUTH_ORIGIN` | Canonical absolute control-plane origin; HTTPS in production, without a path/query/fragment |
| `MANIFOLD_AUTH_TOKEN_PEPPER` | Unique high-entropy production secret; generate with `openssl rand -hex 32` |
| `MANIFOLD_CONSOLE_ORIGIN` | Normally unset. Optional separate canonical origin for CLI device approval, subject to the same production HTTPS/origin-only validation |

Verify the Resend sending domain before launch. Pulse's Vercel Resend variables are project-local
Sensitive variables and cannot be read or link-shared. Manifold therefore needs a securely
re-entered Manifold value or a newly created key. Do not copy a secret or private address into the
repository, documentation, chat, or release evidence.

No human-auth TTL environment variable is supported in this release. The server persists and
enforces action expiry; do not introduce a guessed `*_TTL` or legacy flag. CLI device authorization
currently has a 10-minute lifetime and a server-controlled polling interval.

CLI verification normally uses `MANIFOLD_AUTH_ORIGIN`; configuring `MANIFOLD_CONSOLE_ORIGIN` is
only for an intentionally separate device-approval origin. An invalid override fails closed and
does not fall back to a different URL.

## Rollout

1. Record the release SHA, maintenance window, current migration list, and the identity of the one
   enabled owner through an approved private operational channel.
2. Apply `0032_human_auth.sql` using the direct owner migration connection in normal lexical order.
   It is additive: it preserves legacy members, tokens, and sessions. Do not run a down migration.
3. Deploy the control plane with the four variables above. Confirm the configured origin and Resend
   sender without printing their secret values.
4. Have the existing seeded owner request activation. The bootstrap accepts exactly one enabled
   owner; it is not a bulk migration or a way to auto-bind existing member records by email.
5. Complete activation from the delivered link, choose a password, sign in, and verify the link
   cannot be used again.
6. From the signed-in owner session, create a test invitation; accept it with a second test
   identity; test resend, revoke, and expiry. Use Invitations for all normal membership changes.
7. Test password reset, session revocation, personal-token revocation, service-account disable, and
   CLI device approval/denial. Record only outcome evidence, never token values.

## Operational constraints and recovery

The last active accepted owner cannot be demoted or disabled. Add and activate a replacement owner
before offboarding one. Disabling a member revokes that member's console sessions and associated
API tokens. Disabling a service account revokes its service tokens. Password reset invalidates the
user's existing sessions. These controls are revocation mechanisms, not a reason to retain
plaintext credentials.

If Resend delivery is unavailable, do not bypass email proof, manually provision a member, or set a
password in the database. Keep the activation/invitation state intact, repair the verified sender or
key, then issue a fresh action link through the supported flow. If a token is suspected exposed,
revoke it and mint a successor; if a session is suspected exposed, revoke it. An application rollback
after migration `0032` keeps the additive schema: use a compatible prior deploy or a reviewed
forward fix, never an ad hoc destructive schema rollback.

## Production acceptance

- [ ] Resend domain is verified; `RESEND_FROM_EMAIL` is accepted by Resend.
- [ ] `MANIFOLD_AUTH_ORIGIN` is the production HTTPS origin and every received link uses it.
- [ ] `0032_human_auth.sql` is applied; `manifold_app` remains non-superuser and has no direct
      global-auth-table access.
- [ ] The seeded owner receives activation email, completes activation, and signs in with the new
      email/password credential.
- [ ] Activation and password-reset links are one-time; reset invalidates existing sessions.
- [ ] Invitation create, resend, revoke, expiry, and acceptance work; direct member provisioning is
      rejected.
- [ ] A personal token and a service-account token are distinguishable, individually revocable, and
      never retained in test evidence.
- [ ] A sole active owner cannot be disabled/demoted; a second accepted owner exists before any
      owner offboarding.
- [ ] CLI device authorization can be approved and denied; the CLI credential lands in the OS
      keyring and logout clears the local credential.
