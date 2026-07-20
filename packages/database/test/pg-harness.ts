// Shared throwaway-Postgres attack-test harness for @manifold/database and @manifold/budget.
//
// Both the tenant-isolation suite (isolation.test.ts) and the no-oversell money suite
// (budget/test/budget-attacks.test.ts) need the SAME container lifecycle: `docker run`
// a throwaway postgres:16 on a random published LOOPBACK port, poll readiness with the pg
// driver itself, apply migrations 0000 + 0001, hand back a driver pool, and tear the
// container down at the end even on failure. This module owns that skeleton once; each
// suite supplies only its own pool size and seed SQL.
//
// Connection approach (host-port mapping was flaky earlier): the pg `postgres` driver
// connects over a published LOOPBACK host port (127.0.0.1:<port> -> 5432) — the only way a
// host-side Node process can reach a Docker-Desktop container, and what every driver-side
// ATTACK uses. Migrations and seed rows are applied via `docker exec -i … psql -f -`
// (piping SQL over the container's stdin), which sidesteps any driver DDL/dollar-quoting
// quirks and does not depend on the host port at all.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

const HERE = dirname(fileURLToPath(import.meta.url));
// The canonical migrations live in @manifold/database; the budget suite reuses them too.
const MIGRATIONS_DIR = join(HERE, "..", "migrations");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StartPgOptions {
  /** Driver pool `max`. Isolation uses the default; budget passes 30 for the 50-way
   *  stampede so reservations genuinely contend on the FOR UPDATE row lock. */
  poolSize?: number;
  /** Container name prefix, for readability in `docker ps`. */
  namePrefix?: string;
}

export interface PgHarness {
  /** Long-lived driver pool bound to the container (connects as superuser `postgres`). */
  sql: Sql;
  /** postgres:// connection URL for the container's loopback port. */
  url: string;
  /** Apply a SQL blob inside the container as the (superuser) postgres role — used for
   *  per-suite seeding (reference rows, the isolation app_role, budget accounts). */
  psql: (sqlText: string) => void;
  /** End the pool and force-remove the container. Safe to call once in `after()`. */
  stop: () => Promise<void>;
}

/**
 * Start a throwaway Postgres 16 container, apply migrations 0000 + 0001, and return a
 * driver pool plus a `psql` seeding helper and a `stop` teardown. Retries a few random
 * loopback ports in case of a bind clash.
 */
export async function startPg(options: StartPgOptions = {}): Promise<PgHarness> {
  const { poolSize = 4, namePrefix = "mf-pg-test" } = options;
  const container = `${namePrefix}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let hostPort = 0;
  let containerStarted = false;

  function docker(args: string[], input?: string): string {
    return execFileSync("docker", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // Apply a SQL blob inside the container as the (superuser) postgres role. ON_ERROR_STOP=1
  // makes any failed statement a non-zero exit -> execFileSync throws with psql's stderr.
  function psql(sqlText: string): void {
    try {
      docker(
        [
          "exec", "-i", container,
          "psql", "-U", "postgres", "-d", "postgres",
          "-v", "ON_ERROR_STOP=1", "-q", "-f", "-",
        ],
        sqlText,
      );
    } catch (e: unknown) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      throw new Error(`psql failed: ${err.stderr || err.stdout || err.message}`);
    }
  }

  async function waitForReady(): Promise<void> {
    // Poll with the pg driver itself (NOT host pg_isready). The postgres:16 image runs a
    // transient socket-only server during initdb; the published TCP port only answers once
    // the real server is up, so the first successful TCP `select 1` means genuinely ready.
    const deadline = Date.now() + 90_000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      const probe = postgres({
        host: "127.0.0.1",
        port: hostPort,
        database: "postgres",
        username: "postgres",
        password: "postgres",
        max: 1,
        connect_timeout: 4,
        idle_timeout: 1,
        prepare: false,
        onnotice: () => {},
      });
      try {
        await probe`select 1`;
        await probe.end({ timeout: 2 });
        return;
      } catch (e) {
        lastErr = e;
        try { await probe.end({ timeout: 1 }); } catch { /* ignore */ }
        await sleep(1000);
      }
    }
    throw new Error(`Postgres never became ready on 127.0.0.1:${hostPort}: ${String(lastErr)}`);
  }

  // Start the container, retrying a few random loopback ports in case of a bind clash.
  let started = false;
  let startErr: unknown;
  for (let attempt = 0; attempt < 6 && !started; attempt++) {
    hostPort = 20000 + Math.floor(Math.random() * 40000);
    try {
      docker([
        "run", "-d", "--name", container,
        "-p", `127.0.0.1:${hostPort}:5432`,
        "-e", "POSTGRES_PASSWORD=postgres",
        "-e", "POSTGRES_DB=postgres",
        "postgres:16",
      ]);
      started = true;
      containerStarted = true;
    } catch (e) {
      startErr = e;
      // Clean up a half-created container before retrying another port.
      try { docker(["rm", "-f", container]); } catch { /* ignore */ }
    }
  }
  if (!started) throw new Error(`could not start postgres container: ${String(startErr)}`);

  await waitForReady();

  // Apply BOTH migrations in order (0000 schema, then 0001 partitions + RLS + triggers).
  psql(readFileSync(join(MIGRATIONS_DIR, "0000_tiresome_piledriver.sql"), "utf8"));
  psql(readFileSync(join(MIGRATIONS_DIR, "0001_partitions.sql"), "utf8"));

  const url = `postgres://postgres:postgres@127.0.0.1:${hostPort}/postgres`;

  // Long-lived driver handle used by all ATTACK cases (connects as superuser `postgres`;
  // suites downshift to a non-superuser role per-transaction where they need to).
  const sql = postgres({
    host: "127.0.0.1",
    port: hostPort,
    database: "postgres",
    username: "postgres",
    password: "postgres",
    max: poolSize,
    prepare: false,
    onnotice: () => {},
  });

  async function stop(): Promise<void> {
    try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
    if (containerStarted) {
      try { docker(["rm", "-f", container]); } catch { /* ignore */ }
    }
  }

  return { sql, url, psql, stop };
}
