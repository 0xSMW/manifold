import { rawSql } from "@/lib/db";
import { SCHEMA_VERSION } from "@manifold/contracts";

// Server-rendered at request time so the status reflects the LIVE database, not a build-time or
// hardcoded claim. Runs the same `SELECT 1` liveness probe as GET /api/v1/health, plus a real
// workspace count — the page states what is actually true of this deployment, never a scaffold string.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function dbStatus(): Promise<{ connected: boolean; workspaces: number | null }> {
  if (!process.env.DATABASE_URL) return { connected: false, workspaces: null };
  try {
    const rows = await rawSql()<{ n: string }[]>`SELECT count(*)::text AS n FROM workspace`;
    return { connected: true, workspaces: Number(rows[0]?.n ?? 0) };
  } catch {
    return { connected: false, workspaces: null };
  }
}

export default async function Home() {
  const { connected, workspaces } = await dbStatus();
  const dbLine = connected
    ? `connected · ${workspaces} workspace${workspaces === 1 ? "" : "s"}`
    : "unreachable";
  return (
    <main style={{ maxWidth: 720, margin: "10vh auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Manifold</h1>
      <p style={{ opacity: 0.7, lineHeight: 1.6 }}>
        OpenAI-compatible, self-hostable AI gateway that is also its own logging and governance
        product. This is the control plane.
      </p>
      <p style={{ opacity: 0.7 }}>
        Health:{" "}
        <a href="/api/v1/health" style={{ color: "#7aa2f7" }}>
          /api/v1/health
        </a>
      </p>
      <p style={{ opacity: 0.4, fontSize: 13, marginTop: 40 }}>
        schema {SCHEMA_VERSION} · Apache-2.0 · database: {dbLine}
      </p>
    </main>
  );
}
