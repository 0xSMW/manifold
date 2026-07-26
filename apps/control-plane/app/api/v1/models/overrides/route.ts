import { sha256Canonical } from "@manifold/config";
import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { withWorkspace } from "@/lib/db";
import { genId } from "@/lib/ids";
import { jsonBody, ManifoldError, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { ModelsApi } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const priceFields = ["inputPerMtokMicrousd", "outputPerMtokMicrousd", "cacheReadPerMtokMicrousd", "cacheWritePerMtokMicrousd", "reasoningPerMtokMicrousd", "audioInPerMtokMicrousd", "audioOutPerMtokMicrousd"] as const;
type PriceField = (typeof priceFields)[number];
type Input = { offeringId: string } & Record<PriceField, string | null>;

function invalid(message: string, path: string): never { throw new ManifoldError({ status: 422, code: "VALIDATION", message, reasonCodes: [], details: { issues: [{ path, message }] } }); }
function parse(body: Record<string, unknown>): Input {
  const allowed = new Set(["offeringId", ...priceFields]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) invalid(`unknown field '${key}'`, key);
  if (typeof body.offeringId !== "string" || !body.offeringId.trim()) invalid("offeringId is required", "offeringId");
  const parsed = { offeringId: body.offeringId.trim() } as Input;
  let present = 0;
  for (const field of priceFields) {
    const value = body[field];
    if (value === undefined || value === null || value === "") { parsed[field] = null; continue; }
    if (typeof value !== "string" || !/^\d+$/.test(value)) invalid(`${field} must be a non-negative integer microdollar string or null`, field);
    parsed[field] = value;
    present += 1;
  }
  if (!present) invalid("provide at least one price field", "body");
  return parsed;
}

export async function POST(req: Request): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "registry:write");
    const input = parse(await contractBody(req, ModelsApi.overrideRequest));
    const result = await withWorkspace(principal.workspaceId, async (sql) => {
      const offering = (await sql<{ id: string }[]>`SELECT id FROM provider_model_offering WHERE id = ${input.offeringId} LIMIT 1`)[0];
      if (!offering) return null;
      const content = { workspaceId: principal.workspaceId, offeringId: input.offeringId, prices: Object.fromEntries(priceFields.map((field) => [field, input[field]])) };
      const contentHash = sha256Canonical(content);
      const existing = (await sql<{ id: string }[]>`SELECT id FROM provider_price_revision WHERE workspace_id = ${principal.workspaceId} AND offering_id = ${input.offeringId} AND content_hash = ${contentHash} LIMIT 1`)[0];
      if (existing) return { id: existing.id, contentHash, replay: true };
      const id = genId("prc");
      await sql`INSERT INTO provider_price_revision (id, offering_id, workspace_id, input_per_mtok_microusd, output_per_mtok_microusd, cache_read_per_mtok_microusd, cache_write_per_mtok_microusd, reasoning_per_mtok_microusd, audio_in_per_mtok_microusd, audio_out_per_mtok_microusd, fidelity, content_hash, created_by) VALUES (${id}, ${input.offeringId}, ${principal.workspaceId}, ${input.inputPerMtokMicrousd}, ${input.outputPerMtokMicrousd}, ${input.cacheReadPerMtokMicrousd}, ${input.cacheWritePerMtokMicrousd}, ${input.reasoningPerMtokMicrousd}, ${input.audioInPerMtokMicrousd}, ${input.audioOutPerMtokMicrousd}, 'operator_override', ${contentHash}, ${principal.member?.id ?? null})`;
      await audit(sql, principal, { action: "registry.override.set", targetKind: "provider_price_revision", targetId: id, requestId, detail: { offeringId: input.offeringId, contentHash, fidelity: "operator_override", staged: true } });
      return { id, contentHash, replay: false };
    });
    if (!result) throw new ManifoldError({ status: 404, code: "NOT_FOUND", message: "model offering not found", reasonCodes: [] });
    return contractOk(ModelsApi.overrideResponse, { id: result.id, offeringId: input.offeringId, fidelity: "operator_override", contentHash: result.contentHash, status: "staged", publishRequired: true, replay: result.replay }, requestId, result.replay ? 200 : 201);
  });
}
