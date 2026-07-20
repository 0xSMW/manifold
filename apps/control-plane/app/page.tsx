export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "10vh auto", padding: "0 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Manifold</h1>
      <p style={{ opacity: 0.7, lineHeight: 1.6 }}>
        OpenAI-compatible, self-hostable AI gateway that is also its own logging
        and governance product. This is the control plane skeleton (M0/M1).
      </p>
      <p style={{ opacity: 0.7 }}>
        Health:{" "}
        <a href="/api/v1/health" style={{ color: "#7aa2f7" }}>
          /api/v1/health
        </a>
      </p>
      <p style={{ opacity: 0.4, fontSize: 13, marginTop: 40 }}>
        schema manifold.v1 · Apache-2.0 · not yet wired to a database
      </p>
    </main>
  );
}
