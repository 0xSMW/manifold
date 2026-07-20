// scripts/seed.ts — CLI wrapper around the internal seed route (SPEC §21 verify helper).
//
// Seeding runs server-side (POST /api/v1/admin/seed) because the workspace DB packages must be
// resolved through Next's bundler (@manifold/database ships extension-less ESM imports that a
// plain `node` cannot resolve). This script just calls that route and prints the api_token once.
//
// Usage:
//   MANIFOLD_SEED_SECRET=<secret> node --experimental-strip-types apps/control-plane/scripts/seed.ts
// Env:
//   CONTROL_PLANE_URL   base url (default http://localhost:3000)
//   MANIFOLD_SEED_SECRET must match the server's env
async function main(): Promise<void> {
  const base = process.env.CONTROL_PLANE_URL ?? "http://localhost:3000";
  const secret = process.env.MANIFOLD_SEED_SECRET;
  if (!secret) {
    console.error("MANIFOLD_SEED_SECRET is required");
    process.exit(1);
  }
  const res = await fetch(`${base}/api/v1/admin/seed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seed-secret": secret },
    body: JSON.stringify({
      slug: process.argv[2] ?? undefined,
      email: process.argv[3] ?? undefined,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error("seed failed:", JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log("Seeded workspace. Save the api_token — it is shown only once:\n");
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
