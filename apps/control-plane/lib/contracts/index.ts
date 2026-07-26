import type { z } from "zod";
import { jsonBody, ManifoldError, ok } from "@/lib/http";

/** Parse an object request through its strict wire schema. */
export function contractValue<T extends z.ZodTypeAny>(value: unknown, schema: T): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message: "request body does not match the API contract",
    reasonCodes: [],
    details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
  });
}

export async function contractBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  return contractValue(await jsonBody(req), schema);
}

/** Accept an absent body for bodyless mutations, while still rejecting any supplied unknown key. */
export async function contractOptionalEmptyBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const raw = await req.text();
  if (raw.trim() === "") {
    const empty = schema.safeParse({});
    if (empty.success) return empty.data;
    throw new ManifoldError({ status: 422, code: "VALIDATION", message: "request body does not match the API contract", reasonCodes: [] });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    throw new ManifoldError({ status: 422, code: "VALIDATION", message: "request body must be valid JSON", reasonCodes: [] });
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ManifoldError({ status: 422, code: "VALIDATION", message: "request body does not match the API contract", reasonCodes: [], details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } });
}

/** Parse a URL query through its strict wire schema. Repeated keys are rejected. */
export function contractQuery<T extends z.ZodTypeAny>(params: URLSearchParams, schema: T): z.infer<T> {
  const raw: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in raw) {
      throw new ManifoldError({
        status: 422, code: "VALIDATION", message: "query does not match the API contract", reasonCodes: [],
        details: { issues: [{ path: key, message: "query parameters must not be repeated" }] },
      });
    }
    raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ManifoldError({
    status: 422, code: "VALIDATION", message: "query does not match the API contract", reasonCodes: [],
    details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
  });
}

/** Validate a success body before it crosses the HTTP boundary. */
export function contractOk<T extends z.ZodTypeAny>(schema: T, body: unknown, requestId: string, status = 200): ReturnType<typeof ok> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return ok(parsed.data, requestId, status);
  throw new ManifoldError({
    status: 500,
    code: "INTERNAL",
    message: "internal error",
    reasonCodes: [],
    details: { contractIssues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
  });
}
