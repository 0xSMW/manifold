import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const protectedPackages = [
  "packages/gateway-core",
  "packages/gateway-policy",
  "packages/domain",
  "packages/provider-registry",
  "packages/observability",
  "packages/config",
];
const forbidden = [
  /(?:from\s+|require\(\s*)["'](?:@vercel\/|@cloudflare\/|next(?:\/|["'])|(?:@manifold\/)?adapters-|apps\/)/,
  /(?:from\s+|require\(\s*)["'](?:drizzle-orm|postgres)(?:\/|["'])/,
];

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test"].includes(entry.name) ? [] : files(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  }))).flat();
}

const violations = [];
for (const packagePath of protectedPackages) {
  for (const path of await files(join(root, packagePath))) {
    const source = await readFile(path, "utf8");
    if (forbidden.some((pattern) => pattern.test(source))) violations.push(relative(root, path));
  }
}
if (violations.length) throw new Error(`Platform or database import escaped its boundary:\n${violations.join("\n")}`);
console.log("Boundary lint passed.");
