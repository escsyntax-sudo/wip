import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EventStore,
  looksBinary,
  newEventId,
  summariseEvent,
} from "../src/store.js";

test("newEventId uses the evt prefix and eight hex characters", () => {
  const id = newEventId();
  assert.match(id, /^evt_[0-9a-f]{8}$/);
  assert.notEqual(id, newEventId());
});

test("add fills defaults and normalises the method", () => {
  const store = new EventStore();
  const event = store.add({ method: "post", path: "/hooks/stripe", body: "hello", size: 5 });
  assert.match(event.id, /^evt_/);
  assert.equal(event.method, "POST");
  assert.equal(event.path, "/hooks/stripe");
  assert.equal(event.encoding, "utf8");
  assert.equal(event.binary, false);
  assert.equal(event.replayed, 0);
  assert.equal(store.size, 1);
});

test("list returns newest first and honours the limit", () => {
  const store = new EventStore();
  const first = store.add({ path: "/one" });
  const second = store.add({ path: "/two" });
  const third = store.add({ path: "/three" });
  assert.deepEqual(
    store.list().map((event) => event.path),
    ["/three", "/two", "/one"],
  );
  assert.deepEqual(
    store.list({ limit: 2 }).map((event) => event.path),
    ["/three", "/two"],
  );
  assert.ok(store.get(first.id));
  assert.ok(store.get(second.id));
  assert.ok(store.get(third.id));
  assert.equal(store.get("evt_missing"), null);
});

test("maxEvents drops the oldest entries", () => {
  const store = new EventStore({ maxEvents: 3 });
  for (let index = 0; index < 5; index += 1) {
    store.add({ path: `/event-${index}` });
  }
  assert.equal(store.size, 3);
  assert.deepEqual(
    store.list().map((event) => event.path),
    ["/event-4", "/event-3", "/event-2"],
  );
  assert.ok(store.maxEvents >= 1);
});

test("remove and clear report what they did", () => {
  const store = new EventStore();
  const event = store.add({ path: "/one" });
  store.add({ path: "/two" });
  assert.equal(store.remove(event.id), true);
  assert.equal(store.remove(event.id), false);
  assert.equal(store.size, 1);
  assert.equal(store.clear(), 1);
  assert.equal(store.size, 0);
  assert.equal(store.clear(), 0);
});

test("subscribers receive event, delete and clear messages", () => {
  const store = new EventStore();
  const messages = [];
  const unsubscribe = store.subscribe((message) => messages.push(message));
  const event = store.add({ path: "/one" });
  store.remove(event.id);
  store.add({ path: "/two" });
  store.clear();
  unsubscribe();
  store.add({ path: "/three" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["event", "delete", "event", "clear"],
  );
  assert.equal(messages[0].event.path, "/one");
  assert.equal(messages[1].id, event.id);
});

test("a throwing subscriber does not break capture", () => {
  const store = new EventStore();
  store.subscribe(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => store.add({ path: "/one" }));
  assert.equal(store.size, 1);
});

test("noteReplay counts replays and stores the last result", () => {
  const store = new EventStore();
  const event = store.add({ path: "/one" });
  assert.equal(store.noteReplay("evt_missing", { status: 200 }), null);
  store.noteReplay(event.id, { ok: true, status: 200, durationMs: 12, error: null });
  store.noteReplay(event.id, { ok: false, status: 500, durationMs: 20, error: "upstream" });
  const stored = store.get(event.id);
  assert.equal(stored.replayed, 2);
  assert.equal(stored.lastReplay.status, 500);
  assert.equal(stored.lastReplay.ok, false);
  assert.equal(stored.lastReplay.error, "upstream");
});

test("summariseEvent keeps the fields used by lists", () => {
  const event = {
    id: "evt_1",
    receivedAt: "2026-10-29T12:00:00.000Z",
    method: "POST",
    path: "/x",
    contentType: "application/json",
    size: 10,
    binary: false,
    truncated: true,
    forward: { status: 202, error: null },
    replayed: 3,
    body: "not in the summary",
  };
  const summary = summariseEvent(event);
  assert.equal(summary.forwardStatus, 202);
  assert.equal(summary.forwardError, null);
  assert.equal(summary.replayed, 3);
  assert.equal("body" in summary, false);
});

test("looksBinary spots null bytes", () => {
  assert.equal(looksBinary(Buffer.from("plain text")), false);
  assert.equal(looksBinary(Buffer.from([1, 0, 2])), true);
  assert.equal(looksBinary("plain text"), false);
});

test("events are appended to a JSON Lines file and loaded again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wip-store-"));
  const file = join(directory, "nested", "events.jsonl");
  try {
    const store = new EventStore({ file, maxEvents: 10 });
    const first = store.add({
      method: "POST",
      path: "/one",
      body: '{"a":1}',
      size: 7,
      headers: { "content-type": "application/json" },
    });
    store.add({ path: "/two", binary: true, body: "AAEC", encoding: "base64", size: 3 });
    store.noteReplay(first.id, { ok: true, status: 200, durationMs: 4, error: null });

    const text = await readFile(file, "utf8");
    assert.equal(text.trim().split("\n").length, 2);

    const reloaded = new EventStore({ file, maxEvents: 10 });
    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.list()[0].path, "/two");
    assert.equal(reloaded.get(first.id).body, '{"a":1}');

    store.remove(first.id);
    const afterRemove = new EventStore({ file });
    assert.equal(afterRemove.size, 1);
    assert.equal(afterRemove.list()[0].path, "/two");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a corrupt line is ignored when loading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wip-store-"));
  const file = join(directory, "events.jsonl");
  try {
    await writeFile(
      file,
      [
        JSON.stringify({ id: "evt_1", method: "POST", path: "/one" }),
        "{ broken",
        "",
        JSON.stringify({ id: "evt_2", method: "GET", path: "/two" }),
        '{"partial":',
      ].join("\n"),
      "utf8",
    );
    const store = new EventStore({ file });
    assert.equal(store.size, 2);
    assert.deepEqual(
      store.list().map((event) => event.path),
      ["/two", "/one"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loading respects maxEvents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wip-store-"));
  const file = join(directory, "events.jsonl");
  try {
    const lines = [1, 2, 3, 4].map((index) =>
      JSON.stringify({ id: `evt_${index}`, method: "POST", path: `/e${index}` }),
    );
    await writeFile(file, lines.join("\n"), "utf8");
    const store = new EventStore({ file, maxEvents: 2 });
    assert.deepEqual(
      store.list().map((event) => event.path),
      ["/e4", "/e3"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing data file is not an error", () => {
  const store = new EventStore({ file: join(tmpdir(), "wip-does-not-exist", "none.jsonl") });
  assert.equal(store.size, 0);
});
