# Changelog

All notable changes to this project will be documented here.

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
