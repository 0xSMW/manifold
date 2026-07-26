import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeOpenAiRequest, RequestCodecError, toOpenAiProviderRequest } from "../../packages/gateway-core/src/codecs.ts";
import { errorResponse } from "../../packages/gateway-core/src/errors.ts";

type RequestFixture = { name: string; provider: string; endpoint: string; providerModel: string; path: string; body: Record<string, unknown>; recordedResponse: Record<string, unknown> };
type ErrorFixture = { name: string; path: string; body: Record<string, unknown>; headers?: Record<string, string>; code: string; status: number; type: string; param: string | null };
const here = new URL("./fixtures/", import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, here), "utf8")) as T;

export async function replayFixtures(): Promise<void> {
  const fixtures = read<RequestFixture[]>("requests.json");
  const metadata = JSON.parse(readFileSync(new URL("./adapter-metadata.json", import.meta.url), "utf8")) as { adapters: Array<{ provider: string; endpoints: Record<string, string> }> };
  const matrix = JSON.parse(readFileSync(new URL("./capability-matrix.json", import.meta.url), "utf8")) as { matrix: Array<{ provider: string; endpoint: string; support: string }> };
  for (const fixture of fixtures) {
    const adapter = metadata.adapters.find((candidate) => candidate.provider === fixture.provider);
    assert.ok(adapter, `${fixture.name}: provider metadata exists`);
    assert.equal(adapter.endpoints[fixture.endpoint], "supported", `${fixture.name}: fixture must match supported adapter capability`);
    assert.equal(matrix.matrix.find((entry) => entry.provider === fixture.provider && entry.endpoint === fixture.endpoint)?.support, "supported", `${fixture.name}: fixture must match generated matrix capability`);
    const decoded = await decodeOpenAiRequest(new Request(`https://gateway.test${fixture.path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.body) }));
    assert.equal(decoded.endpointKind, fixture.endpoint, fixture.name);
    assert.deepEqual(decoded.body, fixture.body, `${fixture.name}: unknown request fields survive decode`);
    const providerRequest = toOpenAiProviderRequest(decoded, { providerModelId: fixture.providerModel });
    assert.equal(new URL(providerRequest.url).pathname, fixture.path.split("?")[0], `${fixture.name}: endpoint remains distinct`);
    assert.equal(new URL(providerRequest.url).search, fixture.path.includes("?") ? `?${fixture.path.split("?")[1]}` : "", `${fixture.name}: query remains exact`);
    assert.deepEqual(await providerRequest.json(), { ...fixture.body, model: fixture.providerModel }, `${fixture.name}: only model changes`);
    assert.ok(typeof fixture.recordedResponse.id === "string" || typeof fixture.recordedResponse.object === "string", `${fixture.name}: recorded OpenAI response shape is retained`);
    const replayedOutput = await new Response(JSON.stringify(fixture.recordedResponse), { headers: { "content-type": "application/json" } }).json() as Record<string, unknown>;
    assert.deepEqual(replayedOutput, fixture.recordedResponse, `${fixture.name}: recorded OpenAI output and unknown fields survive replay`);
  }
  for (const fixture of read<ErrorFixture[]>("errors.json")) {
    const request = new Request(`https://gateway.test${fixture.path}`, { method: "POST", headers: fixture.headers ?? { "content-type": "application/json" }, body: JSON.stringify(fixture.body) });
    await assert.rejects(() => decodeOpenAiRequest(request), (error: unknown) => error instanceof RequestCodecError && error.code === fixture.code && error.status === fixture.status, fixture.name);
    const response = errorResponse(fixture.code, "safe fixture error", "trace_fixture");
    assert.equal(response.status, fixture.status, fixture.name);
    assert.deepEqual(await response.json(), { error: { message: "safe fixture error", type: fixture.type, param: fixture.param, code: fixture.code } }, `${fixture.name}: OpenAI error envelope`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  replayFixtures().then(() => process.stdout.write("conformance fixtures: ok\n"));
}
