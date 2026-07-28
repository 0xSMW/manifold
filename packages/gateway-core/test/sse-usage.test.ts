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
    terminalKind: "completed",
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

test("recognizes a split Responses response.completed event at EOF", async () => {
  const observer = createSseUsageTransform();
  const chunks = [
    "event: response.com",
    "pleted\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":7,",
    "\"output_tokens\":11}}}\n\n",
  ];
  assert.equal(await relay(observer, chunks), chunks.join(""));
  assert.deepEqual(await observer.result, {
    usage: { input_tokens: 7, output_tokens: 11 },
    completed: true,
    terminalKind: "completed",
    aborted: false,
    malformedFrames: 0,
    oversizedFrames: 0,
  });
});

test("recognizes a data-only Responses response.completed frame", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, ["data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4}}}\n\n"]);
  const result = await observer.result;
  assert.equal(result.completed, true);
  assert.equal(result.terminalKind, "completed");
});

test("retains an explicit response.completed event when its data is oversized", async () => {
  const observer = createSseUsageTransform({ maxFrameBytes: 32 });
  await relay(observer, ["event: response.completed\ndata: ", "x".repeat(100), "\n\n"]);
  const result = await observer.result;
  assert.equal(result.completed, true);
  assert.equal(result.terminalKind, "completed");
  assert.equal(result.oversizedFrames, 1);
});

test("requires a data field before trusting a Responses event terminal type", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, ["event: response.completed\n\n"]);
  assert.deepEqual(await observer.result, {
    usage: null,
    completed: false,
    terminalKind: null,
    aborted: false,
    malformedFrames: 1,
    oversizedFrames: 0,
  });
});

test("rejects a Responses event/data terminal type disagreement", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, [
    'event: response.failed\ndata: {"type":"response.completed"}\n\n',
  ]);
  const result = await observer.result;
  assert.equal(result.terminalKind, null);
  assert.equal(result.completed, false);
  assert.equal(result.malformedFrames, 1);
});

test("keeps the first valid terminal outcome sticky", async () => {
  const observer = createSseUsageTransform();
  const writer = observer.stream.writable.getWriter();
  const reader = observer.stream.readable.getReader();
  const drain = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
    }
  })();
  await writer.write(encoder.encode('data: {"type":"response.failed"}\n\n'));
  await writer.write(encoder.encode('data: {"type":"response.completed"}\n\n'));
  await writer.close();
  await drain;
  const result = await observer.result;
  assert.equal(result.terminalKind, "failed");
  assert.equal(result.completed, false);
});

test("retains legacy split [DONE] completion handling", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, ["data: [DO", "NE]\n\n"]);
  assert.equal((await observer.result).completed, true);
});

test("does not treat failed or incomplete Responses events as completed", async () => {
  for (const eventType of ["response.failed", "response.incomplete"]) {
    for (const frame of [
      `event: ${eventType}\ndata: {\"type\":\"${eventType}\"}\n\n`,
      `data: {\"type\":\"${eventType}\"}\n\n`,
    ]) {
      const observer = createSseUsageTransform();
      await relay(observer, [frame]);
      const result = await observer.result;
      assert.equal(result.completed, false, eventType);
      assert.equal(result.terminalKind, eventType.slice("response.".length), eventType);
    }
  }
});

test("does not treat a partial response.completed data line at EOF as completion", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, ["event: response.completed\ndata: {\"type\":\"response.completed\""]);
  assert.equal((await observer.result).completed, false);
});

test("does not treat a truncated event-only response.completed EOF as completion", async () => {
  const observer = createSseUsageTransform();
  await relay(observer, ["event: response.completed\n"]);
  const result = await observer.result;
  assert.equal(result.completed, false);
  assert.equal(result.terminalKind, null);
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
