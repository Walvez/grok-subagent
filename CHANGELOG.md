# Changelog

All notable changes to this project will be documented here.

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
