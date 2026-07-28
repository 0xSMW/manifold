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

export type SseTerminalKind = "completed" | "failed" | "incomplete";

export interface SseUsageResult {
  /** The latest valid `usage` object observed in an SSE data frame. */
  usage: OpenAiStreamUsage | null;
  /** True only when the provider emitted an explicit successful SSE terminal event. */
  completed: boolean;
  /** The Responses terminal outcome, when a complete SSE frame supplied one. */
  terminalKind: SseTerminalKind | null;
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
   * Runs exactly once before a chunk containing a terminal event is released,
   * or before EOF closes an incomplete stream. Rejecting fails the stream closed.
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

function startsWithDataField(
  prefix: Uint8Array<ArrayBufferLike>,
  suffix: Uint8Array<ArrayBufferLike>,
): boolean {
  const expected = [0x64, 0x61, 0x74, 0x61, 0x3a]; // "data:"
  if (prefix.byteLength + suffix.byteLength < expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const value = index < prefix.byteLength ? prefix[index] : suffix[index - prefix.byteLength];
    if (value !== expected[index]) return false;
  }
  return true;
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

function responsesTerminalKind(value: unknown): SseTerminalKind | null {
  switch (record(value)?.type) {
    case "response.completed": return "completed";
    case "response.failed": return "failed";
    case "response.incomplete": return "incomplete";
    default: return null;
  }
}

function eventTerminalKind(eventType: string): SseTerminalKind | null {
  switch (eventType) {
    case "response.completed": return "completed";
    case "response.failed": return "failed";
    case "response.incomplete": return "incomplete";
    default: return null;
  }
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
  let frameHasData = false;
  let eventType = "";
  let usage: OpenAiStreamUsage | null = null;
  let completed = false;
  let terminalKind: SseTerminalKind | null = null;
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
    const snapshot = { usage, completed, terminalKind, aborted, malformedFrames, oversizedFrames };
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
    let frameTerminalKind: SseTerminalKind | null = null;
    if (!frameDiscarded && dataParts.length > 0) {
      const payload = dataParts.join("\n");
      if (payload === "[DONE]") {
        frameTerminalKind = "completed";
      } else {
        try {
          const parsed = JSON.parse(payload);
          const observed = extractUsage(parsed);
          if (observed) usage = observed;
          frameTerminalKind = responsesTerminalKind(parsed);
        } catch {
          malformedFrames += 1;
        }
      }
    }
    const declaredTerminalKind = eventTerminalKind(eventType);
    let validTerminalKind: SseTerminalKind | null = null;
    if (declaredTerminalKind !== null) {
      // `event:` alone is metadata, never a terminal observation. We can
      // trust the declared type when a data field exists but is too large to
      // inspect; when it is inspectable, its terminal type must agree.
      if (!frameHasData) {
        malformedFrames += 1;
      } else if (frameTerminalKind !== null && frameTerminalKind !== declaredTerminalKind) {
        malformedFrames += 1;
      } else {
        validTerminalKind = declaredTerminalKind;
      }
    } else {
      validTerminalKind = frameTerminalKind;
    }
    // Keep the first valid terminal immutable. This also prevents a malformed
    // provider sequence from changing already-accounted terminal semantics.
    if (terminalKind === null && validTerminalKind !== null) {
      terminalKind = validTerminalKind;
      completed = terminalKind === "completed";
    }
    frameDiscarded = false;
    dataParts = [];
    dataBytes = 0;
    frameHasData = false;
    eventType = "";
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
    const separator = text.indexOf(":");
    const field = separator === -1 ? text : text.slice(0, separator);
    if (field === "") return; // SSE comment.
    const value = separator === -1 ? "" : text.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      eventType = value;
      return;
    }
    if (field !== "data") return;
    frameHasData = true;
    const payload = value;
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
          if (startsWithDataField(line, chunk.subarray(start, index))) frameHasData = true;
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
      if (startsWithDataField(line, chunk.subarray(start))) frameHasData = true;
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
      if (terminalKind !== null) await settle(false);
      controller.enqueue(chunk);
    },
    async flush() {
      // SSE dispatch requires a blank-line terminator. A truncated final frame
      // cannot become a terminal result merely because EOF followed a newline.
      await settle(false);
    },
  });

  return { stream, result, abort: onAbort };
}
