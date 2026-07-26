import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runLoad } from "../scripts/load-smoke.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("load smoke caps concurrent requests", async () => {
  let active = 0;
  let maximum = 0;
  await withServer(async (_request, response) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    response.end("ok");
  }, async (url) => {
    const summary = await runLoad({ url, concurrency: 3, requests: 12, expectedStatuses: [200] });
    assert.equal(summary.ok, true);
    assert.equal(summary.completed, 12);
  });
  assert.ok(maximum <= 3);
  assert.ok(maximum >= 2);
});

test("load smoke accepts configured statuses and fails unexpected responses", async () => {
  await withServer((_request, response) => {
    response.statusCode = 503;
    response.end("not ready");
  }, async (url) => {
    const accepted = await runLoad({ url, requests: 2, expectedStatuses: [200, 503] });
    assert.equal(accepted.ok, true);
    const rejected = await runLoad({ url, requests: 2, expectedStatuses: [200] });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.unexpectedStatuses, 2);
  });
});

test("load smoke accounts timeouts as errors without leaking request secrets", async () => {
  await withServer(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    response.end("late-response-body-secret");
  }, async (url) => {
    const secret = "vk-secret-never-in-artifact";
    const body = '{"secret":"body-secret-never-in-artifact"}';
    const summary = await runLoad({ url: `${url}/?token=url-secret-never-in-artifact`, body, virtualKey: secret, requests: 1, timeoutMs: 10, expectedStatuses: [200] });
    const artifact = JSON.stringify(summary);
    assert.equal(summary.ok, false);
    assert.equal(summary.errorCounts.timeout, 1);
    assert.ok(!artifact.includes(secret));
    assert.ok(!artifact.includes("body-secret-never-in-artifact"));
    assert.ok(!artifact.includes("url-secret-never-in-artifact"));
  });
});

test("load smoke sends Vercel Preview bypass header without emitting its secret", async () => {
  const bypassSecret = "vercel-bypass-secret-never-in-artifact";
  let receivedBypass;
  await withServer((request, response) => {
    receivedBypass = request.headers["x-vercel-protection-bypass"];
    response.end("ok");
  }, async (url) => {
    const summary = await runLoad({ url, requests: 1, expectedStatuses: [200], vercelBypassSecret: bypassSecret });
    assert.equal(summary.ok, true);
    assert.equal(receivedBypass, bypassSecret);
    assert.ok(!JSON.stringify(summary).includes(bypassSecret));
  });
});
