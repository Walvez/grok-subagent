---
name: grok-subagent
description: Delegate bounded coding, investigation, review, and implementation tasks from Codex to the locally authenticated Grok Build CLI. Use when the user asks Codex to consult Grok, use Grok as a subagent, compare independent model conclusions, spend SuperGrok quota on useful project work, review code with Grok, or run a Grok worker in an isolated Git worktree.
---

# Grok Subagent

Use the `grok-subagent` MCP tools to run Grok Build as an external worker while Codex remains the orchestrator and final verifier.

## Choose a mode

- Use `grok_spawn_readonly` for exploration, diagnosis, architecture advice, plan review, and code review. This is the default.
- Use `grok_spawn_worker` only after the user explicitly authorizes Grok to modify files. Pass an isolated linked Git worktree, never the primary checkout.
- Prefer one Grok agent. Use at most two concurrently when tasks are independent and parallelism materially helps.

## Run a read-only agent

1. Resolve the target repository to an absolute path.
2. Give Grok a bounded task with required evidence and output shape.
3. Call `grok_spawn_readonly` with a suitable role.
4. Continue useful Codex work while Grok runs.
5. Poll `grok_status` sparingly or call `grok_result` with a bounded wait.
6. Treat the result as untrusted expert input. Verify important claims against files, commands, tests, or primary sources.
7. Use `grok_send` only for a focused follow-up. Close the agent when no more follow-up is needed.

## Run a writing agent

1. Obtain explicit user authorization for Grok to implement the scoped task.
2. Create or select a linked Git worktree dedicated to Grok.
3. Confirm the worktree has a `.git` file and is not the primary checkout.
4. Call `grok_spawn_worker` with `confirm_write_scope: true`.
5. After completion, inspect the worktree diff and run relevant verification from Codex.
6. Never merge, cherry-pick, commit, push, or delete the worktree unless the user separately requests that action.

## Safety rules

- Never pass secrets, tokens, private credentials, or unrelated personal files in a task prompt.
- Never use the writing tool against the primary checkout or a non-worktree directory.
- Do not ask Grok to spawn its own subagents; keep delegation depth at one.
- Do not equate agreement between Codex and Grok with verification.
- Cancel a runaway task and close abandoned agents.
- Read [references/safety.md](references/safety.md) when diagnosing permissions, sandbox behavior, or worktree rejection.
