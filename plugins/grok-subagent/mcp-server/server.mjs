#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.1.0";
const MAX_AGENTS = 3;
const MAX_TEXT = 120_000;
const MAX_STDERR = 12_000;
const agents = new Map();

const TOOL_DEFINITIONS = [
  {
    name: "grok_spawn_readonly",
    description: "Start an authenticated Grok Build agent in an OS-enforced read-only sandbox. Returns immediately after ACP setup while the prompt runs in the background.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Bounded task and expected output." },
        cwd: { type: "string", description: "Absolute project directory Grok may inspect." },
        role: { type: "string", description: "Short specialist role, such as reviewer or investigator." },
        model: { type: "string", description: "Optional Grok Build model ID. Defaults to GROK_MODEL or grok-4.5." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 }
      },
      required: ["task", "cwd"],
      additionalProperties: false
    },
    annotations: { title: "Start read-only Grok agent", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_spawn_worker",
    description: "Start Grok Build with workspace write access, but only inside a linked Git worktree. Requires explicit confirmation of write scope.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Bounded implementation task and verification requirements." },
        worktree: { type: "string", description: "Absolute path to a linked Git worktree; primary checkouts are rejected." },
        confirm_write_scope: { type: "boolean", description: "Must be true after the user explicitly authorizes Grok to edit this worktree." },
        role: { type: "string", description: "Short specialist role." },
        model: { type: "string", description: "Optional Grok Build model ID. Defaults to GROK_MODEL or grok-4.5." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 900 }
      },
      required: ["task", "worktree", "confirm_write_scope"],
      additionalProperties: false
    },
    annotations: { title: "Start isolated Grok worker", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_status",
    description: "Inspect one Grok agent's lifecycle, recent plan, and bounded tool activity without waiting.",
    inputSchema: objectWithAgentId(),
    annotations: readOnlyAnnotations("Inspect Grok agent")
  },
  {
    name: "grok_result",
    description: "Get a Grok agent's accumulated public answer. Optionally wait briefly for the current turn to finish.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Read Grok result")
  },
  {
    name: "grok_send",
    description: "Send a focused follow-up prompt to an idle Grok agent in the same ACP session.",
    inputSchema: {
      type: "object",
      properties: { agent_id: { type: "string" }, message: { type: "string" }, timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 } },
      required: ["agent_id", "message"],
      additionalProperties: false
    },
    annotations: { title: "Follow up with Grok", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_cancel",
    description: "Cancel the active turn for a Grok agent while keeping its ACP session available.",
    inputSchema: objectWithAgentId(),
    annotations: { title: "Cancel Grok turn", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "grok_close",
    description: "Terminate a Grok agent process and remove it from the bridge.",
    inputSchema: objectWithAgentId(),
    annotations: { title: "Close Grok agent", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "grok_list",
    description: "List all Grok agents currently owned by this bridge process.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations("List Grok agents")
  }
];

function objectWithAgentId() {
  return { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"], additionalProperties: false };
}

function readOnlyAnnotations(title) {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
}

function clamp(value, min, max, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]");
}

function appendBounded(current, addition, max = MAX_TEXT) {
  const combined = current + cleanText(addition);
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function absoluteDirectory(input, label) {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${label} is required.`);
  if (!isAbsolute(input)) throw new Error(`${label} must be an absolute path.`);
  const path = resolve(input);
  accessSync(path, constants.R_OK);
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return path;
}

function assertLinkedWorktree(input) {
  const path = absoluteDirectory(input, "worktree");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error("Writing agents require a valid Git linked worktree.");
  if (resolve(probe.stdout.trim()) !== path) throw new Error("worktree must be the root of the linked Git worktree.");
  let marker;
  try { marker = lstatSync(join(path, ".git")); } catch { throw new Error("Writing agents require a linked Git worktree with a .git file."); }
  if (!marker.isFile()) throw new Error("Primary checkouts are rejected. Create a linked Git worktree, whose .git entry is a file.");
  return path;
}

function findGrok() {
  const candidates = [process.env.GROK_BIN, join(homedir(), ".grok", "bin", "grok"), "grok"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Grok CLI was not found. Install and authenticate Grok Build first.");
}

class GrokAgent {
  constructor({ cwd, mode, role, model, timeoutSeconds }) {
    this.id = randomUUID();
    this.cwd = cwd;
    this.mode = mode;
    this.role = cleanText(role || (mode === "readonly" ? "independent investigator" : "isolated implementation worker"));
    this.model = model || process.env.GROK_MODEL || "grok-4.5";
    this.timeoutSeconds = timeoutSeconds;
    this.status = "starting";
    this.sessionId = null;
    this.text = "";
    this.stderr = "";
    this.plan = null;
    this.toolEvents = [];
    this.error = null;
    this.startedAt = new Date().toISOString();
    this.updatedAt = this.startedAt;
    this.requestId = 0;
    this.pending = new Map();
    this.turnPromise = null;
    this.closed = false;
  }

  async start() {
    const binary = findGrok();
    const sandbox = this.mode === "readonly" ? "read-only" : "workspace";
    const args = ["--no-auto-update", "--sandbox", sandbox, "agent", "--model", this.model, "--always-approve", "--no-leader", "stdio"];
    this.proc = spawn(binary, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", chunk => { this.stderr = appendBounded(this.stderr, chunk, MAX_STDERR); });
    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
    this.proc.on("error", error => this.fail(error));
    const lines = createInterface({ input: this.proc.stdout });
    lines.on("line", line => this.onLine(line));

    const initialized = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    const methods = initialized?.authMethods || [];
    if (methods.some(method => method.id === "cached_token")) {
      await this.request("authenticate", { methodId: "cached_token" }, 30_000);
    }
    const rules = [
      `You are acting as a ${this.role} under Codex orchestration.`,
      "Do not spawn or delegate to other agents.",
      "Do not expose private chain-of-thought; provide concise conclusions and verifiable evidence.",
      this.mode === "readonly"
        ? "This session is read-only. Do not attempt to modify project files."
        : "Modify only the requested files inside this isolated linked worktree. Do not commit, push, merge, or alter other worktrees."
    ].join("\n");
    const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [], _meta: { rules } }, 30_000);
    if (!session?.sessionId) throw new Error("Grok ACP did not return a sessionId.");
    this.sessionId = session.sessionId;
    this.status = "idle";
    this.touch();
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error("Grok process is not available."));
    const id = ++this.requestId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message) {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(cleanText(message.error.message || JSON.stringify(message.error))));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "session/update" || message.method === "x.ai/session/update") {
      this.consumeUpdate(message.params?.update || message.params);
      return;
    }
    if (Object.hasOwn(message, "id") && message.method) this.handleAgentRequest(message);
  }

  handleAgentRequest(message) {
    const options = message.params?.options || [];
    const allowed = options.find(option => ["allow_once", "allow", "approved"].includes(option.kind)) || options[0];
    if (message.method.includes("permission") && allowed) {
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allowed.optionId } } });
    } else {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
    }
  }

  consumeUpdate(update) {
    if (!update || typeof update !== "object") return;
    this.touch();
    if (update.sessionUpdate === "agent_message_chunk") {
      this.text = appendBounded(this.text, update.content?.text || "");
    } else if (update.sessionUpdate === "plan") {
      this.plan = sanitizePlan(update);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.toolEvents.push({
        type: update.sessionUpdate,
        title: cleanText(update.title || update.kind || "tool"),
        status: cleanText(update.status || "unknown")
      });
      this.toolEvents = this.toolEvents.slice(-20);
    }
  }

  runTurn(prompt, timeoutSeconds = this.timeoutSeconds) {
    if (this.status !== "idle" && this.status !== "completed") throw new Error(`Agent is ${this.status}; wait or cancel before sending another prompt.`);
    this.status = "running";
    this.error = null;
    this.touch();
    const boundedTimeout = clamp(timeoutSeconds, 30, 1800, this.timeoutSeconds) * 1000;
    this.turnPromise = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: cleanText(prompt) }]
    }, boundedTimeout).then(result => {
      this.status = "completed";
      this.touch();
      return result;
    }).catch(error => {
      if (this.status !== "cancelled") this.fail(error);
      throw error;
    });
    this.turnPromise.catch(() => {});
    return this.turnPromise;
  }

  cancel() {
    if (!this.sessionId || this.closed) return false;
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.status = "cancelled";
    this.touch();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.status = "closed";
    this.touch();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Grok agent closed."));
    }
    this.pending.clear();
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      setTimeout(() => { if (this.proc?.exitCode === null) this.proc.kill("SIGKILL"); }, 1500).unref();
    }
  }

  onExit(code, signal) {
    if (this.closed) return;
    const reason = `Grok process exited (${signal || code}).`;
    this.fail(new Error(reason));
  }

  fail(error) {
    this.error = cleanText(error?.message || error);
    if (this.stderr.trim()) this.error += `\n${cleanText(this.stderr.trim()).slice(-2000)}`;
    this.status = "failed";
    this.touch();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.error));
    }
    this.pending.clear();
  }

  touch() { this.updatedAt = new Date().toISOString(); }

  summary(includeText = false) {
    const result = {
      agent_id: this.id,
      status: this.status,
      mode: this.mode,
      role: this.role,
      model: this.model,
      cwd: this.cwd,
      started_at: this.startedAt,
      updated_at: this.updatedAt,
      plan: this.plan,
      recent_tools: this.toolEvents,
      error: this.error
    };
    if (includeText) result.response = this.text;
    else result.response_chars = this.text.length;
    return result;
  }
}

function sanitizePlan(update) {
  const entries = update.entries || update.plan || [];
  if (!Array.isArray(entries)) return cleanText(JSON.stringify(entries)).slice(0, 6000);
  return entries.slice(0, 30).map(entry => ({ content: cleanText(entry.content || entry.text || entry.title || ""), status: cleanText(entry.status || "pending") }));
}

function getAgent(id) {
  const agent = agents.get(id);
  if (!agent) throw new Error(`Unknown Grok agent: ${id}`);
  return agent;
}

async function spawnAgent(args, mode) {
  if (agents.size >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} Grok agents may be open. Close one first.`);
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  const cwd = mode === "readonly" ? absoluteDirectory(args.cwd, "cwd") : assertLinkedWorktree(args.worktree);
  if (mode === "worker" && args.confirm_write_scope !== true) throw new Error("confirm_write_scope must be true after explicit user authorization.");
  const agent = new GrokAgent({
    cwd,
    mode,
    role: args.role,
    model: args.model,
    timeoutSeconds: clamp(args.timeout_seconds, 30, 1800, mode === "readonly" ? 600 : 900)
  });
  agents.set(agent.id, agent);
  try {
    await agent.start();
    agent.runTurn(args.task);
  } catch (error) {
    agent.close();
    agents.delete(agent.id);
    throw error;
  }
  return agent.summary(false);
}

async function waitForAgent(agent, seconds) {
  const deadline = Date.now() + clamp(seconds, 0, 30, 0) * 1000;
  while (agent.status === "running" && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
}

async function callTool(name, args = {}) {
  switch (name) {
    case "grok_spawn_readonly": return spawnAgent(args, "readonly");
    case "grok_spawn_worker": return spawnAgent(args, "worker");
    case "grok_status": return getAgent(args.agent_id).summary(false);
    case "grok_result": {
      const agent = getAgent(args.agent_id);
      await waitForAgent(agent, args.wait_seconds);
      return agent.summary(true);
    }
    case "grok_send": {
      const agent = getAgent(args.agent_id);
      agent.runTurn(args.message, clamp(args.timeout_seconds, 30, 1800, 600));
      return agent.summary(false);
    }
    case "grok_cancel": {
      const agent = getAgent(args.agent_id);
      return { agent_id: agent.id, cancelled: agent.cancel(), status: agent.status };
    }
    case "grok_close": {
      const agent = getAgent(args.agent_id);
      agent.close();
      agents.delete(agent.id);
      return { agent_id: agent.id, closed: true };
    }
    case "grok_list": return { agents: [...agents.values()].map(agent => agent.summary(false)) };
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function sendMcp(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const input = createInterface({ input: process.stdin });
input.on("line", async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(request, "id")) return;
  try {
    let result;
    if (request.method === "initialize") {
      result = {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "grok-subagent", version: VERSION }
      };
    } else if (request.method === "ping") {
      result = {};
    } else if (request.method === "tools/list") {
      result = { tools: TOOL_DEFINITIONS };
    } else if (request.method === "tools/call") {
      try { result = textResult(await callTool(request.params?.name, request.params?.arguments || {})); }
      catch (error) { result = textResult({ error: cleanText(error?.message || error) }, true); }
    } else {
      sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    sendMcp({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    sendMcp({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cleanText(error?.message || error) } });
  }
});

function shutdown() {
  for (const agent of agents.values()) agent.close();
  agents.clear();
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
process.on("exit", shutdown);
