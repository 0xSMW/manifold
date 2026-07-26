# Release conformance and performance gates

`tools/conformance` replays recorded chat, Responses, and embeddings request/response shapes through the current OpenAI codecs. It makes no provider calls. The committed capability matrix is generated only from `adapter-metadata.json`.

```bash
npm run conformance:replay
npm run conformance:matrix:check
```

After a reviewed metadata change, run `npm run conformance:matrix` and commit the new matrix.

Ordinary CI runs the local deterministic `load:k6` and `load:flat-memory` fixtures.
These commands exercise the checked-in fixtures without contacting a deployed
target:

```bash
npm run load:k6
npm run load:flat-memory
```

External validation is managed through protected release infrastructure. Its
target configuration, credentials, probe details, and acceptance criteria are
intentionally not documented in this repository.
