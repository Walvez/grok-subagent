import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GrokAgent,
  TOOL_DEFINITIONS,
  appleScriptString,
  assertLinkedWorktree,
  buildInteractiveCommand,
  buildChildEnv,
  cleanText,
  negotiateProtocolVersion,
  waitForRevision
} from "../plugins/grok-subagent/mcp-server/server.mjs";

test("child environment excludes unrelated secrets and supports explicit passthrough", () => {
  const env = buildChildEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    XAI_API_KEY: "xai-test",
    AWS_SECRET_ACCESS_KEY: "do-not-pass",
    CUSTOM_CA_MODE: "strict",
    GROK_PASSTHROUGH_ENV: "CUSTOM_CA_MODE"
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    XAI_API_KEY: "xai-test",
    CUSTOM_CA_MODE: "strict"
  });
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("credential-shaped text is redacted", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  const cleaned = cleanText([
    "token=plain-secret",
    "client_secret: another-secret",
    "Authorization: Bearer abc.def.ghi",
    "xai-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AKIAABCDEFGHIJKLMNOP",
    privateKey
  ].join("\n"));

  for (const secret of ["plain-secret", "another-secret", "abc.def.ghi", "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz123456", "AKIAABCDEFGHIJKLMNOP", "\nsecret\n"]) {
    assert(!cleaned.includes(secret), `secret was not redacted: ${secret}`);
  }
});

test("MCP protocol negotiation never echoes an unsupported version", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05");
  assert.equal(negotiateProtocolVersion("unsupported-future-version"), "2025-11-25");
  assert.equal(negotiateProtocolVersion(undefined), "2025-11-25");
});

test("tool annotations reflect process and writing side effects", () => {
  const byName = Object.fromEntries(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));
  assert.equal(byName.grok_spawn_readonly.annotations.readOnlyHint, false);
  assert.equal(byName.grok_spawn_readonly.annotations.destructiveHint, false);
  assert.equal(byName.grok_send.annotations.destructiveHint, true);
  assert.equal(byName.grok_handoff_interactive.annotations.destructiveHint, true);
  assert.equal(byName.grok_close.annotations.idempotentHint, false);
  assert(byName.grok_send.inputSchema.properties.confirm_write_scope);
  assert(byName.grok_status.inputSchema.properties.after_revision);
  assert.equal(byName.grok_status.inputSchema.properties.wait_seconds.maximum, 30);
});

test("interactive handoff command quotes paths and keeps the prompt out of the command", () => {
  const command = buildInteractiveCommand({
    binary: "/tmp/Grok Build/grok",
    cwd: "/tmp/project's files",
    promptFile: "/tmp/handoff prompt/prompt.txt",
    promptDir: "/tmp/handoff prompt",
    accessMode: "isolated_worktree",
    model: "grok-test",
    worktreeName: "grok-handoff-test"
  });
  assert(command.includes("cd '/tmp/project'\"'\"'s files'"));
  assert(command.includes("--worktree='grok-handoff-test'"));
  assert(command.includes("--permission-mode acceptEdits"));
  assert(command.includes('"$grok_handoff_prompt"'));
  assert(!command.includes("secret task body"));
  assert.equal(appleScriptString('say "hello" \\ path'), 'say \\"hello\\" \\\\ path');
});

test("visible progress has revisions, bounded previews, and waitable updates", async () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  agent.status = "running";
  agent.consumeUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "Public progress" } });
  const first = agent.summary(false);
  assert(first.revision > 0);
  assert.equal(first.public_response_preview, "Public progress");

  agent.consumeUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "private" } });
  assert.equal(agent.revision, first.revision);
  assert(!agent.summary(false).public_response_preview.includes("private"));

  const waiting = waitForRevision(agent, first.revision, 1);
  setTimeout(() => agent.consumeUpdate({ sessionUpdate: "tool_call", title: "Inspect files", status: "in_progress" }), 10);
  await waiting;
  const second = agent.summary(false);
  assert(second.revision > first.revision);
  assert.equal(second.recent_tools.at(-1).title, "Inspect files");
  assert.equal(second.recent_tools.at(-1).revision, second.revision);
  assert(second.recent_tools.at(-1).at);
});

test("linked worktree guard accepts a symlinked root and rejects a primary checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "grok-subagent-worktree-"));
  const repo = join(base, "repo");
  const worktree = join(base, "worktree");
  const alias = join(base, "worktree-alias");

  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    execFileSync("git", ["-C", repo, "add", "seed.txt"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "test-worktree", worktree], { stdio: "ignore" });
    symlinkSync(worktree, alias, "dir");

    assert.equal(assertLinkedWorktree(alias), realpathSync(worktree));
    assert.throws(() => assertLinkedWorktree(repo), /Primary checkouts are rejected/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("cancellation settles back to idle and permits a follow-up", async () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  agent.sessionId = "session-test";
  agent.status = "idle";
  const writes = [];
  agent.write = message => writes.push(message);

  let resolvePrompt;
  agent.request = () => new Promise(resolve => { resolvePrompt = resolve; });

  const firstTurn = agent.runTurn("first");
  assert.equal(agent.status, "running");
  assert.equal(agent.cancel(), true);
  assert.equal(agent.status, "cancelling");
  assert.equal(writes[0].method, "session/cancel");

  resolvePrompt({ stopReason: "cancelled" });
  await firstTurn;
  assert.equal(agent.status, "idle");

  agent.request = async () => ({ stopReason: "end_turn" });
  await agent.runTurn("follow-up");
  assert.equal(agent.status, "completed");
  agent.close();
});

test("failure terminates the child process without hiding the error", () => {
  const agent = new GrokAgent({
    cwd: tmpdir(),
    mode: "readonly",
    role: "test",
    model: "test-model",
    timeoutSeconds: 60
  });
  const signals = [];
  agent.proc = {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      this.signalCode = signal;
      return true;
    }
  };

  agent.fail(new Error("token=super-secret"));
  assert.equal(agent.status, "failed");
  assert.match(agent.error, /\[REDACTED\]/);
  assert(!agent.error.includes("super-secret"));
  assert.deepEqual(signals, ["SIGTERM"]);
  const originalError = agent.error;
  agent.onExit(null, "SIGTERM");
  assert.equal(agent.error, originalError);
});
