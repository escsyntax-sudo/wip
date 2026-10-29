# WIP

Webhook Inspector Proxy. A local server that accepts any webhook a provider can send, keeps the raw request, shows it in a terminal UI, and sends it back out on demand.

Point a provider at `http://localhost:4242/anything`, watch the request arrive, then replay it to your real handler as many times as you need. Everything runs on your machine and needs no account.

```
$ wip --forward http://localhost:3000/webhooks
wip 0.1.0
Listening on http://127.0.0.1:4242
Forwarding to http://localhost:3000/webhooks
Keeping 500 events, body limit 2.0 MB
Loaded 3 saved events
Send webhooks to http://127.0.0.1:4242/any/path
Press Ctrl+C to stop.

[12:04:11] POST /stripe/events  evt_9f2a41c3  412 B
[12:04:11] POST /github/push    evt_71b0cc22  1.8 KB
```

## Why

Webhook providers are awkward to test. The provider sends once, your handler crashes, and the payload is gone. WIP sits in between: it answers the provider immediately, stores the request, and lets you repeat it until the handler is right.

It is deliberately small. Fastify for the HTTP server, `@fastify/websocket` for the live stream, and a hand written terminal UI with no rendering dependency.

## Requirements

Node.js 18 or newer. No external services.

## Install

```sh
npm install -g .
```

Or run it from the checkout:

```sh
node bin/wip.js --help
```

## Quick start

Start the inspector and forward to a handler:

```sh
wip --port 4242 --forward http://localhost:3000/webhooks
```

Send a test request:

```sh
curl -X POST http://localhost:4242/stripe/events \
  -H "content-type: application/json" \
  -d '{"type":"invoice.paid","amount":1200}'
```

The request appears in the terminal and is forwarded to the target. Press `r` on a selected event to send it again.

Without `--forward`, requests are only stored:

```sh
wip
```

List what has been captured from another shell:

```sh
wip list --limit 20
wip replay evt_9f2a41c3 --target http://localhost:3000/webhooks
wip clear
```

## Terminal UI

The UI opens automatically when stdout is a terminal. Use `--no-tui` for plain log lines, which is what you want under Docker, tmux piping, or CI.

| Key | Action |
| --- | --- |
| `j`, `down` | Next event. |
| `k`, `up` | Previous event. |
| `g`, `G` | Jump to the first or last event. |
| `enter` | Open the event: headers, query, pretty printed JSON body, forward result, replay history. |
| `esc` | Back to the list. |
| `r` | Replay the selected event to the configured target. |
| `d` | Delete the selected event. |
| `c` | Clear every event. Press twice. |
| `p` | Pause or resume the live stream. Capture continues while paused. |
| `?` | Toggle help. |
| `q` | Quit. |

Replay works while the live stream is paused, and the list keeps updating as events arrive.

## Capture

Every method and path is accepted. Three paths belong to the inspector and are never captured:

- `/stream` is the WebSocket feed.
- Anything under `/api/` is the JSON API.
- `/health` reports uptime and the current target.

A captured event keeps:

- method, path and query string
- every request header, including signature headers
- the raw body, as UTF-8 text or base64 when the body contains a null byte
- byte size, remote address and receive time
- the forward result: status, duration, or the error that stopped it

Bodies are buffered up to `--max-body`, which defaults to 2 MB and accepts sizes such as `512kb` or `16mb`.

## Forwarding and replay

`--forward URL` sends each captured request to that exact URL and returns the upstream response to the original caller, including status code and headers. The captured path is not appended to the target, so one inspector can forward `/stripe/events` and `/github/push` to a single handler and let the body decide what to do.

Hop by hop headers are removed before forwarding: `host`, `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `te`, `trailer`, `upgrade`, `expect`, proxy authentication headers, and `sec-websocket-*`. Everything else is passed through, which keeps signatures intact.

Replay sends the stored method, headers and body to the same target. `wip replay --target URL` overrides the target for one call. Bodies for `GET` and `HEAD` events are not sent, matching normal HTTP behaviour.

If forwarding fails, the provider still gets a stored event id and a `502` with the upstream error, so nothing is lost.

## CLI

```
wip [serve] [options]
wip list [options]
wip replay ID [options]
wip clear [options]
wip --help
wip --version
```

`serve` is the default command.

### Serve options

| Option | Default | Meaning |
| --- | --- | --- |
| `--port N` | `4242` | Listen port. `0` picks a free port. |
| `--host HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to accept traffic from other machines. |
| `--forward URL` | none | Forward captured requests here and replay here. |
| `--data FILE` | none | Append events to a JSON Lines file and load it on start. |
| `--max-events N` | `500` | Events kept in memory and on disk. Older events are dropped. |
| `--max-body SIZE` | `2mb` | Largest accepted body. |
| `--timeout MS` | `10000` | Upstream and replay timeout. |
| `--no-tui` | off | Log one line per event instead of opening the UI. |
| `--quiet` | off | Suppress the banner and the request log. |

### Client options

| Option | Default | Meaning |
| --- | --- | --- |
| `--server URL` | `http://127.0.0.1:4242` | Inspector address. |
| `--limit N` | `0` | Maximum events returned by `list`. Zero means all. |
| `--id ID` | none | Event id, as an alternative to the positional argument. |
| `--target URL` | the `--forward` value | Replay destination for one call. |
| `--json` | off | Print JSON instead of text. |

Environment variables: `WIP_SERVER` is used when `--server` is missing, and `WIP_FORWARD` when `--forward` is missing.

## HTTP API

The API is what the CLI and the terminal UI use, so anything the UI can do can be scripted.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Name, version, uptime, stored count, target. |
| `GET` | `/api/events?limit=N` | Newest first. Returns summaries, not bodies. |
| `GET` | `/api/events/:id` | One full event, including headers and body. |
| `DELETE` | `/api/events/:id` | Delete one event. |
| `DELETE` | `/api/events` | Clear every event. Returns the deleted count. |
| `POST` | `/api/events/:id/replay` | Replay. Optional body: `{ "target": "https://..." }`. |
| `WS` | `/stream` | Live feed. First message is `hello` with the stored list, then `event`, `replay`, `delete` and `clear` messages. |

Replay answers with `ok`, `status`, `durationMs`, `bodyPreview`, and `error`.

```sh
curl -s http://localhost:4242/api/events | jq '.events[0]'
curl -s -X POST http://localhost:4242/api/events/evt_9f2a41c3/replay \
  -H "content-type: application/json" \
  -d '{"target":"http://localhost:3000/webhooks"}'
```

## Saved sessions

`--data .wip/events.jsonl` appends every event to a JSON Lines file and reloads it when the process starts again, which is useful when a webhook arrives while you are restarting a handler. A partial last line, the usual result of a hard stop, is ignored.

Deletes and clears rewrite the file, so it always matches memory. The directory is created on demand.

## JavaScript API

```js
import { createServer } from "wip-inspector";

const app = await createServer({
  forward: "http://localhost:3000/webhooks",
  maxEvents: 200,
  dataFile: ".wip/events.jsonl",
});

await app.listen({ port: 4242, host: "127.0.0.1" });
console.log(app.wip.store.list({ limit: 5 }));
```

Useful exports:

| Export | Purpose |
| --- | --- |
| `createServer` | Build a Fastify instance with capture, API and WebSocket routes. |
| `EventStore` | Bounded event store with JSON Lines persistence and subscriptions. |
| `replayEvent` | Send one stored event to a target. |
| `filterHeaders` | Drop hop by hop headers before an outbound request. |
| `formatBytes`, `formatClock`, `truncate`, `prettyBody`, `wrapText` | Text helpers used by the UI. |
| `createTui`, `Inspector`, `parseKeys`, `renderScreen` | Terminal UI. `renderScreen` returns a string, so it can be tested without a terminal. |
| `run`, `parseCommandLine`, `UsageError` | CLI entry points. |

`createServer` accepts `{ store, maxEvents, maxBody, timeoutMs, forward, dataFile, log }`. Passing a store is how the tests drive capture without touching a port.

## Limits

- Events live in memory and, optionally, one JSON Lines file. There is no database.
- Binary bodies are stored as base64 and replayed as bytes, but the UI only shows a size.
- Forwarding does not retry. A failed upstream call returns `502` and the event stays available for replay.
- The inspector trusts its clients. It binds to `127.0.0.1` by default and has no authentication, so do not expose it to the internet.

## Tests

```sh
npm test
```

The suite uses the Node.js test runner and covers the store, replay header filtering, capture and forwarding, the JSON API, the WebSocket feed, key parsing, screen rendering, CLI parsing, exit codes, and replay error paths. Servers in the tests bind to port `0`, so a busy `4242` does not break the run.

## License

MIT. See `LICENSE`.
