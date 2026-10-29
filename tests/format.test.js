import assert from "node:assert/strict";
import { test } from "node:test";

import {
  eventRow,
  formatBytes,
  formatClock,
  prettyBody,
  renderDetail,
  renderHelp,
  truncate,
  wrapText,
} from "../src/format.js";

const EVENT = {
  id: "evt_9f2a41c3",
  receivedAt: "2026-10-29T12:34:56.000Z",
  method: "POST",
  path: "/hooks/stripe?attempt=2",
  contentType: "application/json",
  size: 2048,
  binary: false,
  truncated: false,
  remoteAddress: "127.0.0.1",
  headers: {
    "content-type": "application/json",
    "x-signature": "sha256=abc",
  },
  body: '{"event":"invoice.paid","amount":42}',
  forward: { status: 202, durationMs: 17, ok: true, error: null },
  replayed: 2,
};

test("formatBytes switches units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatBytes("nope"), "0 B");
});

test("formatClock prints a local clock and survives bad input", () => {
  const expected = new Date(EVENT.receivedAt).toTimeString().slice(0, 8);
  assert.equal(formatClock(EVENT.receivedAt), expected);
  assert.equal(formatClock("not a date"), "--:--:--");
  assert.equal(formatClock(null), "--:--:--");
});

test("truncate keeps short text and marks long text", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 8), "hello...");
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", 2), "he");
  assert.equal(truncate(null, 4), "");
});

test("eventRow uses the full width and shows the important fields", () => {
  const row = eventRow(
    {
      id: "evt_9f2a41c3",
      receivedAt: EVENT.receivedAt,
      method: "POST",
      path: "/hooks/stripe",
      size: 2048,
      forwardStatus: 202,
    },
    { width: 100 },
  );
  assert.equal(row.length, 100);
  assert.match(row, /evt_9f2a41c3/);
  assert.match(row, /POST/);
  assert.match(row, /\/hooks\/stripe/);
  assert.match(row, /2\.0 KB/);
  assert.match(row, /202/);
  assert.equal(row.startsWith("  "), true);

  const selected = eventRow(
    { id: "evt_1", receivedAt: EVENT.receivedAt, method: "GET", path: "/", size: 0 },
    { width: 80, selected: true },
  );
  assert.equal(selected.startsWith("> "), true);
  assert.equal(selected.length, 80);
});

test("eventRow marks forwarded errors", () => {
  const row = eventRow(
    {
      id: "evt_1",
      receivedAt: EVENT.receivedAt,
      method: "POST",
      path: "/",
      size: 1,
      forwardStatus: 0,
      forwardError: "timeout",
    },
    { width: 100 },
  );
  assert.match(row, /err/);
});

test("prettyBody pretty prints JSON", () => {
  assert.equal(prettyBody({ body: '{"a":1}' }), '{\n  "a": 1\n}');
  assert.equal(prettyBody({ body: "plain text" }), "plain text");
  assert.equal(prettyBody({ body: "", binary: false }), "");
  assert.equal(prettyBody(null), "");
  assert.equal(
    prettyBody({ binary: true, size: 1024 }),
    "<binary body, 1.0 KB>",
  );
});

test("wrapText wraps on spaces and hard splits long words", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
  assert.deepEqual(wrapText("a\nb", 10), ["a", "b"]);
  assert.deepEqual(wrapText("", 10), [""]);
});

test("renderDetail shows metadata, headers and a pretty body", () => {
  const lines = renderDetail(EVENT, { width: 100, height: 40 });
  const text = lines.join("\n");
  assert.match(text, /evt_9f2a41c3/);
  assert.match(text, /POST \/hooks\/stripe/);
  assert.match(text, /application\/json/);
  assert.match(text, /Headers:/);
  assert.match(text, /x-signature: sha256=abc/);
  assert.match(text, /Body:/);
  assert.match(text, /"amount": 42/);
  assert.match(text, /forwarded: status 202 in 17ms/);
  assert.match(text, /replayed 2 times/);
});

test("renderDetail handles a binary body and an empty body", () => {
  const binary = renderDetail(
    { ...EVENT, binary: true, size: 10, body: "" },
    { width: 80, height: 30 },
  ).join("\n");
  assert.match(binary, /binary body/);

  const empty = renderDetail(
    { ...EVENT, body: "", headers: {}, forward: null, replayed: 0 },
    { width: 80, height: 30 },
  ).join("\n");
  assert.match(empty, /empty/);
  assert.match(empty, /none/);
});

test("renderDetail clamps scrolling", () => {
  const lines = renderDetail(EVENT, { width: 60, height: 5, scroll: 1000 });
  assert.equal(lines.length, 5);
  assert.match(lines.join("\n"), /amount/);

  const noEvent = renderDetail(null);
  assert.deepEqual(noEvent, ["No event selected."]);
});

test("renderHelp lists the keys", () => {
  const help = renderHelp().join("\n");
  assert.match(help, /j, down/);
  assert.match(help, /enter/);
  assert.match(help, /r\s+replay/);
  assert.match(help, /q\s+quit/);
});
