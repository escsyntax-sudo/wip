import { parseArgs } from "node:util";

import { formatBytes, formatClock, truncate } from "./format.js";
import { createServer } from "./server.js";
import { createTui } from "./tui.js";
import { VERSION } from "./version.js";

const DEFAULT_PORT = 4242;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SERVER = "http://127.0.0.1:4242";
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 10000;

const COMMANDS = new Set(["serve", "list", "replay", "clear"]);

const HELP = `wip ${VERSION}

Webhook inspector proxy. Captures every request sent to it, shows the raw
payload in a terminal UI or over HTTP, and replays events to a real endpoint.

Usage:
  wip [serve] [options]
  wip list [options]
  wip replay ID [options]
  wip clear [options]
  wip --help
  wip --version

Commands:
  serve     Start the inspector and print events as they arrive. This is the
            default when no command is given.
  list      Print stored events from a running inspector.
  replay    Send one stored event to the replay target.
  clear     Delete every stored event.

Serve options:
  --port N            Port to listen on (default: ${DEFAULT_PORT}, 0 picks a free port).
  --host HOST         Bind address (default: ${DEFAULT_HOST}).
  --forward URL       Forward captured requests to this URL and replay there.
  --data FILE         Append events to a JSON Lines file and load it on start.
  --max-events N      Keep this many events in memory (default: ${DEFAULT_MAX_EVENTS}).
  --max-body SIZE     Largest accepted body, for example 512kb or 2mb (default: 2mb).
  --timeout MS        Upstream and replay timeout (default: ${DEFAULT_TIMEOUT}).
  --no-tui            Log events as lines instead of opening the terminal UI.
  --quiet             Do not print the banner or request log.

Client options:
  --server URL        Inspector address (default: ${DEFAULT_SERVER}).
  --limit N           Maximum events returned by list. Zero means all.
  --id ID             Event id for replay, as an alternative to the argument.
  --target URL        Replay target. Defaults to the inspector --forward value.
  --json              Print JSON instead of text.

Other options:
  --help              Show this help.
  --version           Show the version.

Environment:
  WIP_SERVER          Used when --server is missing.
  WIP_FORWARD         Used when --forward is missing.

Examples:
  wip --port 4242 --forward http://localhost:3000/webhooks
  wip serve --data .wip/events.jsonl --max-events 1000
  wip serve --no-tui --quiet
  wip list --limit 20
  wip replay evt_9f2a41c3 --target http://localhost:3000/webhooks
  wip clear --server http://127.0.0.1:4242
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new UsageError(
      `${label} must be ${allowZero ? "zero or " : "a positive "}integer, got "${value}"`,
    );
  }
  return number;
}

function parseSize(value, label, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i.exec(String(value).trim());
  if (!match) {
    throw new UsageError(`${label} must look like 512kb or 2mb, got "${value}"`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] || "b").toLowerCase();
  const factor = unit === "mb" ? 1024 * 1024 : unit === "kb" ? 1024 : 1;
  const bytes = Math.floor(amount * factor);
  if (bytes < 1) throw new UsageError(`${label} must be at least one byte`);
  return bytes;
}

function validateTarget(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new UsageError(`--target must be an http or https URL, got "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`--target must use http or https, got "${url.protocol}"`);
  }
  return url.toString();
}

function displayHost(host) {
  return host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
}

function websocketUrl(baseUrl) {
  return `${baseUrl.replace(/^http/, "ws")}/stream`;
}

function writeLine(stream, text = "") {
  stream.write(`${text}\n`);
}

async function requestJson(fetchImpl, url, { method = "GET", body = null, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
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
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`request to ${url} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function eventTable(events, columns = 120) {
  const rows = events.map((event) => {
    const status = event.forwardError
      ? "err"
      : event.forwardStatus
        ? String(event.forwardStatus)
        : "-";
    return [
      truncate(event.id, 14),
      formatClock(event.receivedAt),
      truncate(event.method, 7),
      truncate(event.path, Math.max(20, columns - 70)),
      formatBytes(event.size),
      status,
      String(event.replayed || 0),
    ];
  });
  const header = ["ID", "TIME", "METHOD", "PATH", "SIZE", "FWD", "REPLAYS"];
  const widths = [14, 8, 7, 20, 9, 5, 7];
  const line = (cells) =>
    `${cells[0].padEnd(widths[0])} ${cells[1].padEnd(widths[1])} ${cells[2].padEnd(
      widths[2],
    )} ${cells[3].padEnd(widths[3])} ${cells[4].padStart(widths[4])} ${cells[5].padStart(
      widths[5],
    )} ${cells[6].padStart(widths[6])}`.replace(/\s+$/, "");
  return [line(header), "", ...rows.map(line)].join("\n");
}

function printBanner(stdout, { baseUrl, target, maxEvents, maxBody, dataFile, events }) {
  writeLine(stdout, `wip ${VERSION}`);
  writeLine(stdout, `Listening on ${baseUrl}`);
  if (target) {
    writeLine(stdout, `Forwarding to ${target}`);
  } else {
    writeLine(stdout, "Replay target not set, pass --forward URL to enable it");
  }
  writeLine(
    stdout,
    `Keeping ${maxEvents} events, body limit ${formatBytes(maxBody)}${
      dataFile ? `, storing in ${dataFile}` : ""
    }`,
  );
  if (events) writeLine(stdout, `Loaded ${events} saved event${events === 1 ? "" : "s"}`);
  writeLine(stdout, `Send webhooks to ${baseUrl}/any/path`);
  writeLine(stdout, "Press Ctrl+C to stop.");
}

async function commandServe(values, io) {
  const port = positiveInteger(values.port ?? DEFAULT_PORT, "--port", { allowZero: true });
  if (port > 65535) throw new UsageError("--port must be between 0 and 65535");
  const host = values.host || DEFAULT_HOST;
  const maxEvents = positiveInteger(values["max-events"] ?? DEFAULT_MAX_EVENTS, "--max-events");
  const maxBody = parseSize(values["max-body"], "--max-body", DEFAULT_MAX_BODY);
  const timeoutMs = positiveInteger(values.timeout ?? DEFAULT_TIMEOUT, "--timeout");
  const target = validateTarget(values.forward || io.env.WIP_FORWARD || "");
  const dataFile = values.data || "";
  const quiet = Boolean(values.quiet);
  const useTui = !values["no-tui"] && Boolean(io.stdout.isTTY);

  let app;
  try {
    app = await createServer({
      maxEvents,
      maxBody,
      timeoutMs,
      forward: target,
      dataFile,
      log: null,
    });
    await app.listen({ port, host });
  } catch (error) {
    if (app) {
      try {
        await app.close();
      } catch {
        // The server never bound, so there is nothing to close.
      }
    }
    throw new UsageError(
      `could not listen on ${host}:${port}: ${error && error.message ? error.message : error}`,
    );
  }

  const address = app.server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  const baseUrl = `http://${displayHost(host)}:${actualPort}`;
  const loaded = app.wip.store.size;

  let tui = null;
  let stopping = false;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    if (tui) tui.stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      if (timer.unref) timer.unref();
    });
    try {
      await Promise.race([app.close(), timeout]);
    } catch {
      // Closing a server that is already closed is not an error for us.
    }
    resolveClosed(code);
    if (io.exit) {
      io.exit(code);
    } else {
      process.exit(code);
    }
  };

  const onSignal = () => {
    shutdown(0);
  };

  if (useTui) {
    tui = createTui({
      baseUrl,
      wsUrl: websocketUrl(baseUrl),
      target,
      maxEvents,
      input: io.stdin || process.stdin,
      output: io.stdout,
      onQuit: () => shutdown(0),
      fetchImpl: io.fetchImpl || globalThis.fetch,
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    tui.start();
    return closed;
  }

  if (!quiet) {
    printBanner(io.stdout, {
      baseUrl,
      target,
      maxEvents,
      maxBody,
      dataFile,
      events: loaded,
    });
  }

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  app.wip.store.subscribe((message) => {
    if (quiet || message.type !== "event") return;
    const event = message.event;
    writeLine(
      io.stdout,
      `[${formatClock(event.receivedAt)}] ${event.method} ${event.path}  ${event.id}  ${formatBytes(event.size)}`,
    );
  });

  return closed;
}

async function commandList(values, io) {
  const server = values.server || io.env.WIP_SERVER || DEFAULT_SERVER;
  const limit = positiveInteger(values.limit ?? 0, "--limit", { allowZero: true });
  const query = limit > 0 ? `?limit=${limit}` : "";
  const payload = await requestJson(
    io.fetchImpl || globalThis.fetch,
    `${server.replace(/\/+$/, "")}/api/events${query}`,
  );
  if (values.json) {
    writeLine(io.stdout, JSON.stringify(payload, null, 2));
    return 0;
  }
  const events = payload && Array.isArray(payload.events) ? payload.events : [];
  if (events.length === 0) {
    writeLine(io.stdout, "No events.");
    return 0;
  }
  const columns = io.stdout.columns || 120;
  writeLine(io.stdout, eventTable(events, columns));
  return 0;
}

async function commandReplay(values, positionals, io) {
  const server = values.server || io.env.WIP_SERVER || DEFAULT_SERVER;
  const positionalId = positionals[0] || "";
  if (positionalId && values.id && positionalId !== values.id) {
    throw new UsageError("give the event id either as an argument or with --id, not both");
  }
  const id = values.id || positionalId;
  if (!id) throw new UsageError("replay needs an event id, for example: wip replay evt_ab12cd34");
  const target = validateTarget(values.target || "");
  const body = target ? { target } : {};
  const result = await requestJson(
    io.fetchImpl || globalThis.fetch,
    `${server.replace(/\/+$/, "")}/api/events/${encodeURIComponent(id)}/replay`,
    { method: "POST", body },
  );

  if (values.json) {
    writeLine(io.stdout, JSON.stringify(result, null, 2));
  } else if (result.ok) {
    writeLine(
      io.stdout,
      `Replayed ${result.id} -> ${result.status} in ${result.durationMs}ms`,
    );
    if (result.bodyPreview) writeLine(io.stdout, `Response: ${truncate(result.bodyPreview, 500)}`);
  } else {
    writeLine(
      io.stdout,
      `Replay failed for ${result.id}: ${result.error || `status ${result.status}`}`,
    );
  }
  return result.ok ? 0 : 1;
}

async function commandClear(values, io) {
  const server = values.server || io.env.WIP_SERVER || DEFAULT_SERVER;
  const result = await requestJson(
    io.fetchImpl || globalThis.fetch,
    `${server.replace(/\/+$/, "")}/api/events`,
    { method: "DELETE" },
  );
  if (values.json) {
    writeLine(io.stdout, JSON.stringify(result, null, 2));
  } else {
    writeLine(io.stdout, `Cleared ${result && result.cleared !== undefined ? result.cleared : 0} events.`);
  }
  return 0;
}

export function parseCommandLine(argv) {
  let command = "serve";
  let args = [...argv];

  if (args.length > 0 && !args[0].startsWith("-")) {
    if (args[0] === "help") {
      return { command: "help", values: {}, positionals: [] };
    }
    if (!COMMANDS.has(args[0])) {
      throw new UsageError(
        `unknown command "${args[0]}", expected serve, list, replay, or clear`,
      );
    }
    command = args[0];
    args = args.slice(1);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        forward: { type: "string" },
        data: { type: "string" },
        "max-events": { type: "string" },
        "max-body": { type: "string" },
        timeout: { type: "string" },
        "no-tui": { type: "boolean" },
        quiet: { type: "boolean" },
        server: { type: "string" },
        id: { type: "string" },
        target: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }

  return { command, values: parsed.values, positionals: parsed.positionals };
}

export async function run(argv = process.argv.slice(2), io = {}) {
  const streams = {
    stdout: io.stdout || process.stdout,
    stderr: io.stderr || process.stderr,
    stdin: io.stdin || process.stdin,
    env: io.env || process.env,
    fetchImpl: io.fetchImpl || globalThis.fetch,
    exit: io.exit || null,
  };

  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    streams.stderr.write(`wip: ${error.message}\nRun "wip --help" for usage.\n`);
    return 1;
  }

  const { command, values, positionals } = parsed;

  if (values.version) {
    writeLine(streams.stdout, `wip ${VERSION}`);
    return 0;
  }
  if (values.help || command === "help") {
    streams.stdout.write(HELP);
    return 0;
  }

  try {
    if (command === "serve") {
      if (positionals.length > 0) {
        throw new UsageError(`unexpected argument "${positionals[0]}"`);
      }
      return await commandServe(values, streams);
    }
    if (command === "list") {
      if (positionals.length > 0) {
        throw new UsageError(`unexpected argument "${positionals[0]}"`);
      }
      return await commandList(values, streams);
    }
    if (command === "replay") {
      if (positionals.length > 1) {
        throw new UsageError(`unexpected argument "${positionals[1]}"`);
      }
      return await commandReplay(values, positionals, streams);
    }
    if (command === "clear") {
      if (positionals.length > 0) {
        throw new UsageError(`unexpected argument "${positionals[0]}"`);
      }
      return await commandClear(values, streams);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      streams.stderr.write(`wip: ${error.message}\nRun "wip --help" for usage.\n`);
      return 1;
    }
    streams.stderr.write(`wip: ${error && error.message ? error.message : error}\n`);
    return 1;
  }

  streams.stderr.write('wip: missing command\nRun "wip --help" for usage.\n');
  return 1;
}

export async function main(argv = process.argv.slice(2)) {
  const code = await run(argv);
  if (typeof code === "number") process.exitCode = code;
  return code;
}
