const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

const NO_BODY_METHODS = new Set(["GET", "HEAD"]);

export function filterHeaders(headers = {}) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name).toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key.startsWith("sec-websocket")) continue;
    output[name] = value;
  }
  return output;
}

export function eventBodyBuffer(event) {
  if (!event || !event.body) return undefined;
  if (event.encoding === "base64") {
    return Buffer.from(event.body, "base64");
  }
  return Buffer.from(event.body, "utf8");
}

export async function replayEvent(
  event,
  {
    target,
    timeoutMs = 10000,
    headers = {},
    fetchImpl = globalThis.fetch,
  } = {},
) {
  if (!target) {
    return {
      ok: false,
      status: 0,
      durationMs: 0,
      headers: {},
      bodyBuffer: Buffer.alloc(0),
      bodyPreview: "",
      error: "no replay target",
    };
  }

  const method = String(event.method || "POST").toUpperCase();
  const body = NO_BODY_METHODS.has(method) ? undefined : eventBodyBuffer(event);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const started = performance.now();

  try {
    const response = await fetchImpl(target, {
      method,
      headers: { ...filterHeaders(event.headers), ...headers },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      headers: Object.fromEntries(response.headers.entries()),
      bodyBuffer: buffer,
      bodyPreview: buffer.toString("utf8").slice(0, 2000),
      error: null,
    };
  } catch (error) {
    const message =
      error && error.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : error && error.message
          ? error.message
          : String(error);
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      bodyBuffer: Buffer.alloc(0),
      bodyPreview: "",
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function replayPayload(result) {
  return {
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error,
    bodyPreview: result.bodyPreview,
  };
}
