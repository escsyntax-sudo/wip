import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import WebSocket from "ws";

import { createServer } from "../src/server.js";

async function build(options = {}) {
  const app = await createServer({ log: null, ...options });
  await app.ready();
  return app;
}

async function startUpstream() {
  const state = {
    requests: [],
    handler: null,
  };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      state.requests.push(entry);
      if (state.handler) {
        state.handler(entry, response);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "x-upstream": "yes",
      });
      response.end(JSON.stringify({ ok: true, path: entry.url }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitFor(predicate, { timeout = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a captured request keeps the raw body, query and headers", async () => {
  const app = await build();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/hooks/stripe?attempt=2",
      payload: '{"event":"invoice.paid","amount":42}',
      headers: {
        "content-type": "application/json",
        "x-signature": "sha256=abc",
      },
    });
    assert.equal(response.statusCode, 200);
    const { id } = response.json();
    assert.match(id, /^evt_/);

    const event = app.wip.store.get(id);
    assert.equal(event.method, "POST");
    assert.equal(event.path, "/hooks/stripe");
    assert.equal(event.query, "attempt=2");
    assert.equal(event.body, '{"event":"invoice.paid","amount":42}');
    assert.equal(event.encoding, "utf8");
    assert.equal(event.binary, false);
    assert.equal(event.contentType, "application/json");
    assert.equal(event.headers["x-signature"], "sha256=abc");
    assert.equal(event.size, 36);
    assert.equal(event.remoteAddress, "127.0.0.1");
  } finally {
    await app.close();
  }
});

test("the root path is captured too", async () => {
  const app = await build();
  try {
    const response = await app.inject({ method: "POST", url: "/", payload: "hello" });
    assert.equal(response.statusCode, 200);
    const event = app.wip.store.get(response.json().id);
    assert.equal(event.path, "/");
    assert.equal(event.body, "hello");
  } finally {
    await app.close();
  }
});

test("binary bodies are stored as base64", async () => {
  const app = await build();
  try {
    const bytes = Buffer.from([0, 1, 2, 3, 250, 255]);
    const response = await app.inject({
      method: "PUT",
      url: "/binary",
      payload: bytes,
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(response.statusCode, 200);
    const event = app.wip.store.get(response.json().id);
    assert.equal(event.binary, true);
    assert.equal(event.encoding, "base64");
    assert.deepEqual(Buffer.from(event.body, "base64"), bytes);
    assert.equal(event.size, bytes.length);
  } finally {
    await app.close();
  }
});

test("control endpoints are not captured", async () => {
  const app = await build();
  try {
    const api = await app.inject({ method: "GET", url: "/api/events" });
    assert.equal(api.statusCode, 200);
    const missingApi = await app.inject({ method: "GET", url: "/api/nope" });
    assert.equal(missingApi.statusCode, 404);
    const stream = await app.inject({ method: "GET", url: "/stream" });
    assert.equal(stream.statusCode, 404);
    const bareApi = await app.inject({ method: "GET", url: "/api" });
    assert.equal(bareApi.statusCode, 404);
    const health = await app.inject({ method: "POST", url: "/health", payload: "x" });
    assert.equal(health.statusCode, 404);
    assert.equal(app.wip.store.size, 0);
  } finally {
    await app.close();
  }
});

test("health describes the server", async () => {
  const app = await build({ maxEvents: 7 });
  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload.name, "wip");
    assert.equal(payload.version, "0.1.0");
    assert.equal(payload.maxEvents, 7);
    assert.equal(payload.events, 0);
    assert.equal(payload.target, null);
    assert.ok(payload.startedAt);
  } finally {
    await app.close();
  }
});

test("the list endpoint returns summaries newest first", async () => {
  const app = await build();
  try {
    const first = (await app.inject({ method: "POST", url: "/one", payload: "1" })).json().id;
    const second = (await app.inject({ method: "POST", url: "/two", payload: "22" })).json().id;
    const list = await app.inject({ method: "GET", url: "/api/events" });
    const payload = list.json();
    assert.equal(payload.count, 2);
    assert.deepEqual(
      payload.events.map((event) => event.id),
      [second, first],
    );
    assert.equal("body" in payload.events[0], false);
    assert.equal(payload.events[0].size, 2);

    const limited = await app.inject({ method: "GET", url: "/api/events?limit=1" });
    assert.equal(limited.json().events.length, 1);
  } finally {
    await app.close();
  }
});

test("the detail endpoint returns the full event", async () => {
  const app = await build();
  try {
    const id = (await app.inject({ method: "POST", url: "/one", payload: "hello" })).json().id;
    const response = await app.inject({ method: "GET", url: `/api/events/${id}` });
    assert.equal(response.statusCode, 200);
    const event = response.json();
    assert.equal(event.id, id);
    assert.equal(event.body, "hello");
    assert.deepEqual(event.headers.host, "localhost:80");

    const missing = await app.inject({ method: "GET", url: "/api/events/evt_missing" });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("events can be deleted and cleared", async () => {
  const app = await build();
  try {
    const id = (await app.inject({ method: "POST", url: "/one", payload: "1" })).json().id;
    await app.inject({ method: "POST", url: "/two", payload: "2" });
    const removed = await app.inject({ method: "DELETE", url: `/api/events/${id}` });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json(), { ok: true, id });
    assert.equal(app.wip.store.get(id), null);

    const missing = await app.inject({ method: "DELETE", url: `/api/events/${id}` });
    assert.equal(missing.statusCode, 404);

    const cleared = await app.inject({ method: "DELETE", url: "/api/events" });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { ok: true, cleared: 1 });
    assert.equal(app.wip.store.size, 0);
  } finally {
    await app.close();
  }
});

test("maxEvents limits the store", async () => {
  const app = await build({ maxEvents: 2 });
  try {
    for (let index = 0; index < 4; index += 1) {
      await app.inject({ method: "POST", url: `/e${index}`, payload: String(index) });
    }
    assert.equal(app.wip.store.size, 2);
    assert.deepEqual(
      app.wip.store.list().map((event) => event.path),
      ["/e3", "/e2"],
    );
  } finally {
    await app.close();
  }
});

test("replay needs a target", async () => {
  const app = await build();
  try {
    const id = (await app.inject({ method: "POST", url: "/one", payload: "1" })).json().id;
    const response = await app.inject({
      method: "POST",
      url: `/api/events/${id}/replay`,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /no replay target/);

    const missing = await app.inject({
      method: "POST",
      url: "/api/events/evt_missing/replay",
      payload: {},
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("replay sends a stored event to an explicit target", async () => {
  const upstream = await startUpstream();
  const app = await build();
  try {
    const id = (
      await app.inject({
        method: "POST",
        url: "/stripe?attempt=1",
        payload: '{"event":"invoice.paid"}',
        headers: { "content-type": "application/json", "x-signature": "abc" },
      })
    ).json().id;

    const response = await app.inject({
      method: "POST",
      url: `/api/events/${id}/replay`,
      payload: { target: `${upstream.url}/replayed` },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.id, id);
    assert.equal(result.target, `${upstream.url}/replayed`);
    assert.equal(result.bodyPreview.includes("replayed"), true);

    assert.equal(upstream.state.requests.length, 1);
    const forwarded = upstream.state.requests[0];
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.url, "/replayed");
    assert.equal(forwarded.body.toString(), '{"event":"invoice.paid"}');
    assert.equal(forwarded.headers["x-signature"], "abc");
    assert.equal(app.wip.store.get(id).replayed, 1);
    assert.equal(app.wip.store.get(id).lastReplay.status, 200);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("replay rejects a target that is not http", async () => {
  const app = await build();
  try {
    const id = (await app.inject({ method: "POST", url: "/one", payload: "1" })).json().id;
    const response = await app.inject({
      method: "POST",
      url: `/api/events/${id}/replay`,
      payload: { target: "file:///etc/passwd" },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /http or https/);
  } finally {
    await app.close();
  }
});

test("forward mode proxies the request and records the outcome", async () => {
  const upstream = await startUpstream();
  upstream.state.handler = (entry, response) => {
    response.writeHead(207, {
      "content-type": "application/json",
      "x-upstream": "accepted",
    });
    response.end(JSON.stringify({ seen: entry.body.toString("utf8") }));
  };
  const app = await build({ forward: upstream.url });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/github",
      payload: '{"action":"opened"}',
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
    });
    assert.equal(response.statusCode, 207);
    assert.equal(response.headers["x-upstream"], "accepted");
    assert.deepEqual(response.json(), { seen: '{"action":"opened"}' });

    assert.equal(upstream.state.requests.length, 1);
    assert.equal(upstream.state.requests[0].headers["x-github-event"], "pull_request");

    const event = app.wip.store.list()[0];
    assert.equal(event.forwardStatus, 207);
    assert.equal(event.forwardError, null);
    assert.equal(app.wip.store.get(event.id).forward.ok, true);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test("forward mode returns 502 when the upstream fails", async () => {
  const app = await build({ forward: "http://127.0.0.1:1", timeoutMs: 2000 });
  try {
    const response = await app.inject({ method: "POST", url: "/hook", payload: "x" });
    assert.equal(response.statusCode, 502);
    const payload = response.json();
    assert.equal(payload.ok, false);
    assert.ok(payload.error);
    const event = app.wip.store.get(payload.id);
    assert.ok(event.forward.error);
    assert.equal(event.forward.status, 0);
  } finally {
    await app.close();
  }
});

test("the body limit is enforced", async () => {
  const app = await build({ maxBody: 1024 });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/big",
      payload: "x".repeat(2000),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(app.wip.store.size, 0);
  } finally {
    await app.close();
  }
});

test("the websocket stream sends history and live updates", async () => {
  const app = await build();
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const messages = [];
  const socket = new WebSocket(`${address.replace("http", "ws")}/stream`);
  socket.on("message", (data) => {
    messages.push(JSON.parse(String(data)));
  });

  try {
    await waitFor(() => messages.length > 0, { label: "hello" });
    assert.equal(messages[0].type, "hello");
    assert.equal(messages[0].version, "0.1.0");
    assert.deepEqual(messages[0].events, []);

    const response = await fetch(`${address}/hooks/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"live":true}',
    });
    const { id } = await response.json();

    await waitFor(
      () => messages.find((message) => message.type === "event" && message.event.id === id),
      { label: "event broadcast" },
    );
    const eventMessage = messages.find((message) => message.type === "event");
    assert.equal(eventMessage.event.path, "/hooks/live");
    assert.equal("body" in eventMessage.event, false);

    await fetch(`${address}/api/events/${id}`, { method: "DELETE" });
    await waitFor(
      () => messages.find((message) => message.type === "delete" && message.id === id),
      { label: "delete broadcast" },
    );
  } finally {
    socket.close();
    await new Promise((resolve) => socket.once("close", resolve));
    await app.close();
  }
});

test("a data file persists events between servers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wip-server-"));
  const file = join(directory, "events.jsonl");
  const first = await build({ dataFile: file });
  try {
    await first.inject({ method: "POST", url: "/persisted", payload: "keep me" });
  } finally {
    await first.close();
  }

  const second = await build({ dataFile: file });
  try {
    assert.equal(second.wip.store.size, 1);
    const event = second.wip.store.list()[0];
    assert.equal(event.path, "/persisted");
    assert.equal(second.wip.store.get(event.id).body, "keep me");
  } finally {
    await second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
