const productionSecretNames = [
  "MANIFOLD_PRODUCTION_DATABASE_URL",
  "MANIFOLD_PRODUCTION_DATA_KEY",
  "MANIFOLD_PRODUCTION_KEK",
  "MANIFOLD_PRODUCTION_SNAPSHOT_SIGNING_KEY",
  "VERCEL_PROD_DATABASE_URL",
];

if (process.env.MANIFOLD_DEPLOYMENT_TIER === "production") {
  throw new Error("The preview/staging gate must never run with MANIFOLD_DEPLOYMENT_TIER=production.");
}
const present = productionSecretNames.filter((name) => process.env[name]?.trim());
if (present.length) throw new Error(`Production secrets are present in a non-production gate: ${present.join(", ")}`);
console.log("Preview/staging environment is isolated from production secrets.");
