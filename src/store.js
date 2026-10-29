import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function newEventId() {
  return `evt_${randomBytes(4).toString("hex")}`;
}

export function looksBinary(buffer) {
  return Buffer.isBuffer(buffer) && buffer.includes(0);
}

export function summariseEvent(event) {
  return {
    id: event.id,
    receivedAt: event.receivedAt,
    method: event.method,
    path: event.path,
    contentType: event.contentType,
    size: event.size,
    binary: event.binary,
    truncated: event.truncated,
    forwardStatus: event.forward ? event.forward.status : null,
    forwardError: event.forward ? event.forward.error : null,
    replayed: event.replayed || 0,
  };
}

export class EventStore {
  constructor({ maxEvents = 500, file = "" } = {}) {
    this.maxEvents = Math.max(1, Number(maxEvents) || 500);
    this.file = file || "";
    this.events = [];
    this.subscribers = new Set();
    this.load();
  }

  get size() {
    return this.events.length;
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    const loaded = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && event.id && event.method && event.path) {
          loaded.push(event);
        }
      } catch {
        // A partial final line can happen when the process stops mid write.
      }
    }
    this.events = loaded.slice(-this.maxEvents);
  }

  persistAppend(event) {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // The store keeps working in memory when the file cannot be written.
    }
  }

  persistAll() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const text = this.events.map((event) => JSON.stringify(event)).join("\n");
      writeFileSync(this.file, text ? `${text}\n` : "", "utf8");
    } catch {
      // Ignore write failures, the in memory copy is still correct.
    }
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  emit(message) {
    for (const listener of this.subscribers) {
      try {
        listener(message);
      } catch {
        // A broken listener must not break capture.
      }
    }
  }

  add(input) {
    const event = {
      id: input.id || newEventId(),
      receivedAt: input.receivedAt || new Date().toISOString(),
      method: String(input.method || "POST").toUpperCase(),
      path: input.path || "/",
      query: input.query || "",
      headers: input.headers || {},
      contentType: input.contentType || "",
      body: input.body || "",
      encoding: input.encoding === "base64" ? "base64" : "utf8",
      size: Number(input.size || 0),
      binary: Boolean(input.binary),
      truncated: Boolean(input.truncated),
      remoteAddress: input.remoteAddress || "",
      forward: input.forward || null,
      replayed: 0,
      lastReplay: null,
      notes: input.notes || "",
    };
    this.events.push(event);
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    this.persistAppend(event);
    this.emit({ type: "event", event: summariseEvent(event) });
    return event;
  }

  list({ limit = 0 } = {}) {
    const ordered = [...this.events].reverse();
    const sliced = limit > 0 ? ordered.slice(0, limit) : ordered;
    return sliced.map(summariseEvent);
  }

  get(id) {
    return this.events.find((event) => event.id === id) || null;
  }

  remove(id) {
    const index = this.events.findIndex((event) => event.id === id);
    if (index < 0) return false;
    this.events.splice(index, 1);
    this.persistAll();
    this.emit({ type: "delete", id });
    return true;
  }

  clear() {
    const count = this.events.length;
    this.events = [];
    this.persistAll();
    this.emit({ type: "clear" });
    return count;
  }

  noteReplay(id, result) {
    const event = this.get(id);
    if (!event) return null;
    event.replayed = (event.replayed || 0) + 1;
    event.lastReplay = {
      at: new Date().toISOString(),
      status: result.status,
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.error,
    };
    return event;
  }
}
