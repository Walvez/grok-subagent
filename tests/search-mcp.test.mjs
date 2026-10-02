import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "plugins/grok-subagent/mcp-server/server.mjs");

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function until(check, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for fixture state.");
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolvePromise, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isGone(pid) {
  try { process.kill(pid, 0); }
  catch (error) { return error.code === "ESRCH"; }
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return !status || status.startsWith("Z");
}

function startServer(home, grokBin, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      GROK_BIN: grokBin,
      LANG: process.env.LANG || "C.UTF-8",
      ...extraEnv
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  const stderr = [];
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  child.stderr.on("data", chunk => stderr.push(chunk));
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    const response = new Promise((resolvePromise, rejectPromise) => {
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  const exited = new Promise(resolvePromise => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  return { child, request, exited };
}

function makeHangingGrok(directory) {
  const receipt = join(directory, "pids.json");
  const grokBin = join(directory, "fake-grok");
  const source = `#!/usr/bin/env python3\nimport json, os, subprocess, sys, time\nfrom pathlib import Path\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nPath(${JSON.stringify(receipt)}).write_text(json.dumps({'cli': os.getpid(), 'grandchild': child.pid}))\ntime.sleep(60)\n`;
  writeFileSync(grokBin, source, { mode: 0o700 });
  return { grokBin, receipt };
}

function makeSuccessfulGrok(directory, markdown, environmentReceipt) {
  const grokBin = join(directory, "fake-grok");
  const envelope = JSON.stringify({ text: markdown, stopReason: "end_turn", modelUsage: { "grok-test": {} } });
  const source = `#!/usr/bin/env python3\nimport os\nfrom pathlib import Path\nPath(${JSON.stringify(environmentReceipt)}).write_text(os.environ.get('GROK_HOME', ''))\nprint(${JSON.stringify(envelope)})\n`;
  writeFileSync(grokBin, source, { mode: 0o700 });
  return grokBin;
}

async function exerciseShutdown(mode) {
  const temporary = mkdtempSync(join(tmpdir(), "grok-search-mcp-"));
  const { grokBin, receipt } = makeHangingGrok(temporary);
  const client = startServer(temporary, grokBin);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "search-contract-test", version: "1" }
    });
    assert.equal(initialized.serverInfo.version, "0.4.2");

    const search = client.request("tools/call", {
      name: "grok_search",
      arguments: { query: "fixture request", timeout_seconds: 30 }
    });
    search.catch(() => {});
    await until(() => existsSync(receipt));

    const ping = await within(client.request("ping"), 1_000, "MCP ping was blocked by grok_search.");
    assert.deepEqual(ping, {});

    if (mode === "stdin") client.child.stdin.end();
    else client.child.kill("SIGTERM");
    const exit = await within(client.exited, 10_000, "MCP server did not finish bounded shutdown.");
    assert.equal(exit.signal, null, exit.stderr);
    assert.equal(exit.code, mode === "stdin" ? 0 : 143, exit.stderr);

    const pids = Object.values(JSON.parse(readFileSync(receipt, "utf8")));
    await until(() => pids.every(isGone), 4_000);
    assert(pids.every(isGone), `orphaned fixture processes: ${pids.join(", ")}`);

    const runRoot = join(temporary, ".cache/grok-subagent/search-runs");
    const runIds = readdirSync(runRoot);
    assert.equal(runIds.length, 1);
    const manifest = JSON.parse(readFileSync(join(runRoot, runIds[0], "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.error, "interrupted");
  } finally {
    if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL");
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("grok_search keeps MCP responsive and cleans descendants when stdin closes", { timeout: 20_000 }, async () => {
  await exerciseShutdown("stdin");
});

test("grok_search cleans descendants when the MCP server receives SIGTERM", { timeout: 20_000 }, async () => {
  await exerciseShutdown("signal");
});

test("MCP search and show preserve a verified Markdown result", { timeout: 10_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "grok-search-mcp-success-"));
  const markdown = "  exact markdown\n```json\n{\"inside\": true}\n```\n";
  const environmentReceipt = join(temporary, "grok-home.txt");
  const grokHome = join(temporary, "native-grok-home");
  const client = startServer(
    temporary,
    makeSuccessfulGrok(temporary, markdown, environmentReceipt),
    { GROK_HOME: grokHome }
  );
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "search-contract-test", version: "1" }
    });
    const called = await client.request("tools/call", {
      name: "grok_search",
      arguments: { query: "fixture request", model: "grok-test", max_turns: 2, timeout_seconds: 30 }
    });
    assert.equal(called.isError, false);
    const outcome = JSON.parse(called.content[0].text);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result, markdown);
    assert.equal(outcome.diagnostics.requested_model, "grok-test");
    assert.equal(readFileSync(environmentReceipt, "utf8"), grokHome);

    const shownCall = await client.request("tools/call", {
      name: "grok_search_show",
      arguments: { run_id: outcome.run_id }
    });
    assert.equal(shownCall.isError, false);
    const shown = JSON.parse(shownCall.content[0].text);
    assert.equal(shown.ok, true);
    assert.equal(shown.result, markdown);
    assert.deepEqual(shown.diagnostics, outcome.diagnostics);

    client.child.stdin.end();
    const exit = await within(client.exited, 5_000, "MCP server did not exit after stdin close.");
    assert.equal(exit.code, 0, exit.stderr);
  } finally {
    if (client.child.exitCode === null && client.child.signalCode === null) client.child.kill("SIGKILL");
    rmSync(temporary, { recursive: true, force: true });
  }
});
