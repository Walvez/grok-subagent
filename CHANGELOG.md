# Changelog

All notable changes to this project will be documented here.

## 0.4.2 - 2026-10-01

### Fixed

- Search success now requires one valid Grok JSON envelope, exit code zero, `stopReason: "end_turn"`, and nonblank Markdown. Cancelled, malformed, empty, and nonzero results are retained as failed diagnostics instead of being reported as complete.
- The MCP search bridge now uses asynchronous child processes, keeps ping and other requests responsive, and rejects contradictions between the Python result envelope and process exit status.
- Search timeout, MCP stdin close, SIGINT, and SIGTERM now terminate the owned Grok process group with bounded TERM/KILL cleanup.
- The plugin MCP manifest now allows 1,815 seconds per tool call so a maximum 1,800-second search can finish its bounded bridge cleanup before the host cancels transport.
- Process-group cleanup now retries transient macOS permission errors briefly and accepts them only once the group is confirmed absent. Persistent permission errors remain explicit failures.

### Changed

- Search defaults to selectable `grok-4.7`, six turns, and a 180-second deadline without model fallback.
- Search runs use the CLI's native login, a fresh repository-free working directory, explicit public-search tools, explicit local-tool denials, closed stdin, and `--no-auto-update`.
- Version-2 cache manifests distinguish verified completion from failed and legacy unverified runs. Exact Markdown is preserved; partial text is diagnostic only.
- Optional structured results accept a local-only JSON Schema and use the optional Python `jsonschema` package for full local validation.

### Security

- Search no longer reads, copies, or persists Grok authentication files and does not replace `HOME` or `GROK_HOME`.
- Search tool restrictions and compatibility environment switches reduce local exposure but are not an operating-system sandbox. Native Grok configuration may still load.

## 0.4.0 - 2026-08-03

### Added

- Added isolated `grok_search`, `grok_search_list`, and `grok_search_show` tools for Grok-native X, Reddit, and public-web research outside the current repository.
- Bundled a repository-free Grok search bridge adapted from the MIT-licensed `sudoHG/codex-grok-search` project.
- Extended the orchestration skill so current X/Twitter and Reddit research prefers `grok_search` before ordinary web search or project-scoped Grok agents.

### Security

- Search runs use a private cache under `~/.cache/grok-subagent/search-runs`, temporary HOME/GROK_HOME isolation, and only `x_search`, `web_search`, and `web_fetch`.
- Search mode still sends queries and retrieved public content to xAI; it reduces local repository exposure rather than claiming zero upload.

## 0.3.0 - 2026-07-18

### Added

- Added a macOS-only `grok_handoff_interactive` tool that opens the official Grok TUI in a new Terminal window with a Codex-authored task prompt.
- Added read-only and isolated-worktree access modes for user-supervised interactive handoffs.

### Security

- Interactive implementation handoffs cannot write directly to the primary checkout and do not authorize commits, pushes, publication, or changes outside the Grok-created worktree.
- Initial handoff prompts use mode-0600 temporary files and are removed by the launched Terminal command before Grok starts.

## 0.2.0 - 2026-07-18

### Added

- Added monotonic progress revisions, elapsed time, timestamped tool events, and a bounded public-response preview to Grok agent status.
- Added optional long-polling to `grok_status` through `after_revision` and `wait_seconds`.
- Made the orchestration skill relay material Grok progress and provide a user-visible heartbeat at least once per minute.

### Security

- Kept visible progress limited to public answer chunks, plan entries, tool metadata, and lifecycle state; private chain-of-thought remains discarded.

## 0.1.1 - 2026-07-17

### Fixed

- Canonicalized project and worktree paths so symlinked roots, including macOS `/tmp`, are handled correctly.
- Made cancellation settle back to an idle session and terminated failed or timed-out Grok processes.
- Corrected MCP tool annotations and protocol-version negotiation.
- Required explicit write-scope confirmation for writing-agent follow-ups.
- Limited Grok child processes to a documented environment-variable allowlist.
- Added deterministic tests for worktree guards, lifecycle behavior, environment filtering, redaction, and protocol metadata.

### Changed

- Raised the minimum supported Node.js version to 22 and added Node.js 22/24 CI coverage.

## 0.1.0 - 2026-07-17

### Added

- Codex plugin and `$grok-subagent` orchestration skill.
- Dependency-free MCP-to-ACP bridge for the official Grok Build CLI.
- Read-only investigation mode.
- Linked-Git-worktree writing mode with explicit authorization guard.
- Agent status, result, follow-up, cancellation, close, and list tools.
- Bounded event retention and credential-shaped text sanitization.
- MCP smoke tests, authenticated end-to-end test, repository validation, and CI.
