/**
 * Liveness is deliberately dependency-free: a healthy response only means this
 * function isolate can accept requests. Readiness lives in ready.ts.
 */
export function createHealthHandler(): (request: Request) => Promise<Response> {
  return async (_request: Request): Promise<Response> =>
    Response.json(
      { ok: true },
      {
        status: 200,
        headers: { "cache-control": "no-store" },
      },
    );
}

export const GET = createHealthHandler();
