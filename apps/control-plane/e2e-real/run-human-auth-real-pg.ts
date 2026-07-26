import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startPg } from "../../../packages/database/test/pg-harness.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22) throw new Error(`human-auth real-Postgres E2E requires Node 22 (found ${process.versions.node})`);

const port = 32_000 + Math.floor(Math.random() * 1_000);
const baseURL = `http://127.0.0.1:${port}`;
const pepper = "manifold-e2e-real-pg-pepper";
const activationToken = "e2e-activation-capability";
const hash = (value: string) => createHmac("sha256", pepper).update(value, "utf8").digest();

function appUrl(superuserUrl: string): string {
  const url = new URL(superuserUrl);
  url.username = "manifold_app";
  url.password = "CHANGEME_APP_PASSWORD";
  return url.toString();
}

async function waitForServer(child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next dev server exited early (${child.exitCode})`);
    try {
      if ((await fetch(`${baseURL}/login`)).ok) return;
    } catch { /* Server is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Next dev server did not become ready within 120 seconds");
}

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  const pg = await startPg({ namePrefix: "mf-human-auth-browser", poolSize: 8 });
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await pg.sql`INSERT INTO workspace (id, slug, name, region) VALUES ('ws_real_auth', 'real-auth', 'Real auth', 'local')`;
    await pg.sql`INSERT INTO member (id, workspace_id, email, role) VALUES ('mem_real_owner', 'ws_real_auth', 'owner@example.test', 'owner')`;
    await pg.sql`SELECT * FROM auth_prepare_initial_activation('owner@example.test', 'usr_real_owner', 'act_real_owner', ${hash(activationToken)}, now() + interval '1 hour')`;

    const env = {
    ...process.env,
    DATABASE_URL: appUrl(pg.url),
    MANIFOLD_AUTH_TOKEN_PEPPER: pepper,
    MANIFOLD_AUTH_ORIGIN: baseURL,
    PLAYWRIGHT_BASE_URL: baseURL,
    E2E_REAL_PG_URL: pg.url,
    E2E_REAL_ACTIVATION_TOKEN: activationToken,
    NODE_ENV: "test" as const,
    };
    const startedServer = spawn("pnpm", ["--filter", "@manifold/control-plane", "exec", "next", "dev", "--port", String(port)], { cwd: process.cwd(), env, stdio: "inherit" });
    server = startedServer;
    await waitForServer(startedServer);
    const playwright = spawn("pnpm", ["--filter", "@manifold/control-plane", "exec", "playwright", "test", "-c", "e2e-real/playwright.config.ts"], { cwd: process.cwd(), env, stdio: "inherit" });
    const [code] = await once(playwright, "exit") as [number | null];
    if (code !== 0) process.exitCode = code ?? 1;
  } finally {
    if (server) await stop(server);
    await pg.stop();
  }
}

void main();
