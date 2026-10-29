import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { Inspector, createTui, parseKeys, renderScreen } from "../src/tui.js";

const SUMMARY = {
  id: "evt_9f2a41c3",
  receivedAt: "2026-10-29T12:34:56.000Z",
  method: "POST",
  path: "/hooks/stripe",
  contentType: "application/json",
  size: 42,
  binary: false,
  truncated: false,
  forwardStatus: null,
  forwardError: null,
  replayed: 0,
};

const DETAIL = {
  ...SUMMARY,
  query: "attempt=1",
  headers: { "content-type": "application/json", "x-signature": "abc" },
  body: '{"event":"invoice.paid","amount":42}',
  encoding: "utf8",
  remoteAddress: "127.0.0.1",
  forward: { status: 202, ok: true, durationMs: 12, error: null },
  lastReplay: null,
};

test("parseKeys understands arrows, navigation keys and plain characters", () => {
  assert.deepEqual(parseKeys("\x1b[A"), ["up"]);
  assert.deepEqual(parseKeys("\x1b[B"), ["down"]);
  assert.deepEqual(parseKeys("\x1b[C"), ["right"]);
  assert.deepEqual(parseKeys("\x1b[D"), ["left"]);
  assert.deepEqual(parseKeys("\x1b[H"), ["home"]);
  assert.deepEqual(parseKeys("\x1b[F"), ["end"]);
  assert.deepEqual(parseKeys("\x1b[5~"), ["pageup"]);
  assert.deepEqual(parseKeys("\x1b[6~"), ["pagedown"]);
  assert.deepEqual(parseKeys("\x1b"), ["escape"]);
  assert.deepEqual(parseKeys("\r"), ["enter"]);
  assert.deepEqual(parseKeys("\n"), ["enter"]);
  assert.deepEqual(parseKeys("\x7f"), ["backspace"]);
  assert.deepEqual(parseKeys("\x03"), ["quit"]);
  assert.deepEqual(parseKeys("\x0c"), ["redraw"]);
  assert.deepEqual(parseKeys("jG?"), ["char:j", "char:G", "char:?"]);
});

test("parseKeys handles several keys in one chunk", () => {
  assert.deepEqual(parseKeys("\x1b[A\x1b[BjG\r\x03"), [
    "up",
    "down",
    "char:j",
    "char:G",
    "enter",
    "quit",
  ]);
  assert.deepEqual(parseKeys(""), []);
  assert.deepEqual(parseKeys("\x01"), []);
});

test("hello replaces history and sets the stream state", () => {
  const inspector = new Inspector({ maxEvents: 5 });
  const action = inspector.applyMessage({
    type: "hello",
    version: "0.1.0",
    target: "http://localhost:3000",
    maxEvents: 10,
    events: [SUMMARY, { ...SUMMARY, id: "evt_2" }],
  });
  assert.equal(action, "connected");
  assert.equal(inspector.connected, true);
  assert.equal(inspector.target, "http://localhost:3000");
  assert.equal(inspector.maxEvents, 10);
  assert.equal(inspector.events.length, 2);
  assert.equal(inspector.current().id, "evt_9f2a41c3");
});

test("new events are prepended and the selection stays on the same event", () => {
  const inspector = new Inspector({ maxEvents: 5 });
  inspector.applyMessage({ type: "hello", events: [{ ...SUMMARY, id: "evt_1" }] });
  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_2" } });
  assert.deepEqual(
    inspector.events.map((event) => event.id),
    ["evt_2", "evt_1"],
  );
  assert.equal(inspector.selected, 0);

  inspector.selected = 1;
  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_3" } });
  assert.equal(inspector.selected, 2);
  assert.equal(inspector.current().id, "evt_1");

  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_4" } });
  assert.deepEqual(
    inspector.events.map((event) => event.id),
    ["evt_4", "evt_3", "evt_2", "evt_1"],
  );
  assert.equal(inspector.selected, 3);
  assert.equal(inspector.current().id, "evt_1");

  inspector.maxEvents = 3;
  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_5" } });
  assert.deepEqual(
    inspector.events.map((event) => event.id),
    ["evt_5", "evt_4", "evt_3"],
  );
  assert.equal(inspector.selected, 2);
  assert.equal(inspector.current().id, "evt_3");
});

test("pausing the stream counts pending events", () => {
  const inspector = new Inspector();
  inspector.applyMessage({ type: "hello", events: [] });
  assert.equal(inspector.togglePause(), true);
  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_1" } });
  inspector.applyMessage({ type: "event", event: { ...SUMMARY, id: "evt_2" } });
  assert.equal(inspector.events.length, 0);
  assert.equal(inspector.pending, 2);
  assert.equal(inspector.togglePause(), false);
  assert.equal(inspector.pending, 0);
});

test("delete and clear update the selection", () => {
  const inspector = new Inspector();
  inspector.applyMessage({
    type: "hello",
    events: [
      { ...SUMMARY, id: "evt_1" },
      { ...SUMMARY, id: "evt_2" },
      { ...SUMMARY, id: "evt_3" },
    ],
  });
  inspector.selected = 2;
  inspector.applyMessage({ type: "delete", id: "evt_1" });
  assert.equal(inspector.selected, 1);
  assert.equal(inspector.events.length, 2);
  inspector.open();
  inspector.applyMessage({ type: "delete", id: inspector.current().id });
  assert.equal(inspector.mode, "list");
  assert.equal(inspector.detail, null);

  inspector.applyMessage({ type: "clear" });
  assert.equal(inspector.events.length, 0);
  assert.equal(inspector.selected, 0);
});

test("replay messages update the counter and the status", () => {
  const inspector = new Inspector();
  inspector.applyMessage({ type: "hello", events: [SUMMARY] });
  inspector.applyMessage({
    type: "replay",
    id: SUMMARY.id,
    result: { ok: true, status: 200, durationMs: 9, error: null },
  });
  assert.equal(inspector.events[0].replayed, 1);
  assert.match(inspector.visibleStatus(), /replayed evt_9f2a41c3 in 9ms/);
});

test("navigation clamps to the list and scrolls details", () => {
  const inspector = new Inspector();
  inspector.applyMessage({
    type: "hello",
    events: [
      { ...SUMMARY, id: "evt_1" },
      { ...SUMMARY, id: "evt_2" },
    ],
  });
  inspector.move(-1);
  assert.equal(inspector.selected, 0);
  inspector.move(1);
  assert.equal(inspector.selected, 1);
  inspector.move(1);
  assert.equal(inspector.selected, 1);
  inspector.home();
  assert.equal(inspector.selected, 0);
  inspector.end();
  assert.equal(inspector.selected, 1);

  inspector.open();
  assert.equal(inspector.mode, "detail");
  inspector.move(1);
  assert.equal(inspector.scroll, 1);
  inspector.home();
  assert.equal(inspector.scroll, 0);
  inspector.end();
  assert.equal(inspector.scroll, Number.MAX_SAFE_INTEGER);
  inspector.back();
  assert.equal(inspector.mode, "list");
  assert.equal(inspector.detail, null);
});

test("clear needs two presses inside the window", () => {
  const inspector = new Inspector();
  assert.equal(inspector.armClear(1000), false);
  assert.match(inspector.visibleStatus(1000), /press c again/);
  assert.equal(inspector.armClear(2000), true);
  assert.equal(inspector.armClear(9000), false);
  assert.equal(inspector.visibleStatus(20000), "");
});

test("open refuses an empty list", () => {
  const inspector = new Inspector();
  assert.equal(inspector.open(), false);
  assert.match(inspector.visibleStatus(), /no event selected/);
});

test("renderScreen draws a list row and the selected marker", () => {
  const inspector = new Inspector({ target: "http://localhost:3000" });
  inspector.applyMessage({ type: "hello", events: [SUMMARY, { ...SUMMARY, id: "evt_2" }] });
  const screen = renderScreen(inspector, { width: 110, height: 20 });
  assert.match(screen, /wip/);
  assert.match(screen, /evt_9f2a41c3/);
  assert.match(screen, /POST/);
  assert.match(screen, /\/hooks\/stripe/);
  assert.match(screen, /http:\/\/localhost:3000/);
  assert.match(screen, /\x1b\[7m/);
});

test("renderScreen draws an empty list", () => {
  const inspector = new Inspector();
  const screen = renderScreen(inspector, { width: 80, height: 12 });
  assert.match(screen, /waiting for webhooks/);
  assert.match(screen, /0 events/);
});

test("renderScreen draws details and help", () => {
  const inspector = new Inspector({ target: "http://localhost:3000" });
  inspector.applyMessage({ type: "hello", events: [SUMMARY] });
  inspector.open(DETAIL);
  inspector.detail = DETAIL;
  const detail = renderScreen(inspector, { width: 100, height: 30 });
  assert.match(detail, /Headers:/);
  assert.match(detail, /x-signature: abc/);
  assert.match(detail, /amount/);

  inspector.toggleHelp();
  const help = renderScreen(inspector, { width: 100, height: 30 });
  assert.match(help, /Keys/);
  assert.match(help, /replay/);
});

test("renderScreen survives a very small terminal", () => {
  const inspector = new Inspector();
  const screen = renderScreen(inspector, { width: 5, height: 2 });
  assert.equal(typeof screen, "string");
  assert.ok(screen.length > 0);
});

class FakeStream extends EventEmitter {
  constructor({ isTTY = true } = {}) {
    super();
    this.isTTY = isTTY;
    this.columns = 100;
    this.rows = 30;
    this.chunks = [];
    this.rawMode = false;
    this.paused = false;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  setRawMode(value) {
    this.rawMode = value;
  }

  setEncoding() {}

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  get text() {
    return this.chunks.join("");
  }
}

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

test("createTui renders, opens details and quits cleanly", async () => {
  FakeWebSocket.instances = [];
  const input = new FakeStream();
  const output = new FakeStream();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(DETAIL),
    };
  };
  let quit = false;

  const tui = createTui({
    baseUrl: "http://127.0.0.1:4242",
    wsUrl: "ws://127.0.0.1:4242/stream",
    target: "http://localhost:3000",
    input,
    output,
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    onQuit: () => {
      quit = true;
    },
  });

  tui.start();
  assert.equal(input.rawMode, true);
  assert.match(output.text, /\x1b\[\?1049h/);

  const socket = FakeWebSocket.instances.at(-1);
  assert.equal(socket.url, "ws://127.0.0.1:4242/stream");
  socket.emit("message", JSON.stringify({ type: "hello", events: [SUMMARY], target: "http://localhost:3000" }));
  assert.match(output.text, /evt_9f2a41c3/);

  input.emit("data", "\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), "http://127.0.0.1:4242/api/events/evt_9f2a41c3");
  assert.match(output.text, /x-signature: abc/);

  input.emit("data", "\x1b");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(tui.inspector.mode, "list");

  input.emit("data", "q");
  assert.equal(quit, true);
  assert.equal(input.rawMode, false);
  assert.match(output.text, /\x1b\[\?1049l/);
});

test("createTui pauses, clears and replays", async () => {
  FakeWebSocket.instances = [];
  const input = new FakeStream();
  const output = new FakeStream();
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET", body: options.body });
    if (url.endsWith("/replay")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ ok: true, status: 202, durationMs: 8, error: null, id: SUMMARY.id }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, cleared: 1 }),
    };
  };

  const tui = createTui({
    baseUrl: "http://127.0.0.1:4242",
    wsUrl: "ws://127.0.0.1:4242/stream",
    target: "http://localhost:3000",
    input,
    output,
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    onQuit: () => {},
  });
  tui.start();
  const socket = FakeWebSocket.instances.at(-1);
  socket.emit("message", JSON.stringify({ type: "hello", events: [SUMMARY] }));

  input.emit("data", "p");
  assert.equal(tui.inspector.paused, true);
  socket.emit("message", JSON.stringify({ type: "event", event: { ...SUMMARY, id: "evt_new" } }));
  assert.equal(tui.inspector.events.length, 1);
  assert.equal(tui.inspector.pending, 1);
  input.emit("data", "p");
  assert.equal(tui.inspector.paused, false);

  input.emit("data", "r");
  await new Promise((resolve) => setImmediate(resolve));
  const replay = requests.find((request) => request.url.endsWith("/replay"));
  assert.equal(replay.method, "POST");
  assert.match(output.text, /replayed evt_9f2a41c3/);

  input.emit("data", "c");
  input.emit("data", "c");
  await new Promise((resolve) => setImmediate(resolve));
  const clear = requests.find((request) => request.url.endsWith("/api/events") && request.method === "DELETE");
  assert.ok(clear);
  assert.equal(tui.inspector.events.length, 0);

  tui.stop();
  assert.match(output.text, /\x1b\[\?1049l/);
});

test("createTui redraws on a resize", () => {
  FakeWebSocket.instances = [];
  const input = new FakeStream();
  const output = new FakeStream();
  const tui = createTui({
    baseUrl: "http://127.0.0.1:4242",
    wsUrl: "ws://127.0.0.1:4242/stream",
    input,
    output,
    WebSocketImpl: FakeWebSocket,
    onQuit: () => {},
  });
  tui.start();
  const before = output.chunks.length;
  output.columns = 60;
  output.emit("resize");
  assert.ok(output.chunks.length > before);
  tui.stop();
});
