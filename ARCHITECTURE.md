# Architecture

## Design goal

The bridge is intentionally an orchestrator adapter, not another coding-agent framework. Codex decides what to delegate and verifies the outcome. The official Grok Build process owns Grok-specific authentication, inference, tools, and session semantics.

## Protocol path

```text
Codex task
  -> bundled grok-subagent skill
  -> MCP JSON-RPC over stdio
  -> mcp-server/server.mjs
  -> ACP JSON-RPC over stdio
  -> official `grok agent stdio`
  -> Grok/xAI service and local tools
```

The MCP server has no third-party runtime dependencies. Each external agent owns:

- one child `grok` process;
- one ACP `sessionId`;
- one active prompt turn at a time;
- bounded public answer text;
- recent plan and tool-status summaries;
- lifecycle state and sanitized errors.

## ACP lifecycle

1. Spawn Grok with `--no-auto-update`, the selected sandbox, model, automatic approval, and `agent stdio`.
2. Send ACP `initialize` with protocol version 1.
3. Use the official `cached_token` authentication method when advertised. Other Grok-supported environment authentication remains owned by the CLI.
4. Create a session with `session/new`, the target directory, no nested MCP servers, and additional orchestration rules.
5. Send the task with `session/prompt`.
6. Consume `session/update` events. Keep public message chunks, plan entries, and bounded tool metadata; discard thought chunks.
7. Keep the process alive for focused follow-ups until cancellation, close, or MCP shutdown.

The child process receives only a small system environment allowlist, supported Grok authentication variables, and variables explicitly named by the operator. Failed or timed-out sessions terminate their Grok process while retaining a bounded diagnostic summary.

## Read-only mode

`grok_spawn_readonly` starts Grok with `--sandbox read-only`. The bridge accepts any readable absolute directory. Grok's sandbox is the enforcement boundary; the prompt also states that the session must not modify project files.

## Writing mode

`grok_spawn_worker` requires all of the following before process startup:

1. `confirm_write_scope` is true after explicit user authorization;
2. the target is an absolute directory;
3. `git rev-parse --show-toplevel` resolves exactly to that directory;
4. `.git` is a file, which is the normal marker of a linked Git worktree.

The process then starts with `--sandbox workspace`. The bridge never creates commits, pushes, merges, cherry-picks, or removes the worktree.

## Why automatic Grok approval is used

ACP integrations cannot depend on an interactive terminal approval prompt. The bridge therefore launches Grok in automatic-approval mode only after selecting an OS sandbox. Permissions decide whether Grok asks; the sandbox decides what the process can actually write. Writing mode adds the worktree precondition so even an approved edit is separated from the primary checkout.

This is defense in depth, not a claim of perfect isolation. See [SECURITY.md](SECURITY.md).

## Resource bounds

- maximum three open Grok processes per bridge;
- 120,000 characters of retained public answer text per agent;
- 12,000 characters of retained stderr;
- 20 recent tool events;
- 30-minute maximum prompt timeout;
- 30-second maximum blocking result wait.

Closing the MCP server terminates all child Grok processes.
