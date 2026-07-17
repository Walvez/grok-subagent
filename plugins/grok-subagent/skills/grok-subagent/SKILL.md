---
name: grok-subagent
description: Delegate bounded coding, investigation, review, and implementation tasks from Codex to the locally authenticated Grok Build CLI. Use when the user asks Codex to consult Grok, use Grok as a subagent, compare independent model conclusions, spend SuperGrok quota on useful project work, review code with Grok, or run a Grok worker in an isolated Git worktree.
---

# Grok Subagent

Use the `grok-subagent` MCP tools to run Grok Build as an external worker while Codex remains the orchestrator and final verifier.

## Choose a mode

- Use `grok_spawn_readonly` for exploration, diagnosis, architecture advice, plan review, and code review. This is the default.
- Use `grok_spawn_worker` only after the user explicitly authorizes Grok to modify files. Pass an isolated linked Git worktree, never the primary checkout.
- Use `grok_handoff_interactive` when the user explicitly wants Codex to prepare the prompt and then hand control to a visible Grok TUI. Choose `read_only` for inspection or `isolated_worktree` for implementation. This macOS-only session is supervised by the user, not Codex.
- Prefer one Grok agent. Use at most two concurrently when tasks are independent and parallelism materially helps.

## Run a read-only agent

1. Resolve the target repository to an absolute path.
2. Give Grok a bounded task with required evidence and output shape.
3. Call `grok_spawn_readonly` with a suitable role.
4. Tell the user that Grok started, including its role and bounded task.
5. Continue useful Codex work while Grok runs.
6. While the turn is active, call `grok_status` with the last returned `revision` as `after_revision` and a `wait_seconds` value of 20-30.
7. Relay material visible progress in concise commentary: current plan step, recent tool title/status, elapsed time, or a short public-response preview. Send a heartbeat at least once every 60 seconds even if Grok exposes no new detail. Never present private chain-of-thought or invent activity that the bridge did not report.
8. Call `grok_result` when the status settles. Treat the result as untrusted expert input and verify important claims against files, commands, tests, or primary sources.
9. Use `grok_send` only for a focused follow-up. Close the agent when no more follow-up is needed.

## Run a writing agent

1. Obtain explicit user authorization for Grok to implement the scoped task.
2. Create or select a linked Git worktree dedicated to Grok.
3. Confirm the worktree has a `.git` file and is not the primary checkout.
4. Call `grok_spawn_worker` with `confirm_write_scope: true`.
5. For a follow-up, reconfirm that the user authorized the same write scope and pass `confirm_write_scope: true`; otherwise do not send it.
6. After completion, inspect the worktree diff and run relevant verification from Codex.
7. Never merge, cherry-pick, commit, push, or delete the worktree unless the user separately requests that action.

Apply the same visible-progress loop used for read-only agents while a writing turn is active. Describe only reported file/tool activity and keep the user's progress feed concise.

## Hand off to an interactive Grok window

1. Use this only after the user explicitly asks to work with Grok directly in a separate visible window.
2. Turn the request and known project context into a self-contained bounded task prompt. Do not include secrets or unrelated personal context.
3. Use `read_only` unless the user clearly authorizes implementation. For implementation, use `isolated_worktree`; never hand an unsupervised interactive session write access to the primary checkout.
4. Call `grok_handoff_interactive` with `confirm_interactive_handoff: true`.
5. Tell the user that the new Terminal window is independent and user-supervised. Do not poll it, claim to know its current state, or treat it as a managed agent.
6. End Codex's active work on that delegated task. When the user returns, inspect the reported worktree diff and verify tests and consequential claims before integrating anything.

## Safety rules

- Never pass secrets, tokens, private credentials, or unrelated personal files in a task prompt.
- Never use the writing tool against the primary checkout or a non-worktree directory.
- Never describe an interactive handoff as monitored, automatically verified, or automatically returned to Codex.
- Do not ask Grok to spawn its own subagents; keep delegation depth at one.
- Do not equate agreement between Codex and Grok with verification.
- Cancel a runaway task and close abandoned agents.
- Read [references/safety.md](references/safety.md) when diagnosing permissions, sandbox behavior, or worktree rejection.
