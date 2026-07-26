// DNS-pinned provider egress for the Vercel gateway.  Resolution and connection are
// deliberately coupled: a hostname is resolved once, every answer is vetted, then the
// Undici connector is forced to the selected answer while retaining the URL hostname
// for Host and TLS SNI.
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, Pool, buildConnector, fetch as undiciFetch } from "undici";
import type { Fetcher } from "@manifold/ports";
import { isPrivateIp, schemeAllowed, type SsrfPolicy, STRICT_SSRF } from "@manifold/gateway-core";

const MAX_REDIRECTS = 10;

export type PinnedHostResolver = (host: string) => Promise<{ address: string }[]>;

interface PinnedDestination {
  address: string;
  hostname: string;
}

/**
 * A Fetcher that prevents the resolve/connect DNS-rebinding gap.  An Agent is
 * intentionally created per upstream request and closed when its returned body
 * is consumed or cancelled, avoiding Fluid-instance connection accumulation.
 */
export class PinnedEgressFetcher implements Fetcher {
  private readonly policy: SsrfPolicy;
  private readonly resolve: PinnedHostResolver;

  constructor(policy: SsrfPolicy = STRICT_SSRF, resolve?: PinnedHostResolver) {
    this.policy = policy;
    this.resolve = resolve ?? ((host) => lookup(host, { all: true }));
  }

  private async resolveDestination(url: URL): Promise<PinnedDestination> {
    const scheme = schemeAllowed(url, this.policy);
    if (!scheme.ok) {
      // `SsrfResult` comes from a separately-built workspace declaration; use an
      // explicit shape check so this remains sound across TypeScript's union
      // narrowing settings in consumers of that declaration.
      throw new Error(`egress: ${"reason" in scheme ? scheme.reason : "scheme rejected"}`);
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const answers = isIP(hostname) ? [{ address: hostname }] : await this.resolve(hostname);
    if (answers.length === 0) throw new Error(`egress: DNS returned no addresses for ${hostname}`);

    // Any private answer blocks the whole hostname.  Selecting only a public A
    // record would leave a dual-stack / Happy Eyeballs route to a private AAAA.
    for (const { address } of answers) {
      if (!isIP(address)) {
        throw new Error(`egress: DNS returned non-IP answer for ${hostname}`);
      }
      if (!this.policy.allowPrivate) {
        if (isPrivateIp(address)) {
          throw new Error(`egress: blocked private address ${address} (resolved from ${hostname})`);
        }
      }
    }

    return { address: answers[0]!.address, hostname };
  }

  private agentFor(destination: PinnedDestination): Agent {
    const connector = buildConnector({});
    const pinnedConnector: typeof connector = (options, callback) => {
      // `hostname`/`host` choose the TCP peer. `servername` stays the original
      // URL hostname, so HTTPS certificate validation and SNI retain their normal
      // semantics instead of silently becoming an IP-address TLS connection.
      connector(
        {
          ...options,
          hostname: destination.address,
          host: destination.address,
          servername: options.servername ?? destination.hostname,
        },
        callback,
      );
    };

    return new Agent({
      factory: (origin, options) =>
        new Pool(origin, {
          ...(options as Pool.Options),
          connections: 1,
          pipelining: 0,
          connect: pinnedConnector,
        }),
    });
  }

  private closeAfterBody(response: Response, agent: Agent): Response {
    const close = () => agent.close().catch(() => undefined);
    // Undici's Fetch implementation transparently decodes gzip, deflate, and
    // brotli response bodies, while preserving the upstream wire headers. A
    // returned Web Response therefore must not advertise the pre-decompression
    // representation: downstream Fetch clients would attempt to decode it again.
    const headers = new Headers(response.headers);
    const encodings = (headers.get("content-encoding") ?? "")
      .split(",")
      .map((encoding) => encoding.trim().toLowerCase())
      .filter(Boolean);
    const decodedEncodings = new Set(["gzip", "x-gzip", "deflate", "br"]);
    if (
      encodings.some((encoding) => decodedEncodings.has(encoding)) &&
      encodings.every((encoding) => decodedEncodings.has(encoding) || encoding === "identity")
    ) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    if (!response.body) {
      void close();
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            void close();
            return;
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          void close();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          void close();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private static redirectRequest(current: Request, next: URL, status: number): Request {
    // Fetch converts POST to GET for historical 301/302 and mandatory 303 redirects.
    if (status === 303 || ((status === 301 || status === 302) && current.method === "POST")) {
      const headers = new Headers(current.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      return new Request(next, { method: "GET", headers, redirect: "manual" });
    }
    // A streamed body is one-shot. Never buffer a provider request solely to make a
    // redirect replayable; that can turn a bounded egress path into unbounded memory.
    if (current.body) throw new Error("egress: cannot replay streamed request body after redirect");
    return new Request(next, current);
  }

  async fetch(req: Request): Promise<Response> {
    const origin = new URL(req.url);
    const originHost = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
    let current = req;

    for (let hop = 0; ; hop += 1) {
      const url = new URL(current.url);
      const destination = await this.resolveDestination(url);
      const agent = this.agentFor(destination);
      let response: Response;
      try {
        // Undici ships its own Request class. Passing Node's global Request as
        // the first argument makes it stringify to "[object Request]" under
        // Undici 7, so bridge the Web request explicitly and retain its stream.
        response = (await undiciFetch(current.url, {
          method: current.method,
          headers: Array.from(current.headers.entries()),
          body: current.method === "GET" || current.method === "HEAD" ? undefined : current.body,
          signal: current.signal,
          dispatcher: agent,
          redirect: "manual",
          duplex: "half",
        })) as unknown as Response;
      } catch (error) {
        await agent.close().catch(() => undefined);
        throw error;
      }

      if (response.status < 300 || response.status >= 400 || !response.headers.get("location")) {
        return this.closeAfterBody(response, agent);
      }

      const location = response.headers.get("location")!;
      const next = new URL(location, current.url);
      const nextHost = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const nextPort = next.port || (next.protocol === "https:" ? "443" : "80");
      // The target allowlist applies only to the originally configured origin. A
      // redirect is allowed solely within that same authority and may not downgrade TLS.
      if (nextHost !== originHost || nextPort !== originPort) {
        await response.body?.cancel().catch(() => undefined);
        await agent.close().catch(() => undefined);
        throw new Error(`egress: refused cross-host redirect ${originHost}:${originPort} -> ${nextHost}:${nextPort}`);
      }
      if (origin.protocol === "https:" && next.protocol !== "https:") {
        await response.body?.cancel().catch(() => undefined);
        await agent.close().catch(() => undefined);
        throw new Error(`egress: refused scheme downgrade on redirect ${origin.protocol} -> ${next.protocol}`);
      }
      if (hop >= MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        await agent.close().catch(() => undefined);
        throw new Error("egress: too many redirects");
      }

      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);
      current = PinnedEgressFetcher.redirectRequest(current, next, response.status);
    }
  }
}
