import { wrapInEnvelope } from "@/lib/http";
import { authorizeSettings } from "@/lib/settings/access";
import { contractOk, contractQuery } from "@/lib/contracts";
import { SettingsEndpointContracts } from "@manifold/contracts";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(req: Request) { return wrapInEnvelope(async (requestId) => { contractQuery(new URL(req.url).searchParams, SettingsEndpointContracts.emptyQuery); await authorizeSettings(req, "config:read"); return contractOk(SettingsEndpointContracts.settingsIndex, { data: { workspace: "/api/v1/settings/workspace", members: "/api/v1/settings/members", teams: "/api/v1/settings/teams", costCenters: "/api/v1/settings/cost-centers", tokens: "/api/v1/settings/tokens", apps: "/api/v1/settings/apps", alerts: "/api/v1/settings/alerts", cliAuthorization: "/api/v1/settings/cli-auth", dangerZone: "/api/v1/settings/danger-zone" } }, requestId); }); }
