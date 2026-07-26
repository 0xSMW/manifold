import assert from "node:assert/strict";
import { test } from "node:test";
import { createSseUsageTransform } from "../src/sseUsage.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function relay(observer: ReturnType<typeof createSseUsageTransform>, chunks: string[]): Promise<string> {
  const writer = observer.stream.writable.getWriter();
  const reader = observer.stream.readable.getReader();
  const output: Uint8Array[] = [];
  const reading = (async () => {
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      output.push(item.value);
    }
  })();
  for (const chunk of chunks) await writer.write(encoder.encode(chunk));
  await writer.close();
  await reading;
  return decoder.decode(Uint8Array.from(output.flatMap((chunk) => [...chunk])));
}

test("relays split chunks byte-for-byte and captures the final chat usage", async () => {
  const observer = createSseUsageTransform();
  const chunks = [
    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
    "data: {\"usage\":{\"prompt_",
    "tokens\":3,\"completion_tokens\":5,\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\n",
    "data: [DONE]\n\n",
  ];
  const output = await relay(observer, chunks);
  assert.equal(output, chunks.join(""));
  assert.deepEqual(await observer.result, {
    usage: { prompt_tokens: 3, completion_tokens: 5, details: { reasoning_tokens: 2 } },
    completed: true,
    aborted: false,
    malformedFrames: 0,
    oversizedFrames: 0,
  });
});

test("ignores malformed frames and retains later Responses API usage", async () => {
  const observer = createSseUsageTransform();
  const output = await relay(observer, [
    "data: {not-json}\n\n",
    "data: {\"response\":{\"usage\":{\"input_tokens\":7,\"output_tokens\":11,\"details\":{\"cached_tokens\":2}}}}\n\n",
    "data: [DONE]\n\n",
  ]);
  assert.match(output, /not-json/);
  const result = await observer.result;
  assert.equal(result.malformedFrames, 1);
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 11, details: { cached_tokens: 2 } });
  assert.equal(result.completed, true);
});

test("discards oversized observation frames without changing relay output", async () => {
  const observer = createSseUsageTransform({ maxFrameBytes: 16 });
  const chunks = ["data: ", "x".repeat(100), "\n\n", "data: [DONE]\n\n"];
  assert.equal(await relay(observer, chunks), chunks.join(""));
  const result = await observer.result;
  assert.equal(result.oversizedFrames, 1);
  assert.equal(result.completed, true);
  assert.equal(result.usage, null);
});

test("settles as aborted when the supplied signal aborts observation", async () => {
  const controller = new AbortController();
  const observer = createSseUsageTransform({ signal: controller.signal });
  const writer = observer.stream.writable.getWriter();
  const reader = observer.stream.readable.getReader();
  const pendingRead = reader.read();
  await writer.write(encoder.encode("data: {\"usage\":{\"input_tokens\":1}}\n\n"));
  await pendingRead;
  controller.abort();
  const result = await observer.result;
  assert.equal(result.aborted, true);
  assert.deepEqual(result.usage, { input_tokens: 1 });
  await writer.close();
  await reader.cancel();
});

test("withholds the completion chunk until the durable finalize hook succeeds", async () => {
  const gate = deferred();
  const finalized: Array<{ completed: boolean; inputTokens?: number }> = [];
  const observer = createSseUsageTransform({
    onFinalize: async (result) => {
      finalized.push({
        completed: result.completed,
        inputTokens: result.usage?.input_tokens,
      });
      await gate.promise;
    },
  });
  const writer = observer.stream.writable.getWriter();
  const reader = observer.stream.readable.getReader();
  const firstRead = reader.read();
  await writer.write(encoder.encode("data: {\"usage\":{\"input_tokens\":3}}\n\n"));
  assert.equal(decoder.decode((await firstRead).value), "data: {\"usage\":{\"input_tokens\":3}}\n\n");

  let completionWriteSettled = false;
  const completionWrite = writer.write(encoder.encode("data: [DONE]\n\n")).then(() => {
    completionWriteSettled = true;
  });
  const completionRead = reader.read();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completionWriteSettled, false);
  assert.deepEqual(finalized, [{ completed: true, inputTokens: 3 }]);

  gate.resolve();
  await completionWrite;
  assert.equal(decoder.decode((await completionRead).value), "data: [DONE]\n\n");
  await writer.close();
  assert.equal((await observer.result).completed, true);
  await reader.cancel();
});

test("runs the finalize hook for an incomplete EOF before the readable closes", async () => {
  let finalized = false;
  const observer = createSseUsageTransform({
    onFinalize: (result) => {
      assert.equal(result.completed, false);
      finalized = true;
    },
  });
  assert.equal(await relay(observer, ["data: {\"delta\":\"partial\"}\n\n"]), "data: {\"delta\":\"partial\"}\n\n");
  assert.equal(finalized, true);
  assert.equal((await observer.result).completed, false);
});
