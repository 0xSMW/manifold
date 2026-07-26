import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

function gatewayFixture(enterpriseSuccessCap) {
  let enterpriseSuccesses = 0;
  return createServer(async (request, response) => {
    for await (const ignored of request) void ignored;
    if (request.method !== "POST" || !["/v1/chat/completions/public", "/v1/chat/completions/enterprise"].includes(request.url ?? "") || request.headers.authorization !== "Bearer fixture-virtual-key") {
      return response.writeHead(401, { "content-type": "application/json" }).end('{"error":"fixture authorization"}');
    }
    if (request.url === "/v1/chat/completions/enterprise" && enterpriseSuccesses >= enterpriseSuccessCap) {
      return response.writeHead(402, { "content-type": "application/json", "x-manifold-ingested-at": new Date().toISOString() }).end('{"error":{"code":"BUDGET_RESERVE_DENIED"}}');
    }
    if (request.url === "/v1/chat/completions/enterprise") enterpriseSuccesses += 1;
    response.writeHead(200, { "content-type": "application/json", "x-manifold-ingested-at": new Date().toISOString() });
    response.end('{"id":"fixture","object":"chat.completion","choices":[]}');
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`k6 exited with ${signal ?? code}`)));
  });
}

export async function runK6LocalFixture(env = process.env) {
  const enterpriseSuccessCap = Number(env.MANIFOLD_FIXTURE_ENTERPRISE_SUCCESS_CAP ?? "3");
  if (!Number.isSafeInteger(enterpriseSuccessCap) || enterpriseSuccessCap < 1) throw new Error("invalid MANIFOLD_FIXTURE_ENTERPRISE_SUCCESS_CAP");
  const server = gatewayFixture(enterpriseSuccessCap);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP address");
  const script = fileURLToPath(new URL("../tools/load/gateway-overhead.k6.js", import.meta.url));
  try {
    const shared = {
      ...env,
      MANIFOLD_GATEWAY_URL: `http://127.0.0.1:${address.port}`,
      MANIFOLD_VIRTUAL_KEY: "fixture-virtual-key",
      MANIFOLD_LOAD_VUS: env.MANIFOLD_LOAD_VUS ?? "1",
      MANIFOLD_LOAD_DURATION: env.MANIFOLD_LOAD_DURATION ?? "1s",
      MANIFOLD_PUBLIC_OVERHEAD_P99_MS: env.MANIFOLD_PUBLIC_OVERHEAD_P99_MS ?? "1000",
      MANIFOLD_ENTERPRISE_OVERHEAD_P99_MS: env.MANIFOLD_ENTERPRISE_OVERHEAD_P99_MS ?? "1000",
      MANIFOLD_REQUIRE_INGEST_LAG: "1",
    };
    await run(env.K6_BIN ?? "k6", ["run", script], { ...shared, MANIFOLD_LOAD_PROFILE: "public_app", MANIFOLD_LOAD_ENDPOINT: "/v1/chat/completions/public" });
    await run(env.K6_BIN ?? "k6", ["run", script], {
      ...shared,
      MANIFOLD_LOAD_PROFILE: "enterprise_egress",
      MANIFOLD_LOAD_ENDPOINT: "/v1/chat/completions/enterprise",
      MANIFOLD_HARD_BUDGET_SUCCESS_CAP: String(enterpriseSuccessCap),
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runK6LocalFixture().catch((error) => {
    process.stderr.write(`local k6 release gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
