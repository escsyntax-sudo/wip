import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import {
  eventBodyBuffer,
  filterHeaders,
  replayEvent,
  replayPayload,
} from "../src/replay.js";

let upstream;
let baseUrl;
let lastRequest;

before(async () => {
  upstream = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      lastRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      if (request.url === "/slow") {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("late");
        }, 300);
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      }
      if (request.url === "/teapot") {
        response.writeHead(418, { "content-type": "application/json" });
        response.end('{"error":"teapot"}');
        return;
      }
      response.writeHead(202, {
        "content-type": "application/json",
        "x-upstream": "yes",
      });
      response.end(JSON.stringify({ received: body.toString("utf8") }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${upstream.address().port}`;
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

test("filterHeaders removes hop by hop and websocket headers", () => {
  const filtered = filterHeaders({
    Host: "localhost:4242",
    "Content-Length": "12",
    Connection: "keep-alive",
    "Transfer-Encoding": "chunked",
    "Sec-WebSocket-Key": "abc",
    "Content-Type": "application/json",
    "X-Signature": "sha256=abc",
  });
  assert.deepEqual(filtered, {
    "Content-Type": "application/json",
    "X-Signature": "sha256=abc",
  });
});

test("eventBodyBuffer handles utf8, base64 and empty bodies", () => {
  assert.equal(eventBodyBuffer({ body: "hello", encoding: "utf8" }).toString(), "hello");
  const bytes = Buffer.from([0, 1, 2, 255]);
  assert.deepEqual(
    eventBodyBuffer({ body: bytes.toString("base64"), encoding: "base64" }),
    bytes,
  );
  assert.equal(eventBodyBuffer({ body: "", encoding: "utf8" }), undefined);
  assert.equal(eventBodyBuffer(null), undefined);
});

test("replayEvent forwards the method, headers and body", async () => {
  const result = await replayEvent(
    {
      method: "POST",
      headers: {
        host: "localhost:4242",
        "content-type": "application/json",
        "x-signature": "abc",
        "content-length": "999",
      },
      body: '{"event":"invoice.paid"}',
      encoding: "utf8",
    },
    { target: `${baseUrl}/hook` },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.error, null);
  assert.equal(result.headers["x-upstream"], "yes");
  assert.match(result.bodyPreview, /received/);
  assert.equal(lastRequest.method, "POST");
  assert.equal(lastRequest.url, "/hook");
  assert.equal(lastRequest.headers["x-signature"], "abc");
  assert.equal(lastRequest.headers["content-type"], "application/json");
  assert.equal(lastRequest.body.toString(), '{"event":"invoice.paid"}');
});

test("replayEvent sends binary bodies exactly", async () => {
  const bytes = Buffer.from([0, 1, 2, 3, 250, 255]);
  const result = await replayEvent(
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes.toString("base64"),
      encoding: "base64",
    },
    { target: `${baseUrl}/binary` },
  );
  assert.equal(result.status, 202);
  assert.deepEqual(lastRequest.body, bytes);
});

test("replayEvent does not send a body for GET", async () => {
  const result = await replayEvent(
    { method: "GET", headers: {}, body: "ignored", encoding: "utf8" },
    { target: `${baseUrl}/get` },
  );
  assert.equal(result.status, 202);
  assert.equal(lastRequest.method, "GET");
  assert.equal(lastRequest.body.length, 0);
});

test("replayEvent reports non 2xx responses without throwing", async () => {
  const result = await replayEvent(
    { method: "POST", headers: {}, body: "x", encoding: "utf8" },
    { target: `${baseUrl}/teapot` },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 418);
  assert.equal(result.error, null);
  assert.match(result.bodyPreview, /teapot/);
});

test("replayEvent returns redirects as they are", async () => {
  const result = await replayEvent(
    { method: "GET", headers: {} },
    { target: `${baseUrl}/redirect` },
  );
  assert.equal(result.status, 302);
  assert.equal(result.ok, false);
});

test("replayEvent times out", async () => {
  const result = await replayEvent(
    { method: "GET", headers: {} },
    { target: `${baseUrl}/slow`, timeoutMs: 50 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.match(result.error, /timeout after 50ms/);
});

test("replayEvent reports connection failures", async () => {
  const result = await replayEvent(
    { method: "POST", headers: {}, body: "x", encoding: "utf8" },
    { target: "http://127.0.0.1:1/nothing", timeoutMs: 2000 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.ok(result.error);
  assert.equal(result.bodyPreview, "");
});

test("replayEvent refuses to run without a target", async () => {
  const result = await replayEvent({ method: "POST", headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no replay target");
});

test("replayPayload drops the buffer", () => {
  const payload = replayPayload({
    ok: true,
    status: 200,
    durationMs: 4,
    error: null,
    bodyPreview: "ok",
    bodyBuffer: Buffer.from("ok"),
    headers: { a: "b" },
  });
  assert.deepEqual(payload, {
    ok: true,
    status: 200,
    durationMs: 4,
    error: null,
    bodyPreview: "ok",
  });
});
