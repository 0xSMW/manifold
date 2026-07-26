import { authenticateBearer } from "@/lib/auth";
import { withWorkspace } from "@/lib/db";
import { contractOk } from "@/lib/contracts";
import { wrapInEnvelope, ManifoldError } from "@/lib/http";
import { HumanAuthContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(req: Request) { return wrapInEnvelope(async (requestId) => { const principal = await authenticateBearer(req); const tokenId = principal.tokenId; if (!tokenId) throw new ManifoldError({ status: 401, code: "UNAUTHENTICATED", message: "invalid token", reasonCodes: [] }); await withWorkspace(principal.workspaceId, async (sql) => { await sql`UPDATE api_token SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${tokenId} AND workspace_id = ${principal.workspaceId}`; }); return contractOk(HumanAuthContracts.cliSelfRevokeResponse, { revoked: true }, requestId); }); }
