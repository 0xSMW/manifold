#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const metadataPath = new URL("adapter-metadata.json", root);
const outputPath = new URL("capability-matrix.json", root);
const endpoints = ["chat", "responses", "embeddings"];

export function matrixFromMetadata(metadata) {
  if (metadata?.schema !== "manifold.adapter-capabilities.v1" || !Array.isArray(metadata.adapters)) {
    throw new Error("invalid adapter metadata");
  }
  const seen = new Set();
  const matrix = metadata.adapters.flatMap((adapter) => {
    if (typeof adapter.provider !== "string" || typeof adapter.revision !== "string" || !adapter.endpoints) {
      throw new Error("invalid adapter metadata entry");
    }
    if (seen.has(adapter.provider)) throw new Error(`duplicate adapter provider: ${adapter.provider}`);
    seen.add(adapter.provider);
    return endpoints.map((endpoint) => {
      const support = adapter.endpoints[endpoint];
      if (support !== "supported" && support !== "unsupported" && support !== "unknown") {
        throw new Error(`invalid ${endpoint} support for ${adapter.provider}`);
      }
      return { endpoint, provider: adapter.provider, revision: adapter.revision, support };
    });
  });
  matrix.sort((a, b) => a.provider.localeCompare(b.provider) || a.endpoint.localeCompare(b.endpoint));
  return { schema: "manifold.endpoint-provider-capability-matrix.v1", matrix };
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = canonicalJson(matrixFromMetadata(JSON.parse(readFileSync(metadataPath, "utf8"))));
  if (process.argv.includes("--check")) {
    if (readFileSync(outputPath, "utf8") !== generated) {
      process.stderr.write("capability matrix drift: run npm run conformance:matrix\n");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(outputPath, generated);
  }
}
