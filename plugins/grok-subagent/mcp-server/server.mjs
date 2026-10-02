#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.4.2";
const MAX_AGENTS = 3;
const MAX_RETAINED_FAILED_AGENTS = 3;
const MAX_TEXT = 120_000;
const MAX_STDERR = 12_000;
const CANCEL_TIMEOUT_MS = 10_000;
const MAX_SEARCH_BRIDGE_OUTPUT = 16 * 1024 * 1024;
const SEARCH_BRIDGE_GRACE_MS = 5_000;
const SUPPORTED_MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "__CF_USER_TEXT_ENCODING", "XAI_API_KEY"
];
const agents = new Map();
const searchBridges = new Set();
let shutdownPromise = null;

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
    annotations: { title: "Start project-read-only Grok agent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
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
    name: "grok_handoff_interactive",
    description: "Open an independent interactive Grok Build TUI in a new macOS Terminal window. Codex hands off the prompt and does not supervise the session.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Complete task brief that Codex hands to the interactive Grok session." },
        cwd: { type: "string", description: "Absolute project directory. Worktree mode requires the Git repository root." },
        access_mode: { type: "string", enum: ["read_only", "isolated_worktree"], description: "Read-only inspection or edits in a Grok-created linked worktree." },
        confirm_interactive_handoff: { type: "boolean", description: "Must be true after the user explicitly asks to interact directly with Grok in a separate window." },
        role: { type: "string", description: "Optional specialist role included in the handoff prompt." },
        model: { type: "string", description: "Optional Grok Build model ID." }
      },
      required: ["task", "cwd", "access_mode", "confirm_interactive_handoff"],
      additionalProperties: false
    },
    annotations: { title: "Hand off to interactive Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_search",
    description: "Run a checked Grok public-search task from a temporary directory outside the current repository. Tool restrictions reduce local access but are not an OS sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Complete research request in the user's language." },
        platform: { type: "string", enum: ["auto", "x", "reddit", "web"], description: "Search focus hint. Not an exclusion rule. Defaults to auto." },
        depth: { type: "string", enum: ["quick", "deep"], description: "quick returns Grok's answer fast; deep asks Grok to cross-check more carefully. Defaults to quick." },
        since: { type: "string", description: "Optional relative window such as 24h, 7d, 2w, or an ISO-8601 start timestamp." },
        until: { type: "string", description: "Optional ISO-8601 end timestamp. Defaults to now." },
        keep_run: { type: "boolean", description: "Pin this run so cleanup does not delete it." },
        model: { type: "string", description: "Exact Grok model ID. Defaults to grok-4.7. No fallback is used." },
        max_turns: { type: "integer", minimum: 1, default: 6 },
        json_schema: { type: "object", description: "Optional local-only JSON Schema for structured output." },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 180 }
      },
      required: ["query"],
      additionalProperties: false
    },
    annotations: { title: "Search with Grok", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "grok_search_list",
    description: "List retained isolated Grok search runs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnlyAnnotations("List Grok search runs")
  },
  {
    name: "grok_search_show",
    description: "Read the full retained answer from a previous Grok search run.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Search run ID returned by grok_search or grok_search_list." }
      },
      required: ["run_id"],
      additionalProperties: false
    },
    annotations: readOnlyAnnotations("Show Grok search run")
  },
  {
    name: "grok_status",
    description: "Inspect one Grok agent's lifecycle and visible progress. Optionally wait for a newer progress revision.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        after_revision: { type: "integer", minimum: 0, description: "Return when progress is newer than this revision." },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 }
      },
      required: ["agent_id"],
      additionalProperties: false
    },
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
      properties: {
        agent_id: { type: "string" },
        message: { type: "string" },
        timeout_seconds: { type: "integer", minimum: 30, maximum: 1800, default: 600 },
        confirm_write_scope: { type: "boolean", description: "Required for follow-ups to writing agents after explicit user authorization for the same scope." }
      },
      required: ["agent_id", "message"],
      additionalProperties: false
    },
    annotations: { title: "Follow up with Grok", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
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
    annotations: { title: "Close Grok agent", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
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
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/(authorization|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|password|cookie|token)(\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1$2[REDACTED]")
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]");
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
  return realpathSync(path);
}

function assertLinkedWorktree(input) {
  const path = absoluteDirectory(input, "worktree");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Writing agents require a valid Git linked worktree.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("worktree must be the root of the linked Git worktree.");
  let marker;
  try { marker = lstatSync(join(path, ".git")); } catch { throw new Error("Writing agents require a linked Git worktree with a .git file."); }
  if (!marker.isFile()) throw new Error("Primary checkouts are rejected. Create a linked Git worktree, whose .git entry is a file.");
  return path;
}

function assertGitRepositoryRoot(input) {
  const path = absoluteDirectory(input, "cwd");
  const probe = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
  if (probe.status !== 0) throw new Error("Interactive worktree handoff requires a Git repository root.");
  const gitRoot = realpathSync(resolve(probe.stdout.trim()));
  if (gitRoot !== path) throw new Error("cwd must be the root of the Git repository for interactive worktree handoff.");
  return path;
}

function buildChildEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  const extraKeys = String(source.GROK_PASSTHROUGH_ENV || "")
    .split(",")
    .map(key => key.trim())
    .filter(key => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  for (const key of extraKeys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

function negotiateProtocolVersion(requested) {
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
}

function findGrok() {
  const candidates = [process.env.GROK_BIN, join(homedir(), ".grok", "bin", "grok"), "grok"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5_000, env: buildChildEnv() });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Grok CLI was not found. Install and authenticate Grok Build first.");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function appleScriptString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function interactiveWorktreeName() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `grok-handoff-${stamp}-${randomUUID().slice(0, 6)}`;
}

function buildInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode, model, worktreeName }) {
  const args = [shellQuote(binary), "--no-subagents"];
  if (model) args.push("--model", shellQuote(model));
  if (accessMode === "read_only") {
    args.push("--sandbox", "read-only", "--permission-mode", "default");
  } else {
    args.push(`--worktree=${shellQuote(worktreeName)}`, "--sandbox", "workspace", "--permission-mode", "acceptEdits");
  }
  args.push('--', '"$grok_handoff_prompt"');
  return [
    `cd ${shellQuote(cwd)}`,
    `grok_handoff_prompt="$(cat -- ${shellQuote(promptFile)})"`,
    `{ rm -f -- ${shellQuote(promptFile)}; rmdir -- ${shellQuote(promptDir)} 2>/dev/null || true; exec ${args.join(" ")}; }`
  ].join(" && ");
}

function launchInteractiveHandoff(args) {
  if (process.platform !== "darwin") throw new Error("Interactive Terminal handoff is currently supported only on macOS.");
  if (args.confirm_interactive_handoff !== true) {
    throw new Error("confirm_interactive_handoff must be true after the user explicitly requests a separate interactive Grok window.");
  }
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (args.task.length > MAX_TEXT) throw new Error(`task must be at most ${MAX_TEXT} characters.`);
  if (!["read_only", "isolated_worktree"].includes(args.access_mode)) throw new Error("access_mode must be read_only or isolated_worktree.");
  const cwd = args.access_mode === "isolated_worktree" ? assertGitRepositoryRoot(args.cwd) : absoluteDirectory(args.cwd, "cwd");
  const binary = findGrok();
  const worktreeName = args.access_mode === "isolated_worktree" ? interactiveWorktreeName() : null;
  const rules = [
    `Codex has handed this task to you as an interactive ${cleanText(args.role || "Grok Build specialist")}.`,
    "Work directly with the user in this Terminal window. Ask the user when a material decision or additional authority is required.",
    "Do not spawn subagents.",
    args.access_mode === "read_only"
      ? "This is a read-only session. Do not modify project files."
      : "Work only in the isolated worktree created for this session. Do not commit, push, merge, publish, or alter other worktrees unless the user explicitly authorizes that action in this window.",
    "When finished, summarize the changes, tests, remaining risks, and the worktree path so the user can return to Codex for independent verification.",
    "",
    "Task from Codex:",
    cleanText(args.task)
  ].join("\n");
  const promptDir = mkdtempSync(join(tmpdir(), "grok-handoff-"));
  const promptFile = join(promptDir, "prompt.txt");
  writeFileSync(promptFile, rules, { encoding: "utf8", mode: 0o600 });
  const command = buildInteractiveCommand({ binary, cwd, promptFile, promptDir, accessMode: args.access_mode, model: args.model, worktreeName });
  const script = `tell application "Terminal"\nactivate\ndo script "${appleScriptString(command)}"\nend tell`;
  const launched = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 10_000, env: buildChildEnv() });
  if (launched.status !== 0) {
    rmSync(promptDir, { recursive: true, force: true });
    throw new Error(`Could not open the interactive Grok Terminal window: ${cleanText(launched.stderr || launched.stdout || "unknown error")}`);
  }
  const cleanupTimer = setTimeout(() => rmSync(promptDir, { recursive: true, force: true }), 60_000);
  cleanupTimer.unref();
  return {
    launched: true,
    supervision: "user",
    access_mode: args.access_mode,
    cwd,
    worktree_name: worktreeName,
    note: "This Terminal session is independent. Return to Codex when you want its result or diff verified."
  };
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
    this.revision = 0;
    this.requestId = 0;
    this.pending = new Map();
    this.turnPromise = null;
    this.cancelTimer = null;
    this.closed = false;
  }

  async start() {
    const binary = findGrok();
    const sandbox = this.mode === "readonly" ? "read-only" : "workspace";
    const args = ["--no-auto-update", "--sandbox", sandbox, "agent", "--model", this.model, "--always-approve", "--no-leader", "stdio"];
    this.proc = spawn(binary, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: buildChildEnv() });
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
    const allowed = options.find(option => ["allow_once", "allow", "approved"].includes(option.kind));
    if (message.method.includes("permission") && allowed) {
      this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allowed.optionId } } });
    } else {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client method" } });
    }
  }

  consumeUpdate(update) {
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "agent_message_chunk") {
      this.touch();
      this.text = appendBounded(this.text, update.content?.text || "");
    } else if (update.sessionUpdate === "plan") {
      this.touch();
      this.plan = sanitizePlan(update);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      this.touch();
      this.toolEvents.push({
        type: update.sessionUpdate,
        title: cleanText(update.title || update.kind || "tool"),
        status: cleanText(update.status || "unknown"),
        at: this.updatedAt,
        revision: this.revision
      });
      this.toolEvents = this.toolEvents.slice(-20);
    }
  }

  runTurn(prompt, timeoutSeconds = this.timeoutSeconds) {
    if (this.status !== "idle" && this.status !== "completed") throw new Error(`Agent is ${this.status}; wait for the current turn to settle or close it before sending another prompt.`);
    this.status = "running";
    this.error = null;
    this.touch();
    const boundedTimeout = clamp(timeoutSeconds, 30, 1800, this.timeoutSeconds) * 1000;
    const turn = this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: cleanText(prompt) }]
    }, boundedTimeout).then(result => {
      this.clearCancelTimer();
      this.status = this.status === "cancelling" ? "idle" : "completed";
      this.touch();
      return result;
    }).catch(error => {
      this.clearCancelTimer();
      if (this.status === "cancelling") {
        this.status = "idle";
        this.touch();
        return { stopReason: "cancelled" };
      }
      if (this.closed) return { stopReason: "closed" };
      this.fail(error);
      throw error;
    }).finally(() => {
      if (this.turnPromise === turn) this.turnPromise = null;
    });
    this.turnPromise = turn;
    this.turnPromise.catch(() => {});
    return turn;
  }

  cancel() {
    if (!this.sessionId || this.closed || this.status !== "running") return false;
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    this.status = "cancelling";
    this.touch();
    this.clearCancelTimer();
    this.cancelTimer = setTimeout(() => {
      if (this.status === "cancelling") this.fail(new Error("Grok cancellation timed out."));
    }, CANCEL_TIMEOUT_MS);
    this.cancelTimer.unref();
    return true;
  }

  clearCancelTimer() {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
  }

  terminateProcess() {
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc?.exitCode === null && this.proc?.signalCode === null) this.proc.kill("SIGKILL");
    }, 1500).unref();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.status = "closed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Grok agent closed."));
    }
    this.pending.clear();
    this.terminateProcess();
  }

  onExit(code, signal) {
    if (this.closed || this.status === "failed") return;
    const reason = `Grok process exited (${signal || code}).`;
    this.fail(new Error(reason));
  }

  fail(error) {
    if (this.closed || this.status === "failed") return;
    this.error = cleanText(error?.message || error);
    if (this.stderr.trim()) this.error += `\n${cleanText(this.stderr.trim()).slice(-2000)}`;
    this.status = "failed";
    this.touch();
    this.clearCancelTimer();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(this.error));
    }
    this.pending.clear();
    this.terminateProcess();
  }

  touch() {
    this.updatedAt = new Date().toISOString();
    this.revision += 1;
  }

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
      elapsed_seconds: Math.max(0, Math.trunc((Date.now() - Date.parse(this.startedAt)) / 1000)),
      revision: this.revision,
      plan: this.plan,
      recent_tools: this.toolEvents,
      error: this.error
    };
    if (includeText) result.response = this.text;
    else {
      result.response_chars = this.text.length;
      result.public_response_preview = this.text.slice(-1000);
    }
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
  pruneFailedAgents();
  const activeAgents = [...agents.values()].filter(agent => !["failed", "closed"].includes(agent.status));
  if (activeAgents.length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} Grok agents may be open. Close one first.`);
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("task is required.");
  if (mode === "worker" && args.confirm_write_scope !== true) throw new Error("confirm_write_scope must be true after explicit user authorization.");
  const cwd = mode === "readonly" ? absoluteDirectory(args.cwd, "cwd") : assertLinkedWorktree(args.worktree);
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

function pruneFailedAgents() {
  const failed = [...agents.values()]
    .filter(agent => agent.status === "failed")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  while (failed.length > MAX_RETAINED_FAILED_AGENTS) {
    const agent = failed.shift();
    agent.close();
    agents.delete(agent.id);
  }
}

async function waitForAgent(agent, seconds) {
  const deadline = Date.now() + clamp(seconds, 0, 30, 0) * 1000;
  while (["running", "cancelling"].includes(agent.status) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
}

async function waitForRevision(agent, afterRevision, seconds) {
  if (!Number.isInteger(afterRevision) || afterRevision < 0) return;
  const deadline = Date.now() + clamp(seconds, 0, 30, 0) * 1000;
  while (agent.revision <= afterRevision && ["running", "cancelling"].includes(agent.status) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
}


function searchScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run_search.py");
}

function signalSearchBridge(state, signal) {
  if (state.closed || state.child.exitCode !== null || state.child.signalCode !== null) return;
  try { state.child.kill(signal); } catch {}
}

async function stopSearchBridge(state) {
  signalSearchBridge(state, "SIGTERM");
  const closed = await waitForSearchBridgeClose(state, SEARCH_BRIDGE_GRACE_MS);
  if (!closed) {
    signalSearchBridge(state, "SIGKILL");
    await waitForSearchBridgeClose(state, 1_000);
  }
}

function waitForSearchBridgeClose(state, timeoutMilliseconds) {
  return new Promise(resolvePromise => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    timer.unref();
    state.closedPromise.then(() => finish(true));
  });
}

function validateSearchBridgePayload(payload, exitCode, expected) {
  if (expected === "list") {
    if (exitCode !== 0 || !Array.isArray(payload)) throw new Error("Search list bridge returned an invalid response.");
    return payload;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.ok !== "boolean") {
    throw new Error("Search bridge returned an invalid response envelope.");
  }
  if (payload.ok === true) {
    if (exitCode !== 0 || payload.status !== "complete" || typeof payload.result !== "string" || !payload.diagnostics || typeof payload.diagnostics !== "object") {
      throw new Error("Search bridge success contradicted its process result.");
    }
  } else if (exitCode === 0 || payload.status !== "failed" || typeof payload.error !== "string") {
    throw new Error("Search bridge failure contradicted its process result.");
  }
  return payload;
}

function runSearchBridge(args, { timeoutSeconds = 30, expected = "outcome" } = {}) {
  const script = searchScriptPath();
  return new Promise((resolvePromise, rejectPromise) => {
    const env = buildChildEnv();
    if (process.env.GROK_BIN) env.GROK_BIN = process.env.GROK_BIN;
    if (process.env.GROK_HOME) env.GROK_HOME = process.env.GROK_HOME;
    const child = spawn("python3", [script, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolveClosed;
    const state = {
      child,
      closed: false,
      closedPromise: new Promise(resolvePromise => { resolveClosed = resolvePromise; })
    };
    searchBridges.add(state);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let transportError = null;
    let cleanupTimer = null;
    const stopAfterError = error => {
      if (!transportError) transportError = error;
      signalSearchBridge(state, "SIGTERM");
      if (!cleanupTimer) {
        cleanupTimer = setTimeout(() => signalSearchBridge(state, "SIGKILL"), SEARCH_BRIDGE_GRACE_MS);
        cleanupTimer.unref();
      }
    };
    const deadlineTimer = setTimeout(() => {
      stopAfterError(new Error("Search bridge exceeded its cleanup deadline."));
    }, Math.max(1, timeoutSeconds) * 1000);
    deadlineTimer.unref();

    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SEARCH_BRIDGE_OUTPUT) {
        stopAfterError(new Error("Search bridge output exceeded 16 MiB."));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => { transportError = error; });
    child.on("close", (code, signal) => {
      state.closed = true;
      clearTimeout(deadlineTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      searchBridges.delete(state);
      resolveClosed();
      if (transportError) {
        rejectPromise(transportError);
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      let payload;
      try { payload = JSON.parse(stdoutText); }
      catch {
        rejectPromise(new Error(cleanText(stderrText || stdoutText || `Search bridge exited with ${signal || code}`)));
        return;
      }
      try { resolvePromise(validateSearchBridgePayload(payload, code, expected)); }
      catch (error) { rejectPromise(error); }
    });
  });
}

async function callSearch(args = {}) {
  if (typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required.");
  if (args.query.length > MAX_TEXT) throw new Error(`query must be at most ${MAX_TEXT} characters.`);
  const platform = args.platform || "auto";
  if (!["auto", "x", "reddit", "web"].includes(platform)) throw new Error("platform must be auto, x, reddit, or web.");
  const depth = args.depth || "quick";
  if (!["quick", "deep"].includes(depth)) throw new Error("depth must be quick or deep.");
  const model = args.model ?? "grok-4.7";
  if (typeof model !== "string" || !model.trim()) throw new Error("model must be a nonblank string.");
  const maxTurns = args.max_turns ?? 6;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("max_turns must be a positive integer.");
  if (args.json_schema !== undefined && (!args.json_schema || typeof args.json_schema !== "object" || Array.isArray(args.json_schema))) {
    throw new Error("json_schema must be an object.");
  }
  const timeoutSeconds = clamp(args.timeout_seconds, 30, 1800, 180);
  const command = [
    "run",
    "--platform", platform,
    "--depth", depth,
    "--timeout", String(timeoutSeconds),
    "--model", model,
    "--max-turns", String(maxTurns),
    "--retention-days", "7"
  ];
  if (typeof args.since === "string" && args.since.trim()) command.push("--since", args.since.trim());
  if (typeof args.until === "string" && args.until.trim()) command.push("--until", args.until.trim());
  if (args.keep_run === true) command.push("--keep-run");
  if (args.json_schema !== undefined) command.push("--json-schema", JSON.stringify(args.json_schema));
  command.push("--", args.query);
  return runSearchBridge(command, { timeoutSeconds: timeoutSeconds + 8 });
}

async function listSearchRuns() {
  return runSearchBridge(["list"], { expected: "list" });
}

async function showSearchRun(args = {}) {
  if (typeof args.run_id !== "string" || !args.run_id.trim()) throw new Error("run_id is required.");
  return runSearchBridge(["show", args.run_id.trim()]);
}

async function callTool(name, args = {}) {
  switch (name) {
    case "grok_spawn_readonly": return spawnAgent(args, "readonly");
    case "grok_spawn_worker": return spawnAgent(args, "worker");
    case "grok_handoff_interactive": return launchInteractiveHandoff(args);
    case "grok_search": return callSearch(args);
    case "grok_search_list": return listSearchRuns();
    case "grok_search_show": return showSearchRun(args);
    case "grok_status": {
      const agent = getAgent(args.agent_id);
      await waitForRevision(agent, args.after_revision, args.wait_seconds);
      return {
        ...agent.summary(false),
        changed: !Number.isInteger(args.after_revision) || agent.revision > args.after_revision
      };
    }
    case "grok_result": {
      const agent = getAgent(args.agent_id);
      await waitForAgent(agent, args.wait_seconds);
      return agent.summary(true);
    }
    case "grok_send": {
      const agent = getAgent(args.agent_id);
      if (agent.mode === "worker" && args.confirm_write_scope !== true) {
        throw new Error("confirm_write_scope must be true for writing-agent follow-ups after explicit user authorization.");
      }
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

function startMcpServer() {
  const input = createInterface({ input: process.stdin });
  input.on("line", async line => {
    let request;
    try { request = JSON.parse(line); }
    catch {
      sendMcp({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!Object.hasOwn(request, "id")) return;
    try {
      let result;
      if (request.method === "initialize") {
        result = {
          protocolVersion: negotiateProtocolVersion(request.params?.protocolVersion),
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
  input.on("close", () => { void shutdown(); });
  return input;
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const closingBridges = [...searchBridges];
    await Promise.all(closingBridges.map(stopSearchBridge));
    for (const agent of agents.values()) agent.close();
    agents.clear();
  })();
  return shutdownPromise;
}

function forceShutdown() {
  for (const bridge of searchBridges) signalSearchBridge(bridge, "SIGKILL");
  for (const agent of agents.values()) agent.close();
  agents.clear();
}

export {
  GrokAgent,
  TOOL_DEFINITIONS,
  VERSION,
  absoluteDirectory,
  appleScriptString,
  assertLinkedWorktree,
  assertGitRepositoryRoot,
  buildInteractiveCommand,
  buildChildEnv,
  callSearch,
  cleanText,
  listSearchRuns,
  negotiateProtocolVersion,
  searchScriptPath,
  showSearchRun,
  shutdown,
  startMcpServer,
  waitForRevision
};

let isMainModule = false;
try {
  isMainModule = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {}

if (isMainModule) {
  startMcpServer();
  let exiting = false;
  const exitAfterShutdown = code => {
    if (exiting) return;
    exiting = true;
    void shutdown().finally(() => process.exit(code));
  };
  process.on("SIGINT", () => exitAfterShutdown(130));
  process.on("SIGTERM", () => exitAfterShutdown(143));
  process.on("exit", forceShutdown);
}
