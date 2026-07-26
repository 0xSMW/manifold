/**
 * A byte-transparent SSE observer for OpenAI-compatible streaming responses.
 *
 * The writable side may be fed provider bytes while the readable side is sent
 * directly to the client. Parsing is intentionally best-effort: malformed or
 * overlarge events are discarded from observation only and can never alter the
 * relayed byte stream.
 */

export interface OpenAiStreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  details?: Record<string, unknown>;
}

export interface SseUsageResult {
  /** The latest valid `usage` object observed in an SSE data frame. */
  usage: OpenAiStreamUsage | null;
  /** True only when the provider emitted the OpenAI SSE completion sentinel. */
  completed: boolean;
  /** True when the supplied abort signal or `abort()` stopped observation. */
  aborted: boolean;
  malformedFrames: number;
  oversizedFrames: number;
}

export interface SseUsageTransformOptions {
  /** Maximum bytes retained for one SSE event. Defaults to 64 KiB. */
  maxFrameBytes?: number;
  signal?: AbortSignal;
  /**
   * Runs exactly once before a chunk containing `[DONE]` is released, or before
   * EOF closes an incomplete stream. Rejecting fails the stream closed.
   */
  onFinalize?: (result: SseUsageResult) => void | Promise<void>;
}

export interface SseUsageTransform {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: Promise<SseUsageResult>;
  /** Settles result as aborted when the caller cancels the surrounding stream. */
  abort(): void;
}

const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function appendBounded(
  current: Uint8Array<ArrayBufferLike>,
  next: Uint8Array<ArrayBufferLike>,
  limit: number,
): Uint8Array<ArrayBufferLike> | null {
  if (next.byteLength > limit - current.byteLength) return null;
  const joined = new Uint8Array(current.byteLength + next.byteLength);
  joined.set(current);
  joined.set(next, current.byteLength);
  return joined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractUsage(value: unknown): OpenAiStreamUsage | null {
  const event = record(value);
  const usage = record(event?.usage) ?? record(record(event?.response)?.usage);
  if (!usage) return null;

  const details = record(usage.details)
    ?? record(usage.prompt_tokens_details)
    ?? record(usage.completion_tokens_details)
    ?? record(usage.input_tokens_details)
    ?? record(usage.output_tokens_details);
  const promptTokens = numeric(usage.prompt_tokens);
  const completionTokens = numeric(usage.completion_tokens);
  const inputTokens = numeric(usage.input_tokens);
  const outputTokens = numeric(usage.output_tokens);
  const extracted: OpenAiStreamUsage = {
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined ? { completion_tokens: completionTokens } : {}),
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(details ? { details } : {}),
  };
  return Object.keys(extracted).length > 0 ? extracted : null;
}

/**
 * Creates a Web Streams transform that observes OpenAI-compatible SSE usage.
 * Callers should invoke `abort()` when they cancel a pipe without supplying an
 * AbortSignal, since TransformStream has no readable-cancel callback.
 */
export function createSseUsageTransform(options: SseUsageTransformOptions = {}): SseUsageTransform {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError("maxFrameBytes must be a positive safe integer");
  }

  let line: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let droppingLine = false;
  let frameDiscarded = false;
  let dataParts: string[] = [];
  let dataBytes = 0;
  let usage: OpenAiStreamUsage | null = null;
  let completed = false;
  let malformedFrames = 0;
  let oversizedFrames = 0;
  let settled = false;
  let resolveResult!: (value: SseUsageResult) => void;
  let rejectResult!: (reason?: unknown) => void;
  let finalizePromise: Promise<void> | undefined;

  const result = new Promise<SseUsageResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const settle = (aborted: boolean): Promise<void> => {
    if (finalizePromise) return finalizePromise;
    const snapshot = { usage, completed, aborted, malformedFrames, oversizedFrames };
    finalizePromise = Promise.resolve()
      .then(() => options.onFinalize?.(snapshot))
      .then(
        () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          resolveResult(snapshot);
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            rejectResult(error);
          }
          throw error;
        },
      );
    return finalizePromise;
  };
  const onAbort = (): void => {
    void settle(true).catch(() => {});
  };

  if (options.signal?.aborted) {
    queueMicrotask(onAbort);
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  const finishFrame = (): void => {
    if (!frameDiscarded && dataParts.length > 0) {
      const payload = dataParts.join("\n");
      if (payload === "[DONE]") {
        completed = true;
      } else {
        try {
          const observed = extractUsage(JSON.parse(payload));
          if (observed) usage = observed;
        } catch {
          malformedFrames += 1;
        }
      }
    }
    frameDiscarded = false;
    dataParts = [];
    dataBytes = 0;
  };

  const finishLine = (): void => {
    if (droppingLine) {
      droppingLine = false;
      line = new Uint8Array();
      return;
    }
    let text = decoder.decode(line);
    line = new Uint8Array();
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.length === 0) {
      finishFrame();
      return;
    }
    if (!text.startsWith("data:")) return;
    const payload = text.slice(5).replace(/^ /, "");
    const payloadBytes = encoder.encode(payload).byteLength;
    const separatorBytes = dataParts.length === 0 ? 0 : 1;
    if (payloadBytes > maxFrameBytes - dataBytes - separatorBytes) {
      if (!frameDiscarded) oversizedFrames += 1;
      frameDiscarded = true;
      dataParts = [];
      dataBytes = 0;
      return;
    }
    dataParts.push(payload);
    dataBytes += separatorBytes + payloadBytes;
  };

  const consume = (chunk: Uint8Array): void => {
    if (settled) return;
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      if (!droppingLine) {
        const next = appendBounded(line, chunk.subarray(start, index), maxFrameBytes);
        if (next === null) {
          oversizedFrames += 1;
          frameDiscarded = true;
          line = new Uint8Array();
        } else {
          line = next;
        }
      }
      finishLine();
      start = index + 1;
    }
    if (start >= chunk.byteLength || droppingLine) return;
    const next = appendBounded(line, chunk.subarray(start), maxFrameBytes);
    if (next === null) {
      oversizedFrames += 1;
      frameDiscarded = true;
      line = new Uint8Array();
      droppingLine = true;
    } else {
      line = next;
    }
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      consume(chunk);
      // Hold the chunk carrying the completion sentinel until durable terminal
      // accounting succeeds. Earlier stream bytes remain fully streaming.
      if (completed) await settle(false);
      controller.enqueue(chunk);
    },
    async flush() {
      // A complete SSE event needs its blank line; silently ignore a partial
      // trailing line rather than mistaking a truncation for a final frame.
      await settle(false);
    },
  });

  return { stream, result, abort: onAbort };
}
