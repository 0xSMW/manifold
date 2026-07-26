# manifold CLI exit codes

Source: SPEC.md §12.4 ("Output, exit codes, idempotency, retries"). This
skeleton implements the subset the CLI's design doc calls out explicitly for
day-one scripting: `0`, `1`, `2`, `3`, `4`, `5`. The full spec additionally
reserves `6` (rate-limited), `7` (server error after retries), `8`
(timeout), and `9` (tripwire-held / needs approval) for the real backend
integration — those are not yet produced by this skeleton, since there is no
real backend to return 429/5xx/timeout/tripwire responses. They are listed
below for forward compatibility; a caller that switches on exit code should
already treat any unrecognized non-zero code as "generic failure."

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | success | command completed (including `--help`) |
| `1` | generic / unexpected error | uncaught error, unreachable health endpoint, transport failure |
| `2` | usage / validation error | bad flags, missing required flag/argument, unknown command |
| `3` | auth error | not logged in, expired/invalid token, missing scope |
| `4` | not found | requested resource id does not exist |
| `5` | precondition failed / conflict | e.g. `CONFIG_PRECONDITION_FAILED` — active revision advanced during apply |
| `6`* | rate-limited | reserved; not yet emitted by this skeleton |
| `7`* | server error (5xx after retries) | reserved; not yet emitted by this skeleton |
| `8`* | timeout | reserved; not yet emitted by this skeleton |
| `9`* | tripwire-held / needs approval | reserved; not yet emitted by this skeleton |

`*` reserved for the full backend integration; see SPEC.md §12.4 for the
complete registry.

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

## Demonstrating each code in this skeleton

The device-authorization commands use the real control-plane protocol. The
issued bearer token is stored only in the operating-system keyring; the
context metadata file contains no secret. `--token` / `MANIFOLD_TOKEN` take
precedence over the keyring for CI and are never copied into it.

| Command | Trigger | Exit |
|---|---|---|
| `manifold auth login --workspace-slug <slug>` | browser approval denied or expired | `3` (auth) |
| `manifold whoami` / `manifold auth whoami` / `manifold auth status` | no stored credential and no `--token` / `MANIFOLD_TOKEN` override | `3` (auth) |
| `manifold job get missing` | literal id `missing` | `4` (not found) |
| `manifold config apply --plan-hash stale` | literal plan hash `stale` | `5` (precondition/conflict) |
| any command with a bad/missing required flag, or an unknown subcommand | — | `2` (usage) |
| `manifold installation health` / `manifold ping` with an unreachable `--base-url` | connection refused/DNS failure/non-2xx | `1` (generic) |

All other commands in this skeleton return `0` and print a stub result.

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
