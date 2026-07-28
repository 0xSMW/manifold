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

/**
 * Vercel otherwise applies its cache policy to responses that omit one. Keep
 * the gateway-core response stream and every other response detail intact,
 * while making public data-plane responses explicitly non-cacheable.
 */
export function nonCacheableGatewayResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
      return nonCacheableGatewayResponse(await handleRequest(ctx, reconstructGatewayRequest(request)));
    } catch {
      return genericErrorResponse();
    }
  };
}
