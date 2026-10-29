import WebSocket from "ws";

import { eventRow, renderDetail, renderHelp, truncate } from "./format.js";

const ESC = "\x1b[";
const CLEAR = `${ESC}2J${ESC}H`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const REVERSE = `${ESC}7m`;

const STATUS_MS = 4000;

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function parseKeys(data) {
  const keys = [];
  const text = String(data ?? "");
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);

    if (rest.startsWith(`${ESC}A`)) {
      keys.push("up");
      index += 3;
    } else if (rest.startsWith(`${ESC}B`)) {
      keys.push("down");
      index += 3;
    } else if (rest.startsWith(`${ESC}C`)) {
      keys.push("right");
      index += 3;
    } else if (rest.startsWith(`${ESC}D`)) {
      keys.push("left");
      index += 3;
    } else if (rest.startsWith(`${ESC}H`) || rest.startsWith(`${ESC}1~`) || rest.startsWith(`${ESC}7~`)) {
      keys.push("home");
      index += rest.startsWith(`${ESC}H`) ? 3 : 4;
    } else if (rest.startsWith(`${ESC}F`) || rest.startsWith(`${ESC}4~`) || rest.startsWith(`${ESC}8~`)) {
      keys.push("end");
      index += rest.startsWith(`${ESC}F`) ? 3 : 4;
    } else if (rest.startsWith(`${ESC}5~`)) {
      keys.push("pageup");
      index += 4;
    } else if (rest.startsWith(`${ESC}6~`)) {
      keys.push("pagedown");
      index += 4;
    } else if (text[index] === "\x1b") {
      keys.push("escape");
      index += 1;
    } else {
      const char = text[index];
      if (char === "\r" || char === "\n") keys.push("enter");
      else if (char === "\x7f" || char === "\b") keys.push("backspace");
      else if (char === "\x03") keys.push("quit");
      else if (char === "\x0c") keys.push("redraw");
      else if (char === "\t") keys.push("tab");
      else if (char >= " ") keys.push(`char:${char}`);
      index += 1;
    }
  }

  return keys;
}

export class Inspector {
  constructor({ target = "", maxEvents = 500 } = {}) {
    this.target = target;
    this.maxEvents = Math.max(1, Number(maxEvents) || 500);
    this.events = [];
    this.selected = 0;
    this.mode = "list";
    this.listScroll = 0;
    this.scroll = 0;
    this.detail = null;
    this.paused = false;
    this.pending = 0;
    this.connected = false;
    this.status = "";
    this.statusUntil = 0;
    this.clearArmedUntil = 0;
  }

  setStatus(message, now = Date.now()) {
    this.status = String(message || "");
    this.statusUntil = message ? now + STATUS_MS : 0;
  }

  visibleStatus(now = Date.now()) {
    if (!this.status) return "";
    if (this.statusUntil && now > this.statusUntil) return "";
    return this.status;
  }

  current() {
    return this.events[this.selected] || null;
  }

  applyMessage(message, now = Date.now()) {
    if (!message || typeof message !== "object") return null;
    switch (message.type) {
      case "hello": {
        this.events = Array.isArray(message.events) ? message.events.slice(0, this.maxEvents) : [];
        if (message.target !== undefined) this.target = message.target || "";
        if (message.maxEvents) this.maxEvents = message.maxEvents;
        this.selected = clamp(this.selected, 0, Math.max(0, this.events.length - 1));
        this.listScroll = 0;
        this.connected = true;
        return "connected";
      }
      case "event": {
        if (!message.event) return null;
        if (this.paused) {
          this.pending += 1;
          return "paused";
        }
        const existing = this.events.findIndex((event) => event.id === message.event.id);
        if (existing >= 0) {
          this.events[existing] = message.event;
          return "updated";
        }
        this.events.unshift(message.event);
        if (this.events.length > this.maxEvents) this.events.length = this.maxEvents;
        if (this.selected > 0) {
          this.selected = clamp(this.selected + 1, 0, this.events.length - 1);
        }
        return "event";
      }
      case "delete": {
        const index = this.events.findIndex((event) => event.id === message.id);
        if (index < 0) return null;
        this.events.splice(index, 1);
        if (this.detail && this.detail.id === message.id) {
          this.detail = null;
          this.mode = "list";
          this.scroll = 0;
        }
        this.selected = clamp(this.selected, 0, Math.max(0, this.events.length - 1));
        return "delete";
      }
      case "clear": {
        this.events = [];
        this.selected = 0;
        this.listScroll = 0;
        this.detail = null;
        this.mode = "list";
        this.scroll = 0;
        this.pending = 0;
        return "clear";
      }
      case "replay": {
        const event = this.events.find((item) => item.id === message.id);
        if (event) event.replayed = (event.replayed || 0) + 1;
        if (this.detail && this.detail.id === message.id) {
          this.detail.replayed = (this.detail.replayed || 0) + 1;
        }
        const result = message.result || {};
        const label = message.error
          ? message.error
          : result.ok
            ? `replayed ${message.id} in ${result.durationMs}ms`
            : `replay failed (${result.error || result.status || "unknown"})`;
        this.setStatus(label, now);
        return "replay";
      }
      default:
        return null;
    }
  }

  move(delta, step = 1) {
    if (this.mode === "detail") {
      this.scroll = Math.max(0, this.scroll + delta * step);
      return;
    }
    if (this.mode !== "list") return;
    this.selected = clamp(this.selected + delta * step, 0, Math.max(0, this.events.length - 1));
  }

  home() {
    if (this.mode === "detail") {
      this.scroll = 0;
    } else if (this.mode === "list") {
      this.selected = 0;
    }
  }

  end() {
    if (this.mode === "detail") {
      this.scroll = Number.MAX_SAFE_INTEGER;
    } else if (this.mode === "list") {
      this.selected = Math.max(0, this.events.length - 1);
    }
  }

  open(event = null) {
    const target = event || this.current();
    if (!target) {
      this.setStatus("no event selected");
      return false;
    }
    this.detail = target;
    this.mode = "detail";
    this.scroll = 0;
    return true;
  }

  back() {
    this.mode = "list";
    this.detail = null;
    this.scroll = 0;
  }

  togglePause() {
    this.paused = !this.paused;
    if (!this.paused) {
      this.pending = 0;
      this.setStatus("stream resumed");
    } else {
      this.setStatus("stream paused");
    }
    return this.paused;
  }

  toggleHelp() {
    if (this.mode === "help") {
      this.mode = "list";
    } else {
      this.mode = "help";
      this.scroll = 0;
    }
    return this.mode === "help";
  }

  armClear(now = Date.now()) {
    if (this.clearArmedUntil && now <= this.clearArmedUntil) {
      this.clearArmedUntil = 0;
      return true;
    }
    this.clearArmedUntil = now + 3000;
    this.setStatus("press c again to clear all events", now);
    return false;
  }

  removeLocal(id) {
    const index = this.events.findIndex((event) => event.id === id);
    if (index < 0) return false;
    this.events.splice(index, 1);
    this.selected = clamp(this.selected, 0, Math.max(0, this.events.length - 1));
    if (this.detail && this.detail.id === id) {
      this.mode = "list";
      this.detail = null;
    }
    return true;
  }
}

function headerLine(inspector, width) {
  const left = "wip";
  const state = inspector.paused
    ? `paused${inspector.pending ? ` +${inspector.pending}` : ""}`
    : inspector.connected
      ? "live"
      : "offline";
  const target = inspector.target ? `  -> ${inspector.target}` : "";
  const right = `${state}${target}`;
  const room = Math.max(0, width - left.length - right.length - 1);
  return `${BOLD}${left}${RESET}${" ".repeat(room)}${DIM}${truncate(right, width - left.length)}${RESET}`;
}

function listLines(inspector, width, height) {
  const lines = [];
  const fixed = 2 + 12 + 1 + 8 + 1 + 6 + 1 + 1 + 9 + 1 + 4;
  const pathWidth = Math.max(10, width - fixed);
  lines.push(
    `${"ID".padEnd(12)} ${"TIME".padEnd(8)} ${"METHOD".padEnd(6)} ${"PATH".padEnd(pathWidth)} ${"SIZE".padStart(9)} ${"FWD".padStart(4)}`,
  );
  if (inspector.events.length === 0) {
    lines.push("");
    lines.push(inspector.paused ? "  stream is paused" : "  waiting for webhooks");
  }
  const visible = Math.max(1, height - lines.length);
  const maximum = Math.max(0, inspector.events.length - visible);
  let start = Number(inspector.listScroll) || 0;
  if (inspector.selected < start) start = inspector.selected;
  if (inspector.selected >= start + visible) start = inspector.selected - visible + 1;
  start = clamp(start, 0, maximum);
  inspector.listScroll = start;
  for (let index = start; index < Math.min(inspector.events.length, start + visible); index += 1) {
    const event = inspector.events[index];
    const row = eventRow(event, { width, selected: index === inspector.selected });
    lines.push(index === inspector.selected ? `${REVERSE}${row}${RESET}` : row);
  }
  return lines;
}

function detailLines(inspector, width, height) {
  if (!inspector.detail) return ["No event selected."];
  const total = renderDetail(inspector.detail, { width, height: Number.MAX_SAFE_INTEGER, scroll: 0 }).length;
  const visible = Math.max(1, height);
  const maximum = Math.max(0, total - visible);
  inspector.scroll = clamp(inspector.scroll, 0, maximum);
  return renderDetail(inspector.detail, { width, height: visible, scroll: inspector.scroll });
}

function footerLines(inspector, width, now) {
  const status = inspector.visibleStatus(now);
  const hint =
    inspector.mode === "detail"
      ? "j/k scroll  esc back  r replay  d delete  ? help  q quit"
      : inspector.mode === "help"
        ? "esc close  q quit"
        : "j/k move  enter open  r replay  d delete  c clear  p pause  ? help  q quit";
  return [
    status ? truncate(status, width) : `${DIM}${truncate(hint, width)}${RESET}`,
    `${DIM}${truncate(
      `${inspector.events.length} event${inspector.events.length === 1 ? "" : "s"}  ${inspector.target || "no replay target"}`,
      width,
    )}${RESET}`,
  ];
}

export function renderScreen(inspector, { width = 100, height = 30, now = Date.now() } = {}) {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(8, height);
  const header = headerLine(inspector, safeWidth);
  const footers = footerLines(inspector, safeWidth, now);
  const bodyHeight = Math.max(1, safeHeight - 1 - footers.length);

  let body;
  if (inspector.mode === "help") {
    body = renderHelp();
  } else if (inspector.mode === "detail") {
    body = detailLines(inspector, safeWidth, bodyHeight);
  } else {
    body = listLines(inspector, safeWidth, bodyHeight);
  }

  const lines = [header, ...body.slice(0, bodyHeight)];
  while (lines.length < safeHeight - footers.length) lines.push("");
  lines.push(...footers);

  return lines
    .slice(0, safeHeight)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

export function createTui({
  baseUrl,
  wsUrl,
  target = "",
  maxEvents = 500,
  input = process.stdin,
  output = process.stdout,
  onQuit = null,
  log = null,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = WebSocket,
} = {}) {
  const inspector = new Inspector({ target, maxEvents });
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let statusTimer = null;
  let escapeTimer = null;
  let pendingInput = "";
  let lastQuit = false;

  const width = () => output.columns || 100;
  const height = () => output.rows || 30;

  function draw() {
    if (stopped) return;
    output.write(`${CLEAR}${renderScreen(inspector, { width: width(), height: height() })}`);
  }

  function scheduleStatusRedraw() {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      draw();
    }, STATUS_MS + 250);
    if (statusTimer.unref) statusTimer.unref();
  }

  function setStatus(message) {
    inspector.setStatus(message);
    scheduleStatusRedraw();
    draw();
  }

  async function api(path, options = {}) {
    const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
    const response = await fetchImpl(url, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const message =
        payload && payload.error ? payload.error : `request failed with ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  async function openSelected() {
    const current = inspector.current();
    if (!current) {
      setStatus("no event selected");
      return;
    }
    inspector.open(current);
    draw();
    try {
      const full = await api(`/api/events/${encodeURIComponent(current.id)}`);
      if (inspector.detail && inspector.detail.id === current.id) {
        inspector.detail = full;
        draw();
      }
    } catch (error) {
      setStatus(`could not load ${current.id}: ${error.message}`);
    }
  }

  async function replaySelected() {
    const current = inspector.detail && inspector.mode === "detail" ? inspector.detail : inspector.current();
    if (!current) {
      setStatus("no event selected");
      return;
    }
    if (!inspector.target) {
      setStatus("no replay target, start with --forward URL");
      return;
    }
    setStatus(`replaying ${current.id}...`);
    try {
      const result = await api(`/api/events/${encodeURIComponent(current.id)}/replay`, {
        method: "POST",
        body: "{}",
      });
      inspector.applyMessage({
        type: "replay",
        id: current.id,
        result,
      });
      setStatus(
        result.ok
          ? `replayed ${current.id} -> ${result.status} in ${result.durationMs}ms`
          : `replay failed: ${result.error || result.status}`,
      );
    } catch (error) {
      setStatus(`replay failed: ${error.message}`);
    }
  }

  async function deleteSelected() {
    const current = inspector.current();
    if (!current) {
      setStatus("no event selected");
      return;
    }
    try {
      await api(`/api/events/${encodeURIComponent(current.id)}`, { method: "DELETE" });
      inspector.removeLocal(current.id);
      setStatus(`deleted ${current.id}`);
    } catch (error) {
      setStatus(`delete failed: ${error.message}`);
    }
  }

  async function clearAll() {
    try {
      const result = await api("/api/events", { method: "DELETE" });
      inspector.applyMessage({ type: "clear" });
      inspector.events = [];
      setStatus(`cleared ${result && result.cleared !== undefined ? result.cleared : 0} events`);
    } catch (error) {
      setStatus(`clear failed: ${error.message}`);
    }
  }

  function handleKey(key) {
    if (key === "quit") {
      requestQuit();
      return;
    }
    if (key === "redraw") {
      draw();
      return;
    }
    if (inspector.mode === "help") {
      if (key === "escape" || key === "char:?" || key === "char:q") {
        if (key === "char:q") {
          requestQuit();
          return;
        }
        inspector.toggleHelp();
        draw();
      }
      return;
    }

    switch (key) {
      case "up":
      case "char:k":
        inspector.move(-1);
        draw();
        break;
      case "down":
      case "char:j":
        inspector.move(1);
        draw();
        break;
      case "pageup":
        inspector.move(-1, 10);
        draw();
        break;
      case "pagedown":
        inspector.move(1, 10);
        draw();
        break;
      case "home":
      case "char:g":
        inspector.home();
        draw();
        break;
      case "end":
      case "char:G":
        inspector.end();
        draw();
        break;
      case "enter":
        openSelected();
        break;
      case "escape":
      case "left":
        if (inspector.mode === "detail") {
          inspector.back();
          draw();
        }
        break;
      case "char:r":
        replaySelected();
        break;
      case "char:d":
        deleteSelected();
        break;
      case "char:c":
        if (inspector.armClear()) {
          clearAll();
        } else {
          draw();
        }
        break;
      case "char:p":
        inspector.togglePause();
        draw();
        break;
      case "char:?":
        inspector.toggleHelp();
        draw();
        break;
      case "char:q":
        requestQuit();
        break;
      default:
        break;
    }
  }

  function onData(chunk) {
    pendingInput += String(chunk);
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }

    if (pendingInput === "\x1b") {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        const keys = parseKeys(pendingInput);
        pendingInput = "";
        for (const key of keys) handleKey(key);
      }, 40);
      if (escapeTimer.unref) escapeTimer.unref();
      return;
    }

    const keys = parseKeys(pendingInput);
    pendingInput = "";
    for (const key of keys) handleKey(key);
  }

  function connect() {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (error) {
      inspector.connected = false;
      setStatus(`stream error: ${error.message}`);
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.on("open", () => {
      inspector.connected = true;
      if (ws !== socket) return;
      draw();
    });
    ws.on("message", (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      const action = inspector.applyMessage(message);
      if (action === "event") {
        draw();
      } else if (action === "replay") {
        scheduleStatusRedraw();
        draw();
      } else if (action && action !== "paused" && action !== "updated") {
        draw();
      }
    });
    ws.on("close", () => {
      if (ws !== socket) return;
      inspector.connected = false;
      if (!stopped) {
        draw();
        scheduleReconnect();
      }
    });
    ws.on("error", () => {
      if (ws !== socket) return;
      inspector.connected = false;
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function requestQuit() {
    if (lastQuit) return;
    lastQuit = true;
    stop();
    if (onQuit) onQuit();
  }

  function onResize() {
    draw();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    if (statusTimer) clearTimeout(statusTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    escapeTimer = null;
    statusTimer = null;
    reconnectTimer = null;
    input.removeListener("data", onData);
    output.removeListener("resize", onResize);
    try {
      if (input.isTTY && input.setRawMode) input.setRawMode(false);
      input.pause();
    } catch {
      // The input stream may already be closed.
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore a socket that is already gone.
      }
      socket = null;
    }
    output.write(`${ESC}?25h${ESC}?1049l`);
    if (log) log("tui stopped");
  }

  function start() {
    output.write(`${ESC}?1049h${ESC}?25l`);
    if (input.setRawMode) input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", onData);
    output.on("resize", onResize);
    draw();
    connect();
    return { stop, inspector, redraw: draw };
  }

  return { start, stop, inspector, redraw: draw, setStatus };
}
