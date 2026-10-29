import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { createServer } from "../src/server.js";
import { run } from "../src/cli.js";

const BIN = fileURLToPath(new URL("../bin/wip.js", import.meta.url));

let app;
let address;

function capture() {
  let text = "";
  return {
    isTTY: false,
    columns: 120,
    write(chunk) {
      text += String(chunk);
      return true;
    },
    get text() {
      return text;
    },
  };
}

async function cli(argv, env = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await run(argv, {
    stdout,
    stderr,
    env: { ...process.env, ...env },
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

before(async () => {
  app = await createServer({ log: null });
  address = await app.listen({ port: 0, host: "127.0.0.1" });
});

after(async () => {
  await app.close();
});

test("version and help", async () => {
  const version = await cli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), "wip 0.1.0");

  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /wip replay ID/);

  const helpCommand = await cli(["help"]);
  assert.equal(helpCommand.code, 0);
  assert.match(helpCommand.stdout, /Commands:/);
});

test("unknown commands and options are reported", async () => {
  const unknown = await cli(["wat"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown command/);

  const option = await cli(["--wat"]);
  assert.equal(option.code, 1);
  assert.match(option.stderr, /--wat/);

  const extra = await cli(["list", "extra"]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /unexpected argument/);
});

test("list prints a table", async () => {
  await app.inject({ method: "POST", url: "/cli/table", payload: "hello" });
  const result = await cli(["list", "--server", address]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ID\s+TIME\s+METHOD\s+PATH/);
  assert.match(result.stdout, /\/cli\/table/);
  assert.match(result.stdout, /POST/);
  assert.equal(result.stderr, "");
});

test("list --json prints the payload and honours --limit", async () => {
  await app.inject({ method: "POST", url: "/cli/one", payload: "1" });
  await app.inject({ method: "POST", url: "/cli/two", payload: "2" });
  const result = await cli(["list", "--server", address, "--limit", "1", "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.events.length, 1);
  assert.equal(payload.events[0].path, "/cli/two");
  assert.equal(payload.count, app.wip.store.size);
});

test("list reports an empty store", async () => {
  const empty = await createServer({ log: null });
  const emptyAddress = await empty.listen({ port: 0, host: "127.0.0.1" });
  try {
    const result = await cli(["list", "--server", emptyAddress]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "No events.");
  } finally {
    await empty.close();
  }
});

test("list reports connection errors", async () => {
  const result = await cli(["list", "--server", "http://127.0.0.1:1"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /wip:/);
});

test("replay sends a stored event to --target", async () => {
  const received = [];
  const upstream = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"stored":true}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  try {
    const id = (
      await app.inject({
        method: "POST",
        url: "/cli/replay",
        payload: '{"action":"opened"}',
        headers: { "content-type": "application/json" },
      })
    ).json().id;

    const result = await cli([
      "replay",
      id,
      "--server",
      address,
      "--target",
      `${upstreamUrl}/hooks/replayed`,
      "--json",
    ]);
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, 201);
    assert.equal(payload.id, id);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/hooks/replayed");
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].body, '{"action":"opened"}');
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("replay prints a readable failure", async () => {
  const id = (
    await app.inject({ method: "POST", url: "/cli/fail", payload: "x" })
  ).json().id;
  const result = await cli([
    "replay",
    id,
    "--server",
    address,
    "--target",
    "http://127.0.0.1:1",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Replay failed/);
});

test("replay validates its arguments", async () => {
  const noId = await cli(["replay", "--server", address]);
  assert.equal(noId.code, 1);
  assert.match(noId.stderr, /needs an event id/);

  const badTarget = await cli([
    "replay",
    "evt_1",
    "--server",
    address,
    "--target",
    "file:///etc/passwd",
  ]);
  assert.equal(badTarget.code, 1);
  assert.match(badTarget.stderr, /http or https/);

  const extra = await cli(["replay", "evt_1", "evt_2", "--server", address]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /unexpected argument/);
});

test("replay with --id works and reports a missing event", async () => {
  const id = (
    await app.inject({ method: "POST", url: "/cli/by-id", payload: "x" })
  ).json().id;
  const upstream = createHttpServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const ok = await cli([
      "replay",
      "--id",
      id,
      "--server",
      address,
      "--target",
      `http://127.0.0.1:${upstream.address().port}`,
      "--json",
    ]);
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.stdout).status, 200);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }

  const missing = await cli(["replay", "evt_missing", "--server", address]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /event not found/);
});

test("clear empties the store", async () => {
  await app.inject({ method: "POST", url: "/cli/clear", payload: "x" });
  const result = await cli(["clear", "--server", address]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Cleared \d+ events\./);
  const list = await cli(["list", "--server", address, "--json"]);
  assert.equal(JSON.parse(list.stdout).events.length, 0);
});

test("clear --json prints the result", async () => {
  await app.inject({ method: "POST", url: "/cli/clear-json", payload: "x" });
  const result = await cli(["clear", "--server", address, "--json"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.cleared, "number");
});

test("serve rejects invalid options", async () => {
  const badPort = await cli(["serve", "--port", "70000"]);
  assert.equal(badPort.code, 1);
  assert.match(badPort.stderr, /--port/);

  const badSize = await cli(["serve", "--max-body", "huge"]);
  assert.equal(badSize.code, 1);
  assert.match(badSize.stderr, /--max-body/);

  const badTarget = await cli(["serve", "--forward", "ftp://example.com"]);
  assert.equal(badTarget.code, 1);
  assert.match(badTarget.stderr, /http or https/);

  const extra = await cli(["serve", "extra"]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /unexpected argument/);
});

test("serve captures real HTTP requests", { timeout: 25000 }, async () => {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0", "--no-tui"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const lines = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const reader = createInterface({ input: child.stdout });
  let baseUrl = null;
  try {
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`server did not start: ${lines.join(" | ")} ${stderr}`));
      }, 15000);
      reader.on("line", (line) => {
        lines.push(line);
        const match = /Listening on (http:\/\/[^\s]+)/.exec(line);
        if (match) baseUrl = match[1];
        if (baseUrl && /Press Ctrl\+C to stop\./.test(line)) {
          clearTimeout(timer);
          resolve(baseUrl);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited with ${code}: ${lines.join(" | ")} ${stderr}`));
      });
    });

    assert.match(lines.join("\n"), /wip 0\.1\.0/);
    assert.match(lines.join("\n"), /Send webhooks to/);

    const response = await fetch(`${baseUrl}/spawn/hook?source=test`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "yes" },
      body: '{"hello":"world"}',
    });
    assert.equal(response.status, 200);
    const captured = await response.json();
    assert.match(captured.id, /^evt_/);

    const list = await (await fetch(`${baseUrl}/api/events`)).json();
    assert.equal(list.count, 1);
    assert.equal(list.events[0].path, "/spawn/hook");

    const detail = await (await fetch(`${baseUrl}/api/events/${captured.id}`)).json();
    assert.equal(detail.body, '{"hello":"world"}');
    assert.equal(detail.query, "source=test");
    assert.equal(detail.headers["x-test"], "yes");

    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.status, "ok");
    assert.equal(health.events, 1);

    const cleared = await (await fetch(`${baseUrl}/api/events`, { method: "DELETE" })).json();
    assert.equal(cleared.cleared, 1);
  } finally {
    reader.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", resolve);
    });
  }
});
