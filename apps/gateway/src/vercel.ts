// Vercel's Web Request/Response wiring. gateway-core remains platform-free.
import { handleRequest, type GatewayContext } from "@manifold/gateway-core";
import { getVercelGatewayContext } from "./vercelRuntime.js";

/** Query key reserved for the Vercel rewrite; never forwarded to provider routes. */
export const ORIGINAL_PATH_QUERY_PARAM = "__manifold_original_path";

export type GatewayContextProvider = () => Promise<GatewayContext>;
export type WaitUntilRegistrar = (work: Promise<unknown>) => void;

/**
 * Cache one successfully-built context per function instance. A failed initialization is retried on
 * the next request, which avoids pinning a transient startup failure for the instance lifetime.
 */
export function createCachedContextProvider(provider: GatewayContextProvider): GatewayContextProvider {
  let context: Promise<GatewayContext> | undefined;
  return () => {
    if (!context) {
      context = provider().catch((error: unknown) => {
        context = undefined;
        throw error;
      });
    }
    return context;
  };
}

/**
 * Replace the internal rewrite path with its original `/v1` path and remove only the reserved
 * routing key. `URLSearchParams` preserves every user query parameter, including repeated keys.
 */
export function reconstructGatewayRequest(request: Request): Request {
  const url = new URL(request.url);
  const originalPath = url.searchParams.get(ORIGINAL_PATH_QUERY_PARAM);
  url.searchParams.delete(ORIGINAL_PATH_QUERY_PARAM);
  if (originalPath === "/v1" || originalPath?.startsWith("/v1/")) url.pathname = originalPath;
  return new Request(url, request);
}

/** Static envelope only: unexpected adapter failures must not expose runtime internals. */
export function genericErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "internal error", type: "api_error", param: null, code: "INTERNAL" },
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

function contextWithWaitUntil(ctx: GatewayContext, waitUntil: WaitUntilRegistrar): GatewayContext {
  return {
    ...ctx,
    ingest: {
      emit(event) {
        const work = ctx.ingest.emit(event);
        // Registration is best-effort plumbing only. It does not make the backing ingest durable.
        try {
          waitUntil(work.catch(() => {}));
        } catch {
          // A platform registration failure must not turn a gateway response into an internal error.
        }
        return work;
      },
    },
  };
}

export interface VercelGatewayHandlerOptions {
  contextProvider?: GatewayContextProvider;
  waitUntil?: WaitUntilRegistrar;
}

/** Factory exposes platform seams for focused tests without importing `@vercel/functions`. */
export function createVercelGatewayHandler(
  options: VercelGatewayHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const waitUntil = options.waitUntil ?? (() => {});
  const getContext =
    options.contextProvider ?? (() => getVercelGatewayContext(waitUntil));
  return async (request: Request): Promise<Response> => {
    try {
      const ctx = contextWithWaitUntil(await getContext(), waitUntil);
      return await handleRequest(ctx, reconstructGatewayRequest(request));
    } catch {
      return genericErrorResponse();
    }
  };
}
