# Safety and execution model

## Trust boundary

Grok is an external agent that can be wrong or manipulated by repository content. Codex remains the final verifier and should validate consequential claims and changes independently.

## Read-only agents

Read-only agents run under Grok's operating-system `read-only` sandbox with automatic tool approval. Project writes are blocked, although Grok may still write its own state under `~/.grok` and temporary files.

## Writing agents

Writing agents run under Grok's `workspace` sandbox with automatic approval. The bridge refuses to start one unless the target is a linked Git worktree whose `.git` entry is a file. The sandbox limits ordinary project writes to that worktree, plus Grok state and temporary paths.

## Session lifecycle

Each external agent owns one `grok agent stdio` process and one ACP session. The process remains alive for focused follow-ups and is killed when the agent closes or the MCP bridge exits. The bridge retains bounded public response text, plan updates, tool titles, statuses, and errors; it discards private thought chunks and authentication material.

The Grok process receives a minimal environment-variable allowlist. `XAI_API_KEY` and variables explicitly opted in through `GROK_PASSTHROUGH_ENV` remain visible to the official CLI and may be visible to its tools.
