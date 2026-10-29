export function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatClock(iso) {
  if (iso === null || iso === undefined || iso === "") return "--:--:--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toTimeString().slice(0, 8);
}

export function truncate(text, width) {
  const value = String(text ?? "");
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) return "";
  if (value.length <= limit) return value;
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3)}...`;
}

export function eventRow(event, { width = 100, selected = false } = {}) {
  const marker = selected ? ">" : " ";
  const id = truncate(event.id, 12).padEnd(12);
  const time = formatClock(event.receivedAt).padEnd(8);
  const method = truncate(event.method, 6).padEnd(6);
  const size = formatBytes(event.size).padStart(9);
  let status = "----";
  if (event.forwardError) status = "err";
  else if (event.forwardStatus) status = String(event.forwardStatus);
  const forward = status.padStart(4);
  const fixed = 2 + 12 + 1 + 8 + 1 + 6 + 1 + 1 + 9 + 1 + 4;
  const pathWidth = Math.max(10, width - fixed);
  const path = truncate(event.path, pathWidth).padEnd(pathWidth);
  return `${marker} ${id} ${time} ${method} ${path} ${size} ${forward}`;
}

export function prettyBody(event) {
  if (!event) return "";
  if (event.binary) {
    return `<binary body, ${formatBytes(event.size)}>`;
  }
  const text = String(event.body || "");
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function wrapText(text, width) {
  const limit = Math.max(1, Math.floor(width));
  const lines = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (rawLine.length <= limit) {
      lines.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > limit) {
      let cut = remaining.lastIndexOf(" ", limit);
      if (cut < Math.floor(limit / 2)) cut = limit;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).replace(/^ /, "");
    }
    lines.push(remaining);
  }
  return lines;
}

export function renderDetail(event, { width = 100, height = 30, scroll = 0 } = {}) {
  if (!event) return ["No event selected."];
  const lines = [];
  lines.push(`${event.id}  ${event.method} ${event.path}`);
  const received = event.receivedAt ? event.receivedAt.replace("T", " ").replace(/\.\d+Z$/, "Z") : "";
  lines.push(`${received}  ${formatBytes(event.size)}  ${event.contentType || "unknown type"}`);
  if (event.remoteAddress) lines.push(`from ${event.remoteAddress}`);
  if (event.forward) {
    const outcome = event.forward.error
      ? `error: ${event.forward.error}`
      : `status ${event.forward.status} in ${event.forward.durationMs}ms`;
    lines.push(`forwarded: ${outcome}`);
  }
  if (event.replayed) {
    lines.push(`replayed ${event.replayed} time${event.replayed === 1 ? "" : "s"}`);
  }
  lines.push("", "Headers:", "");
  const names = Object.keys(event.headers || {}).sort();
  if (names.length === 0) lines.push("  none");
  for (const name of names) {
    lines.push(`  ${name}: ${event.headers[name]}`);
  }
  lines.push("", "Body:", "");
  const body = prettyBody(event);
  if (!body) {
    lines.push("  empty");
  } else {
    for (const line of body.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  }

  const wrapped = [];
  for (const line of lines) {
    for (const part of wrapText(line, width)) wrapped.push(part);
  }
  const visible = Math.max(1, height);
  const start = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - visible)));
  return wrapped.slice(start, start + visible);
}

export function renderHelp() {
  return [
    "Keys",
    "",
    "  j, down      next event",
    "  k, up        previous event",
    "  g, G         first or last event",
    "  enter        open the event",
    "  esc          back to the list",
    "  r            replay to the configured target",
    "  d            delete the selected event",
    "  c            clear all events, press twice",
    "  p            pause or resume the live stream",
    "  ?            toggle this help",
    "  q            quit",
    "",
    "The list updates while the server receives webhooks.",
    "Replay sends the stored method, headers, and body to the target.",
  ];
}
