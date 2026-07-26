#!/usr/bin/env node
import { execFile } from "node:child_process";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const childPath = fileURLToPath(new URL("./flat-memory-gateway-child.mjs", import.meta.url));
const requiredInteger = (value, name) => { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${name}`); return number; };
function rssBytes(pid) {
  return new Promise((resolve, reject) => execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
    if (error) return reject(error);
    const kib = Number(stdout.trim());
    if (!Number.isFinite(kib) || kib < 0) return reject(new Error("gateway RSS is unavailable"));
    resolve(kib * 1024);
  }));
}
export async function runFlatMemoryFixtureGate(env = process.env) {
  const bytes = requiredInteger(env.MANIFOLD_FLAT_MEMORY_BYTES ?? GIB, "MANIFOLD_FLAT_MEMORY_BYTES");
  const maxRssDelta = requiredInteger(env.MANIFOLD_FLAT_MEMORY_MAX_RSS_DELTA_BYTES ?? 128 * MIB, "MANIFOLD_FLAT_MEMORY_MAX_RSS_DELTA_BYTES");
  const child = spawn(process.execPath, [childPath], { env: { ...env, MANIFOLD_FLAT_MEMORY_BYTES: String(bytes) }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway child did not become ready")), 10_000);
    const listen = () => { const line = output.split("\n").find((candidate) => candidate.includes('"event":"ready"')); if (line) { clearTimeout(timer); resolve(); } else setTimeout(listen, 5); };
    child.once("error", reject); listen();
  });
  const baseline = await rssBytes(child.pid);
  let peak = baseline; let sampling = false;
  const sample = async () => { if (sampling || child.exitCode !== null) return; sampling = true; try { peak = Math.max(peak, await rssBytes(child.pid)); } catch {} finally { sampling = false; } };
  const interval = setInterval(sample, 10); child.stdin.end("start\n");
  const [code] = await once(child, "exit"); clearInterval(interval); await sample();
  const complete = output.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((event) => event?.event === "complete");
  if (code !== 0 || !complete) throw new Error(`gateway child failed${errors ? `: ${errors.trim()}` : ""}`);
  if (complete.bytes !== bytes) throw new Error(`expected ${bytes} bytes through gateway, received ${complete.bytes}`);
  const rssDelta = Math.max(0, peak - baseline);
  if (rssDelta > maxRssDelta) throw new Error(`gateway RSS delta ${rssDelta} exceeds ${maxRssDelta}`);
  return { ok: true, bytes, baselineRss: baseline, peakRss: peak, rssDelta, maxRssDelta, gatewayCoreArtifact: "packages/gateway-core/dist/index.js" };
}
if (import.meta.url === `file://${process.argv[1]}`) runFlatMemoryFixtureGate().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`flat-memory fixture release gate failed: ${error.message}\n`); process.exitCode = 1; });
