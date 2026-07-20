# @manifold/gateway

A **real, runnable passthrough gateway** — the thin Node entry that implements the platform
ports (SPEC §4.4) and delegates the request pipeline to `@manifold/gateway-core`.

It authenticates the client's virtual key, resolves a route by `(profile, path)`, selects a
target, injects the provider's auth fresh, applies the SSRF + header allowlist, and **streams**
the upstream response back with flat memory (SPEC §8.1, §14.4, §14.5).

## Architecture

```
apps/gateway (this)          Node adapters: node:http, node:crypto, node:dns, global fetch, JSONL sink
  └─ @manifold/gateway-core   pure pipeline: handleRequest() — ZERO platform imports
       └─ @manifold/ports     platform-adapter interfaces + in-memory fakes (./testing)
            └─ @manifold/contracts  SCHEMA_VERSION, ReasonCode, error envelopes
```

`gateway-core` never imports `next`, `@vercel/*`, `@cloudflare/*`, or `node:*`; every platform
touchpoint arrives by dependency injection through `@manifold/ports` (ADR-0004, §4.2).

## Run it

```bash
# from the repo root, once:
npm install
npm run build            # builds contracts + ports + gateway-core to dist/

# start the gateway (loads ./snapshot.example.json by default):
cd apps/gateway
export ANTHROPIC_API_KEY=sk-ant-...   # the provider secret (skeleton reads it from env)
npm start                             # → manifold gateway listening on http://127.0.0.1:8787
# npm run dev                         # same, with --watch
```

Environment:

| var | default | meaning |
|---|---|---|
| `PORT` | `8787` | listen port |
| `MANIFOLD_SNAPSHOT` | `./snapshot.example.json` | snapshot file to load |
| `MANIFOLD_KEY_PEPPER` | `dev-pepper-not-for-production` | HMAC pepper for key hashing (§14.3) |
| `ANTHROPIC_API_KEY` | — | provider secret injected upstream (skeleton; see TODO below) |

The example snapshot has: profile `localhost` → `public_app`; one virtual key
(**plaintext test key: `sk-manifold-localtest-key`**, stored as its HMAC hash); one route
`/v1/messages` → `https://api.anthropic.com` with Anthropic auth injection.

## Proxy a REAL Anthropic request (single 1-token test)

With `ANTHROPIC_API_KEY` exported and the server running, the client authenticates with the
Manifold **virtual key** (not the provider key — that is injected fresh upstream):

```bash
curl -N http://localhost:8787/v1/messages \
  -H "authorization: Bearer sk-manifold-localtest-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "max_tokens": 1,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

The gateway strips the inbound `Authorization`, injects `x-api-key: $ANTHROPIC_API_KEY` +
`anthropic-version: 2023-06-01`, SSRF-checks `api.anthropic.com`, and streams Anthropic's
response straight back. `X-Trace-Id` is returned before the body; an observation is appended to
`./observations.log`.

Guard failures return OpenAI-shaped error envelopes (SPEC §0.3), e.g. a wrong key:

```bash
curl -s -X POST http://localhost:8787/v1/messages \
  -H "authorization: Bearer wrong" -H "content-type: application/json" -d '{}'
# {"error":{"message":"api key not recognized","type":"authentication_error","param":null,"code":"AUTH_KEY_UNKNOWN"}}
```

## Test (spends zero external tokens)

```bash
cd apps/gateway && npm test    # node --test against a local mock upstream
```

Asserts: (a) valid key streams mock chunks through; (b) bad key → 401 `AUTH_KEY_UNKNOWN`;
(c) unknown route → `ROUTE_UNKNOWN`; (d) SSRF blocks loopback / RFC-1918; (e) inbound
`Authorization` is not forwarded upstream; (f) memory stays flat streaming a 256 MB body;
plus (g) a real `node:http` boot rejecting a bad key.

## Known skeleton shortcuts (TODOs)

- **Provider secret** comes from env, not the encrypted `credmap`. The real path (SPEC §14.3,
  ADR-0022) decrypts `target.credentialCiphertext` in-proc with the KEK-unwrapped DEK via
  `crypto.openAesGcm` — no env, no DB read. See `makeSecretResolver` in `src/server.ts`.
- **Snapshot signature** (ed25519) and `contentHash` are not yet verified on load (SPEC §7.3);
  the real `SnapshotStore` fails closed to the last-good snapshot. See `SnapshotFileStore`.
- **DNS pinning** in `EgressFetcher` resolves-then-checks-then-fetches; true pinning (connect to
  the exact validated address, no rebind) needs a custom dispatcher (§14.4).
- Scope is **passthrough**, not codec translation — no policy/budget/codec stages yet (§8.1).
