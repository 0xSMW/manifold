import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { S3ObjectStorageExporter, awsCanonicalPath, awsCanonicalQuery, awsPercentEncode, isValidObjectStorageLocation, objectStorageConfigurationError, type ObjectStorageTransport } from "../src/object-store.js";

class DeterministicObjectStore implements ObjectStorageTransport {
  readonly objects = new Map<string, { bytes: Uint8Array; sha256: string; byteCount: string }>();
  puts = 0;
  readonly contentTypes: string[] = [];
  constructor(private readonly preconditionFailure = false) {}

  async fetch(request: Request): Promise<Response> {
    const key = request.url;
    if (request.method === "PUT") {
      this.puts += 1;
      assert.equal(request.headers.get("if-none-match"), "*");
      assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
      this.contentTypes.push(request.headers.get("content-type")!);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!this.preconditionFailure) this.objects.set(key, { bytes, sha256: request.headers.get("x-amz-meta-sha256")!, byteCount: request.headers.get("x-amz-meta-byte-count")! });
      return new Response(null, { status: this.preconditionFailure ? 412 : 200 });
    }
    if (request.method === "HEAD") {
      const object = this.objects.get(key);
      return object ? new Response(null, { status: 200, headers: { "content-length": String(object.bytes.length), "x-amz-meta-sha256": object.sha256, "x-amz-meta-byte-count": object.byteCount } }) : new Response(null, { status: 404 });
    }
    if (request.method === "GET") {
      const object = this.objects.get(key);
      return object ? new Response(object.bytes, { status: 200 }) : new Response(null, { status: 404 });
    }
    throw new Error(`unexpected method ${request.method}`);
  }
}

const env = {
  MANIFOLD_OBJECT_STORAGE_ENDPOINT: "https://object.example.test/root",
  MANIFOLD_OBJECT_STORAGE_REGION: "us-east-1",
  MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID: "test-access-key",
  MANIFOLD_OBJECT_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
};
const fixedNow = () => new Date("2026-07-25T01:02:03.000Z");

test("object storage writes a conditional immutable JSONL object then verifies exact bytes and hash", async () => {
  const transport = new DeterministicObjectStore();
  const bytes = Buffer.from('{"id":"one"}\n', "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  const object = await exporter.putImmutable("s3://archive-bucket/retention/manifold", "ws_1-observation-p20260725.jsonl", bytes, digest);
  assert.deepEqual(object, { uri: "s3://archive-bucket/retention/manifold/ws_1-observation-p20260725.jsonl", byteCount: bytes.length, sha256: digest });
  assert.equal(transport.puts, 1);
  assert.deepEqual(transport.objects.get("https://object.example.test/root/archive-bucket/retention/manifold/ws_1-observation-p20260725.jsonl")?.bytes, new Uint8Array(bytes));
});

test("durable URI re-verification performs HEAD plus GET hashing and rejects changed bytes", async () => {
  const transport = new DeterministicObjectStore();
  const bytes = Buffer.from('{"id":"one"}\n'); const digest = createHash("sha256").update(bytes).digest("hex");
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  const persisted = await exporter.putImmutable("s3://archive-bucket/retention", "sealed.jsonl.gz", bytes, digest);
  assert.deepEqual(await exporter.reverifyImmutable(persisted.uri, bytes.length, digest), persisted);
  const key = "https://object.example.test/root/archive-bucket/retention/sealed.jsonl.gz";
  transport.objects.set(key, { bytes: new Uint8Array(Buffer.from('{"id":"two"}\n')), sha256: digest, byteCount: String(bytes.length) });
  await assert.rejects(() => exporter.reverifyImmutable(persisted.uri, bytes.length, digest), /content hash verification failed/);
});

test("AWS canonical encoding follows RFC3986 and sorts encoded query pairs", () => {
  assert.equal(awsPercentEncode("!'()* /"), "%21%27%28%29%2A%20%2F");
  assert.equal(awsCanonicalPath("bucket/a b/!*"), "bucket/a%20b/%21%2A");
  assert.equal(awsCanonicalQuery("?z=two words&a=!&a=+"), "a=%20&a=%21&z=two%20words");
});

test("a 412 retry rejects metadata that lies about the immutable bytes", async () => {
  const bytes = Buffer.from('{"id":"one"}\n', "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transport = new DeterministicObjectStore(true);
  transport.objects.set("https://object.example.test/root/archive-bucket/ws_1.jsonl", { bytes: new Uint8Array(Buffer.from('{"id":"two"}\n')), sha256: digest, byteCount: String(bytes.length) });
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  await assert.rejects(() => exporter.putImmutable("s3://archive-bucket", "ws_1.jsonl", bytes, digest), /content hash verification failed/);
});

test("configuration and destination validation fail closed before any storage request", () => {
  assert.equal(objectStorageConfigurationError({ ...env, NODE_ENV: "production", MANIFOLD_OBJECT_STORAGE_ENDPOINT: "http://object.example.test" }), "MANIFOLD_OBJECT_STORAGE_ENDPOINT must use https in production");
  assert.equal(objectStorageConfigurationError({ ...env, MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID: "  " }), "MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID is not configured");
  assert.equal(objectStorageConfigurationError({ ...env, MANIFOLD_OBJECT_STORAGE_ENDPOINT: "https://user:pass@object.example.test" }), "MANIFOLD_OBJECT_STORAGE_ENDPOINT must be a plain http or https URL");
  assert.equal(isValidObjectStorageLocation("s3://archive-bucket/retention"), true);
  assert.equal(isValidObjectStorageLocation("s3://a/retention"), false);
  assert.equal(isValidObjectStorageLocation("s3://archive-bucket/retention?copy=1"), false);
});

test("manifest-shaped JSON is uploaded conditionally with JSON content type", async () => {
  const transport = new DeterministicObjectStore();
  const bytes = Buffer.from('{"schema":"manifold.storage-export-manifest.v1"}\n', "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  await exporter.putImmutable("s3://archive-bucket/retention", "partition-manifest.json", bytes, digest, "application/json");
  assert.deepEqual(transport.contentTypes, ["application/json"]);
});

test("multipart streaming signs initiate, parts, completion, and verifies persisted bytes", async () => {
  const parts: Uint8Array[] = [];
  let complete = false;
  const transport: ObjectStorageTransport = { fetch: async (request) => {
    assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
    const url = new URL(request.url);
    if (request.method === "POST" && url.search.includes("uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>", { status: 200 });
    if (request.method === "PUT" && url.searchParams.has("partNumber")) { parts.push(new Uint8Array(await request.arrayBuffer())); return new Response(null, { status: 200, headers: { etag: `\"${parts.length}\"` } }); }
    if (request.method === "POST" && url.searchParams.has("uploadId")) { complete = true; return new Response("<CompleteMultipartUploadResult/>", { status: 200 }); }
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(bytes.length) } });
    if (request.method === "GET") return new Response(bytes, { status: 200 });
    throw new Error(`unexpected ${request.method} ${url.search}`);
  }};
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  const body = (async function* () { yield Buffer.from("first\n"); yield Buffer.from("second\n"); })();
  const result = await exporter.putImmutableStream("s3://archive-bucket/retention", "sealed.jsonl.gz", body, "application/gzip");
  assert.equal(complete, true);
  assert.equal(result.byteCount, Buffer.byteLength("first\nsecond\n"));
  assert.equal(result.sha256, createHash("sha256").update("first\nsecond\n").digest("hex"));
});

test("a retry accepts a pre-existing immutable object only after exact HEAD proof", async () => {
  const bytes = Buffer.from('{"id":"one"}\n', "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transport = new DeterministicObjectStore(true);
  transport.objects.set("https://object.example.test/root/archive-bucket/ws_1.jsonl", { bytes: new Uint8Array(bytes), sha256: digest, byteCount: String(bytes.length) });
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  const object = await exporter.putImmutable("s3://archive-bucket", "ws_1.jsonl", bytes, digest);
  assert.equal(object.byteCount, bytes.length);
  assert.equal(transport.puts, 1);
});

test("a retry fails closed when the pre-existing object proof differs", async () => {
  const bytes = Buffer.from('{"id":"one"}\n', "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const transport = new DeterministicObjectStore(true);
  transport.objects.set("https://object.example.test/root/archive-bucket/ws_1.jsonl", { bytes: new Uint8Array(bytes), sha256: "0".repeat(64), byteCount: String(bytes.length) });
  const exporter = new S3ObjectStorageExporter(transport, env, fixedNow);
  await assert.rejects(() => exporter.putImmutable("s3://archive-bucket", "ws_1.jsonl", bytes, digest), /verification failed/);
});
