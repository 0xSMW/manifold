import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tenantTables = ["workspace", "member", "gateway_route", "virtual_key", "budget_account", "observation", "audit_event", "provider_credential"];
const query = /(?:SELECT|UPDATE|DELETE)\s+[\s\S]{0,700}?\b(?:FROM|UPDATE)\s+([a-z_]+)/gi;

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", ".next"].includes(entry.name) ? [] : files(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  }))).flat();
}

const violations = [];
for (const base of ["apps", "packages"]) for (const path of await files(join(root, base))) {
  const source = await readFile(path, "utf8");
  const fileHasWorkspaceScope = /workspace_id|setWorkspaceGuc|withWorkspace/.test(source);
  for (const match of source.matchAll(query)) {
    if (!tenantTables.includes(match[1])) continue;
    if (!fileHasWorkspaceScope) violations.push(`${relative(root, path)}: ${match[1]} query lacks workspace_id scope`);
  }
}
if (violations.length) throw new Error(`Workspace query lint failed:\n${violations.join("\n")}`);
console.log("Workspace query lint passed.");
