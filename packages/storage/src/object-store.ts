import { createHash, createHmac } from "node:crypto";

export interface ObjectStorageTransport {
  fetch(request: Request): Promise<Response>;
}

export interface VerifiedObject {
  uri: string;
  byteCount: number;
  sha256: string;
}

export type MultipartPartProof = Readonly<{ partNumber: number; etag: string; byteCount: number; sha256: string }>;

export interface ResumableMultipartObjectStorageExporter {
  startMultipart(location: string, key: string, contentType?: string, signal?: AbortSignal): Promise<{ uploadId: string; uri: string }>;
  uploadMultipartPart(location: string, key: string, uploadId: string, partNumber: number, bytes: Buffer, signal?: AbortSignal): Promise<MultipartPartProof>;
  completeMultipart(location: string, key: string, uploadId: string, parts: readonly MultipartPartProof[], expectedBytes: number, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedObject>;
}

export interface ObjectStorageExporter {
  configured(): boolean;
  configurationError(): string | null;
  putImmutable(location: string, key: string, bytes: Buffer, sha256: string, contentType?: string, signal?: AbortSignal): Promise<VerifiedObject>;
  /** Re-read a durable immutable URI. HEAD metadata alone is never export evidence. */
  reverifyImmutable(uri: string, expectedBytes: number, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedObject>;
  /** Bounded multipart upload. Implementations must never collect the iterable as one object. */
  putImmutableStream(location: string, key: string, chunks: AsyncIterable<Uint8Array>, contentType?: string): Promise<VerifiedObject>;
}

type ObjectStorageConfig = {
  endpoint: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** AWS's canonical URI uses RFC3986 encoding, not JavaScript's slightly looser URI encoding. */
export function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function awsCanonicalPath(value: string): string {
  return value.split("/").map(awsPercentEncode).join("/");
}

export function awsCanonicalQuery(search: string): string {
  return [...new URLSearchParams(search)].map(([key, value]) => [awsPercentEncode(key), awsPercentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`).join("&");
}

function parseLocation(value: string): { bucket: string; prefix: string } {
  const url = new URL(value);
  if (url.protocol !== "s3:" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("object storage exportLocation must be an s3://bucket/optional-prefix URI");
  }
  const prefix = url.pathname.replace(/^\/+|\/+$/g, "");
  return { bucket: url.hostname, prefix };
}

export function objectStorageConfigurationError(env: NodeJS.ProcessEnv = process.env): string | null {
  const endpointValue = env.MANIFOLD_OBJECT_STORAGE_ENDPOINT?.trim();
  if (!endpointValue) return "MANIFOLD_OBJECT_STORAGE_ENDPOINT is not configured";
  try {
    const endpoint = new URL(endpointValue);
    if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return "MANIFOLD_OBJECT_STORAGE_ENDPOINT must be a plain http or https URL";
    if (endpoint.protocol === "http:" && env.NODE_ENV === "production") return "MANIFOLD_OBJECT_STORAGE_ENDPOINT must use https in production";
  } catch { return "MANIFOLD_OBJECT_STORAGE_ENDPOINT is not a valid URL"; }
  if (!env.MANIFOLD_OBJECT_STORAGE_REGION?.trim()) return "MANIFOLD_OBJECT_STORAGE_REGION is not configured";
  if (!env.MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID?.trim()) return "MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID is not configured";
  if (!env.MANIFOLD_OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim()) return "MANIFOLD_OBJECT_STORAGE_SECRET_ACCESS_KEY is not configured";
  return null;
}

function configurationFromEnv(env: NodeJS.ProcessEnv): ObjectStorageConfig {
  const error = objectStorageConfigurationError(env);
  if (error) throw new Error(error);
  return {
    endpoint: new URL(env.MANIFOLD_OBJECT_STORAGE_ENDPOINT!.trim()),
    region: env.MANIFOLD_OBJECT_STORAGE_REGION!.trim(),
    accessKeyId: env.MANIFOLD_OBJECT_STORAGE_ACCESS_KEY_ID!.trim(),
    secretAccessKey: env.MANIFOLD_OBJECT_STORAGE_SECRET_ACCESS_KEY!.trim(),
    sessionToken: env.MANIFOLD_OBJECT_STORAGE_SESSION_TOKEN?.trim() || undefined,
  };
}

/** Minimal S3-compatible, path-style HTTP adapter. It intentionally only permits immutable PUT + HEAD. */
export class S3ObjectStorageExporter implements ObjectStorageExporter, ResumableMultipartObjectStorageExporter {
  private readonly configError: string | null;
  private readonly config: ObjectStorageConfig | null;

  constructor(private readonly transport: ObjectStorageTransport = { fetch: (request) => fetch(request) }, env: NodeJS.ProcessEnv = process.env, private readonly now: () => Date = () => new Date()) {
    this.configError = objectStorageConfigurationError(env);
    this.config = this.configError ? null : configurationFromEnv(env);
  }

  configured(): boolean { return this.config !== null; }
  configurationError(): string | null { return this.configError; }

  async putImmutable(location: string, key: string, bytes: Buffer, expectedSha256: string, contentType = "application/octet-stream", signal?: AbortSignal): Promise<VerifiedObject> {
    if (!this.config) throw new Error(this.configError ?? "object storage is not configured");
    if (sha256(bytes) !== expectedSha256) throw new Error("refusing object storage export with mismatched payload hash");
    const { bucket, prefix } = parseLocation(location);
    if (!key || key.includes("..") || key.startsWith("/")) throw new Error("unsafe object storage key");
    const objectKey = [prefix, key].filter(Boolean).join("/");
    const url = new URL(this.config.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${awsCanonicalPath(bucket)}/${awsCanonicalPath(objectKey)}`;
    const uri = `s3://${bucket}/${objectKey}`;
    const metadataHash = Buffer.from(expectedSha256, "hex").toString("base64");
    const put = await this.request(url, "PUT", bytes, {
      "content-type": contentType,
      "content-length": String(bytes.length),
      "if-none-match": "*",
      "x-amz-checksum-sha256": metadataHash,
      "x-amz-meta-sha256": expectedSha256,
      "x-amz-meta-byte-count": String(bytes.length),
    }, signal);
    if (!put.ok && put.status !== 412) throw new Error(`object storage immutable PUT failed (${put.status})`);
    return this.verify(url, uri, bytes.length, expectedSha256, signal);
  }

  async reverifyImmutable(uri: string, expectedBytes: number, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedObject> {
    if (!this.config) throw new Error(this.configError ?? "object storage is not configured");
    const source = new URL(uri);
    if (source.protocol !== "s3:" || !source.hostname || source.username || source.password || source.search || source.hash) throw new Error("unsafe durable object storage URI");
    const key = source.pathname.replace(/^\/+/, "");
    if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe durable object storage URI");
    const url = new URL(this.config.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${awsCanonicalPath(source.hostname)}/${awsCanonicalPath(key)}`;
    return this.verify(url, `s3://${source.hostname}/${key}`, expectedBytes, expectedSha256, signal);
  }

  async putImmutableStream(location: string, key: string, chunks: AsyncIterable<Uint8Array>, contentType = "application/octet-stream"): Promise<VerifiedObject> {
    if (!this.config) throw new Error(this.configError ?? "object storage is not configured");
    const { url, uri } = this.objectUrl(location, key);
    // Multipart is deliberately used even for small exports: the caller never has to discover a
    // partition size before it can start exporting it. S3 permits a single final part < 5 MiB.
    const initiateUrl = new URL(url); initiateUrl.search = "?uploads";
    const initiated = await this.request(initiateUrl, "POST", undefined, { "content-type": contentType });
    if (!initiated.ok) throw new Error(`object storage multipart initiate failed (${initiated.status})`);
    const initiateXml = await initiated.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(initiateXml)?.[1];
    if (!uploadId) throw new Error("object storage multipart initiate omitted UploadId");
    const hash = createHash("sha256");
    const parts: { partNumber: number; etag: string }[] = [];
    const minimumPartBytes = 5 * 1024 * 1024;
    let pending = Buffer.alloc(0);
    let partNumber = 1;
    const upload = async (part: Buffer) => {
      const partUrl = new URL(url);
      partUrl.searchParams.set("partNumber", String(partNumber));
      partUrl.searchParams.set("uploadId", uploadId);
      const response = await this.request(partUrl, "PUT", part, { "content-length": String(part.length) });
      if (!response.ok) throw new Error(`object storage multipart part failed (${response.status})`);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error("object storage multipart part omitted ETag");
      parts.push({ partNumber: partNumber++, etag });
    };
    try {
      for await (const chunk of chunks) {
        const value = Buffer.from(chunk);
        hash.update(value);
        pending = pending.length === 0 ? value : Buffer.concat([pending, value]);
        while (pending.length >= minimumPartBytes) {
          const part = pending.subarray(0, minimumPartBytes);
          pending = pending.subarray(minimumPartBytes);
          await upload(part);
        }
      }
      if (pending.length > 0 || parts.length === 0) await upload(pending);
      const completeUrl = new URL(url); completeUrl.searchParams.set("uploadId", uploadId);
      const xml = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const complete = await this.request(completeUrl, "POST", Buffer.from(xml), { "content-type": "application/xml" });
      if (!complete.ok) throw new Error(`object storage multipart complete failed (${complete.status})`);
      const expectedSha256 = hash.digest("hex");
      return this.verify(url, uri, undefined, expectedSha256);
    } catch (error) {
      const abortUrl = new URL(url); abortUrl.searchParams.set("uploadId", uploadId);
      try { await this.request(abortUrl, "DELETE"); } catch { /* preserve the root failure */ }
      throw error;
    }
  }

  async startMultipart(location: string, key: string, contentType = "application/octet-stream", signal?: AbortSignal): Promise<{ uploadId: string; uri: string }> {
    if (!this.config) throw new Error(this.configError ?? "object storage is not configured");
    const { url, uri } = this.objectUrl(location, key);
    const initiateUrl = new URL(url); initiateUrl.search = "?uploads";
    const initiated = await this.request(initiateUrl, "POST", undefined, { "content-type": contentType }, signal);
    if (!initiated.ok) throw new Error(`object storage multipart initiate failed (${initiated.status})`);
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await initiated.text())?.[1];
    if (!uploadId) throw new Error("object storage multipart initiate omitted UploadId");
    return { uploadId, uri };
  }

  async uploadMultipartPart(location: string, key: string, uploadId: string, partNumber: number, bytes: Buffer, signal?: AbortSignal): Promise<MultipartPartProof> {
    const { url } = this.objectUrl(location, key);
    const partUrl = new URL(url); partUrl.searchParams.set("partNumber", String(partNumber)); partUrl.searchParams.set("uploadId", uploadId);
    const response = await this.request(partUrl, "PUT", bytes, { "content-length": String(bytes.length) }, signal);
    if (!response.ok) throw new Error(`object storage multipart part failed (${response.status})`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("object storage multipart part omitted ETag");
    return { partNumber, etag, byteCount: bytes.length, sha256: sha256(bytes) };
  }

  async completeMultipart(location: string, key: string, uploadId: string, parts: readonly MultipartPartProof[], expectedBytes: number, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedObject> {
    const { url, uri } = this.objectUrl(location, key);
    const completeUrl = new URL(url); completeUrl.searchParams.set("uploadId", uploadId);
    const xml = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const complete = await this.request(completeUrl, "POST", Buffer.from(xml), { "content-type": "application/xml" }, signal);
    if (!complete.ok) throw new Error(`object storage multipart complete failed (${complete.status})`);
    return this.verify(url, uri, expectedBytes, expectedSha256);
  }

  private objectUrl(location: string, key: string): { url: URL; uri: string } {
    const { bucket, prefix } = parseLocation(location);
    if (!key || key.includes("..") || key.startsWith("/")) throw new Error("unsafe object storage key");
    const objectKey = [prefix, key].filter(Boolean).join("/");
    const url = new URL(this.config!.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${awsCanonicalPath(bucket)}/${awsCanonicalPath(objectKey)}`;
    return { url, uri: `s3://${bucket}/${objectKey}` };
  }

  private async verify(url: URL, uri: string, expectedBytes: number | undefined, expectedSha256: string, signal?: AbortSignal): Promise<VerifiedObject> {
    const response = await this.request(url, "HEAD", undefined, {}, signal);
    const byteCount = Number(response.headers.get("content-length"));
    const persistedSha = response.headers.get("x-amz-meta-sha256");
    const persistedCount = Number(response.headers.get("x-amz-meta-byte-count"));
    if (!response.ok || !Number.isSafeInteger(byteCount) || (expectedBytes !== undefined && byteCount !== expectedBytes) || (persistedCount && persistedCount !== byteCount) || (persistedSha && persistedSha !== expectedSha256)) {
      throw new Error("object storage export verification failed");
    }
    // Metadata is user supplied. Read the immutable object back and hash the actual persisted
    // bytes; this is required for a 412 retry, where this worker did not perform the PUT.
    const body = await this.request(url, "GET", undefined, {}, signal);
    if (!body.ok) throw new Error("object storage export GET verification failed");
    const hash = createHash("sha256"); let received = 0;
    if (!body.body) throw new Error("object storage export GET verification body missing");
    const reader = body.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      received += bytes.length;
      hash.update(bytes);
    }
    if (received !== byteCount || hash.digest("hex") !== expectedSha256) throw new Error("object storage export content hash verification failed");
    return { uri, byteCount, sha256: expectedSha256 };
  }

  private async request(url: URL, method: "PUT" | "POST" | "HEAD" | "GET" | "DELETE", body?: Buffer, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const config = this.config!;
    const timestamp = this.now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = timestamp.slice(0, 8);
    const payloadHash = sha256(body ?? Buffer.alloc(0));
    const headers = new Headers(extraHeaders);
    headers.set("host", url.host);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", timestamp);
    if (config.sessionToken) headers.set("x-amz-security-token", config.sessionToken);
    const signedHeaders = [...headers.keys()].sort();
    const canonicalHeaders = signedHeaders.map((name) => `${name}:${headers.get(name)!.trim().replace(/\s+/g, " ")}\n`).join("");
    const canonicalRequest = [method, awsCanonicalPath(decodeURIComponent(url.pathname)), awsCanonicalQuery(url.search), canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, date), config.region), "s3"), "aws4_request");
    headers.set("authorization", `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${hmac(signingKey, stringToSign).toString("hex")}`);
    return this.transport.fetch(new Request(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal }));
  }
}

export function isValidObjectStorageLocation(value: string | null | undefined): boolean {
  if (!value) return false;
  try { parseLocation(value); return true; } catch { return false; }
}
