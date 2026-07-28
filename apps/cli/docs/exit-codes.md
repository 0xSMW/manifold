# manifold CLI exit codes

Source: SPEC.md §12.4 ("Output, exit codes, idempotency, retries"). The CLI
implements the full process-code matrix below.

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | success | command completed (including `--help`) |
| `1` | generic / unexpected error | uncaught error, unreachable health endpoint, transport failure |
| `2` | usage / validation error | bad flags, missing required flag/argument, unknown command |
| `3` | auth error | not logged in, expired/invalid token, missing scope |
| `4` | not found | requested resource id does not exist |
| `5` | precondition failed / conflict | e.g. `CONFIG_PRECONDITION_FAILED` — active revision advanced during apply |
| `6` | rate-limited | control plane returns `429` / `RATE_LIMITED` |
| `7` | server error | control plane returns `5xx` |
| `8` | timeout | request deadline elapsed |
| `9` | tripwire-held / needs approval | control plane returns `CONFIG_TRIPWIRE_HELD` |

Every non-zero exit prints a structured error envelope (SPEC.md §0.3 /
§12.9) to stderr:

```json
{
  "schema": "manifold.v1",
  "kind": "error",
  "error": {
    "code": "CONFIG_PRECONDITION_FAILED",
    "message": "active revision advanced from sha256:abc… to sha256:def… during apply",
    "remediation": "re-run `manifold config plan` against the current active revision, then apply",
    "retryable": true,
    "details": { "expected": "sha256:abc…", "actual": "sha256:def…" }
  }
}
```

## Current command behavior

The device-authorization commands use the real control-plane protocol. The
issued bearer token is stored only in the operating-system keyring; the
context metadata file contains no secret. `--token` / `MANIFOLD_TOKEN` take
precedence over the keyring for CI and are never copied into it.

| Command | Trigger | Exit |
|---|---|---|
| `manifold auth login --workspace-slug <slug>` | browser approval denied or expired | `3` (auth) |
| `manifold whoami` / `manifold auth whoami` / `manifold auth status` | no stored credential and no `--token` / `MANIFOLD_TOKEN` override | `3` (auth) |
| `manifold job get missing` | literal id `missing` | `4` (not found) |
| `manifold config apply --installation <id> --plan-hash <hash>` | control plane returns `CONFIG_PRECONDITION_FAILED` or `CONFIG_TRIPWIRE_HELD` | `5` (precondition/conflict) |
| any command with a bad/missing required flag, or an unknown subcommand | — | `2` (usage) |
| `manifold installation health` / `manifold ping` with an unreachable `--base-url` | connection refused, DNS failure, timeout, or non-2xx other than 404 | `1` (generic) |
| `manifold installation health` / `manifold ping` | health URL returns 404 | `4` (not found) |

The following command paths make real control-plane calls:

- device authorization login, logout, and `whoami`;
- provider list, create, validate, rotate, and revoke;
- route list;
- key list, mint, rotate, revoke, and scope update;
- config plan, apply, active, history, and rollback;
- installation health, `health check`, and `ping` when a base URL is configured.

`auth status` inspects the local context and keyring state without contacting the
control plane.

Other leaf commands currently validate their arguments, return `0`, and print a
result with `"stub": true`; they do not mutate or query the control plane.

## Device authorization

Run `manifold auth login --workspace-slug <slug>`. The command prints a
server-issued verification URL and user code, optionally opens the browser,
then polls at the server-provided interval. `--no-browser` suppresses browser
launching. A server `slow_down` response changes the next polling interval;
denied and expired requests never create local credentials.

`manifold auth logout` first asks the control plane to revoke the current
bearer token and always removes the local keyring credential. If remote
revocation fails, it reports that failure rather than claiming the token was
revoked.
