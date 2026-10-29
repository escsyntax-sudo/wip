import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { EventStore, looksBinary } from "./store.js";
import { replayEvent, replayPayload } from "./replay.js";
import { VERSION } from "./version.js";

function isApiPath(path) {
  return path === "/api" || path.startsWith("/api/");
}

function responseHeaders(headers = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(key)) {
      continue;
    }
    output[name] = value;
  }
  return output;
}

function validTarget(target) {
  if (!target) return "";
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function parseJsonBuffer(buffer) {
  if (!buffer || buffer.length === 0) return {};
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export async function createServer(options = {}) {
  const startedAt = new Date();
  const store =
    options.store ||
    new EventStore({ maxEvents: options.maxEvents, file: options.dataFile });
  const target = validTarget(options.forward || "");
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10000);
  const log = typeof options.log === "function" ? options.log : null;

  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(1024, Number(options.maxBody) || 2 * 1024 * 1024),
  });

  try {
    app.removeContentTypeParser("application/json");
    app.removeContentTypeParser("text/plain");
  } catch {
    // Older parser configurations may not have these entries.
  }
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  await app.register(websocket);

  const sockets = new Set();
  const broadcast = (message) => {
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === 1) {
        try {
          socket.send(text);
        } catch {
          sockets.delete(socket);
        }
      }
    }
  };

  store.subscribe((message) => broadcast(message));

  app.get("/health", async () => ({
    status: "ok",
    name: "wip",
    version: VERSION,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    events: store.size,
    maxEvents: store.maxEvents,
    target: target || null,
  }));

  app.get("/api/events", async (request) => {
    const limit = Number(request.query && request.query.limit) || 0;
    return {
      target: target || null,
      maxEvents: store.maxEvents,
      count: store.size,
      events: store.list({ limit }),
    };
  });

  app.get("/api/events/:id", async (request, reply) => {
    const event = store.get(request.params.id);
    if (!event) return reply.code(404).send({ error: "event not found" });
    return event;
  });

  app.delete("/api/events/:id", async (request, reply) => {
    const removed = store.remove(request.params.id);
    if (!removed) return reply.code(404).send({ error: "event not found" });
    return { ok: true, id: request.params.id };
  });

  app.delete("/api/events", async () => ({ ok: true, cleared: store.clear() }));

  app.post("/api/events/:id/replay", async (request, reply) => {
    const event = store.get(request.params.id);
    if (!event) return reply.code(404).send({ error: "event not found" });

    const payload = parseJsonBuffer(request.body);
    const requested = payload.target ? validTarget(payload.target) : "";
    if (payload.target && !requested) {
      return reply.code(400).send({ error: "target must be an http or https URL" });
    }
    const destination = requested || target;
    if (!destination) {
      return reply.code(400).send({
        error: "no replay target",
        hint: "start the server with --forward URL or pass a target",
      });
    }

    const result = await replayEvent(event, { target: destination, timeoutMs });
    store.noteReplay(event.id, result);
    const body = replayPayload(result);
    broadcast({
      type: "replay",
      id: event.id,
      target: destination,
      result: body,
    });
    log &&
      log(
        `replay ${event.id} -> ${result.status || "error"} ${result.durationMs}ms${
          result.error ? ` (${result.error})` : ""
        }`,
      );
    return {
      ok: result.ok,
      id: event.id,
      target: destination,
      ...body,
    };
  });

  app.get("/stream", { websocket: true }, (socket) => {
    sockets.add(socket);
    try {
      socket.send(
        JSON.stringify({
          type: "hello",
          version: VERSION,
          target: target || null,
          maxEvents: store.maxEvents,
          events: store.list(),
        }),
      );
    } catch {
      // The client may have gone away already.
    }
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  const capture = async (request, reply) => {
    const url = request.raw.url || "/";
    const path = url.split("?")[0];

    if (path === "/stream" || path === "/health" || isApiPath(path)) {
      return reply.code(404).send({ error: "not found", path });
    }

    const receivedAt = new Date().toISOString();
    const buffer = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(request.body ? String(request.body) : "", "utf8");
    const binary = looksBinary(buffer);
    const contentType = String(request.headers["content-type"] || "");

    const draft = {
      receivedAt,
      method: request.method,
      path,
      query: url.includes("?") ? url.slice(url.indexOf("?") + 1) : "",
      headers: { ...request.headers },
      contentType,
      body: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      size: buffer.length,
      binary,
      truncated: false,
      remoteAddress: request.ip || "",
      forward: null,
    };

    if (target) {
      const result = await replayEvent(
        {
          method: draft.method,
          headers: draft.headers,
          body: draft.body,
          encoding: draft.encoding,
        },
        { target, timeoutMs },
      );
      draft.forward = {
        status: result.status,
        ok: result.ok,
        durationMs: result.durationMs,
        error: result.error,
      };
      const event = store.add(draft);
      log &&
        log(
          `${draft.method} ${path} -> ${result.status || "error"} (${result.durationMs}ms) ${event.id}`,
        );
      if (result.error) {
        return reply.code(502).send({ ok: false, id: event.id, error: result.error });
      }
      reply.code(result.status || 502);
      for (const [name, value] of Object.entries(responseHeaders(result.headers))) {
        reply.header(name, value);
      }
      return reply.send(result.bodyBuffer);
    }

    const event = store.add(draft);
    log && log(`${draft.method} ${path} ${event.id}`);
    return reply.code(200).send({ ok: true, id: event.id });
  };

  app.all("/*", capture);
  app.all("/", capture);

  app.decorate("wip", {
    store,
    target: target || "",
    options: { timeoutMs, maxBody: options.maxBody },
  });

  return app;
}

export { VERSION };
