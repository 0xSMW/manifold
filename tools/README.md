# Release conformance and performance gates

`tools/conformance` replays recorded chat, Responses, and embeddings request/response shapes through the current OpenAI codecs. It makes no provider calls. The committed capability matrix is generated only from `adapter-metadata.json`.

```bash
pnpm run conformance:replay
pnpm run conformance:matrix:check
```

After a reviewed metadata change, run `pnpm run conformance:matrix` and commit the new matrix.

Ordinary CI runs the local deterministic `load:k6` and `load:flat-memory` fixtures.
These commands exercise the checked-in fixtures without contacting a deployed
target:

```bash
pnpm run load:k6
pnpm run load:flat-memory
```

`load:k6` requires `k6` on `PATH`. `load:flat-memory` requires the
`@manifold/gateway-core` build artifact, so run
`pnpm --filter @manifold/gateway-core run build` first in a fresh checkout.
The CI workflow installs k6 and builds gateway-core before these gates.

The `load:k6:external` and `load:flat-memory:external` scripts target a deployed
gateway and are not part of ordinary CI. They fail closed when their required
target, credential, profile, or memory-observation environment is absent. Run
them only against an authorized environment; see
[`Docs/DEPLOY.md`](../Docs/DEPLOY.md) for the release procedure and acceptance
criteria.
