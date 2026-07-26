/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  // Workspace packages ship pre-built ESM under dist/. @manifold/database uses
  // extension-less relative imports ("./schema") which strict Node ESM / webpack
  // (type:module) reject; letting Next transpile them resolves those imports the
  // same way the source packages resolve them. (SPEC §4.1 monorepo boundaries.)
  transpilePackages: [
    "@manifold/database",
    "@manifold/config",
    "@manifold/contracts",
    "@manifold/domain",
    "@manifold/ports",
  ],
  // `postgres` does its own connection handling / dynamic requires — keep it external
  // to the server bundle so it loads from node_modules at runtime (SPEC §4.2, §2.4).
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
