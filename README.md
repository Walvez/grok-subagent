# Grok Subagent for Codex

[![CI](https://github.com/Walvez/grok-subagent/actions/workflows/ci.yml/badge.svg)](https://github.com/Walvez/grok-subagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Codex Plugin](https://img.shields.io/badge/Codex-plugin-111827)](plugins/grok-subagent/.codex-plugin/plugin.json)

Use the official Grok Build CLI as a controlled external subagent while Codex remains the orchestrator, decision-maker, and final verifier.

[简体中文](README.zh-CN.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

> Community project. Not affiliated with, endorsed by, or sponsored by OpenAI or xAI. Grok and Grok Build are trademarks of xAI; Codex is a product of OpenAI.

## What problem does this solve?

A Grok subscription is useful, but manually copying prompts, context, and answers between Codex and Grok wastes time and loses the benefits of an agent workflow. Browser automation and private-session-token connectors are fragile and create unnecessary account risk. Rebuilding a full coding agent on top of the xAI API duplicates work already present in Grok Build and may require separate API credentials and billing.

This plugin gives Codex a small set of MCP tools that control the official `grok agent stdio` interface:

- start a read-only Grok investigator;
- start a writing worker only inside an isolated linked Git worktree;
- inspect status, plans, and bounded tool activity;
- retrieve the public answer;
- send a focused follow-up;
- cancel or close the process.

The result is a single-control-plane workflow: Codex owns the task, Grok contributes an independent second model, and Codex verifies the result.

## Why this approach is the best fit

“Best” here means best for the specific goal of **using Grok as a Codex-managed subagent**, not best for every integration.

| Approach | Main drawback |
| --- | --- |
| Copy and paste between apps | Manual context transfer, no lifecycle control, easy to lose evidence |
| Browser automation | Fragile UI selectors, login/session risk, difficult cancellation and streaming |
| Unofficial consumer-session connector | Depends on private endpoints or tokens and may break without notice |
| Raw xAI API wrapper | Requires rebuilding agent tools, sessions, permissions, and often separate API setup |
| **This plugin: official Grok CLI + ACP + MCP** | Keeps the supported Grok agent runtime and adds a narrow, auditable Codex control layer |

The design is deliberately small:

1. **Official integration boundary.** Grok Build officially exposes ACP over `grok agent stdio`.
2. **Codex-native tool boundary.** A dependency-free local MCP server exposes lifecycle operations to Codex.
3. **One orchestrator.** Grok cannot recursively spawn more agents through this bridge; Codex owns delegation depth.
4. **Defense in depth.** Read-only work uses Grok's OS sandbox. Writing additionally requires a linked Git worktree before the process can start.
5. **Persistent sessions.** One Grok process and ACP session can handle focused follow-ups without repeatedly rebuilding context.
6. **No secret broker.** Authentication stays inside the official Grok CLI, using its existing cached login or supported API-key flow.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the protocol and trust boundaries.

## Requirements

- macOS, Linux, or WSL supported by Grok Build;
- Node.js 18 or newer;
- a recent Codex CLI/Desktop build with plugin support;
- the official Grok Build CLI, authenticated locally;
- Git when using writing workers.

This project was developed and tested on macOS with Grok CLI `0.2.101`, `grok-4.5`, and a browser-authenticated SuperGrok account. Other authentication methods supported by the official CLI, including `XAI_API_KEY`, are passed through to Grok rather than handled by this plugin.

Install and authenticate Grok Build first:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
```

Official references: [Grok Build overview](https://docs.x.ai/build/overview), [Headless & ACP](https://docs.x.ai/build/cli/headless-scripting), and [CLI reference](https://docs.x.ai/build/cli/reference).

## Install in Codex

Add this repository as a Git marketplace, then install the plugin:

```bash
codex plugin marketplace add Walvez/grok-subagent
codex plugin add grok-subagent@grok-subagent
```

Start a **new Codex task** after installation so the new skill and MCP tools are loaded.

For local development:

```bash
git clone https://github.com/Walvez/grok-subagent.git
cd grok-subagent
codex plugin marketplace add "$PWD"
codex plugin add grok-subagent@grok-subagent
```

Upgrade a Git-installed marketplace snapshot:

```bash
codex plugin marketplace upgrade grok-subagent
codex plugin add grok-subagent@grok-subagent
```

## Use it

You normally use natural language; Codex chooses the appropriate tool through the bundled `$grok-subagent` skill.

### Independent investigation

```text
Use Grok as a read-only subagent to inspect this repository's authentication flow.
Ask it for file-and-line evidence. You remain responsible for the final diagnosis.
```

### Second-opinion code review

```text
Have Grok independently review the current diff for correctness and security issues.
Compare its findings with your own review and report only verified issues.
```

### Plan red-team

```text
Ask Grok to challenge this migration plan. Focus on rollback gaps, data-loss risks,
and assumptions that need tests. Then synthesize the strongest objections.
```

### Isolated implementation

```text
Create an isolated linked Git worktree and let Grok implement the parser change there.
Do not merge or commit anything. Review the diff and run tests yourself afterward.
```

Writing mode requires explicit user authorization. The plugin rejects the primary checkout and any directory whose `.git` entry is not a linked-worktree file.

## Tool surface

| Tool | Purpose | Filesystem mode |
| --- | --- | --- |
| `grok_spawn_readonly` | Start an independent investigation or review | Grok `read-only` sandbox |
| `grok_spawn_worker` | Implement inside an explicitly approved linked worktree | Grok `workspace` sandbox + bridge guard |
| `grok_status` | Read lifecycle, plan, and recent tool status | Read-only |
| `grok_result` | Read accumulated public answer, optionally waiting briefly | Read-only |
| `grok_send` | Send a focused follow-up in the same session | Inherits session mode |
| `grok_cancel` | Cancel the active turn | Control operation |
| `grok_close` | Terminate and forget the external process | Control operation |
| `grok_list` | List bridge-owned agents | Read-only |

The bridge permits at most three open Grok processes. The skill recommends one by default and two only for genuinely independent work.

## Configuration

The plugin needs no npm packages and stores no credentials.

| Variable | Meaning | Default |
| --- | --- | --- |
| `GROK_BIN` | Absolute path or command name for the official Grok CLI | `~/.grok/bin/grok`, then `grok` |
| `GROK_MODEL` | Default Grok model ID | `grok-4.5` |

The model can also be selected per spawned agent.

## Security and privacy

Read [SECURITY.md](SECURITY.md) before using this on private code.

- Grok is an external model. Files it reads or context it receives may be sent to xAI according to your Grok/xAI plan and policies.
- Never delegate secrets, credentials, private keys, production `.env` files, or unrelated personal data.
- `read-only` prevents project writes, but Grok may write its own state under `~/.grok` and temporary paths.
- On macOS, Grok's child-process network blocking for read-only profiles is not currently enforced; do not treat the sandbox as an offline boundary.
- Writing mode auto-approves Grok tools only after both a linked-worktree guard and the workspace sandbox are active. Codex still must inspect the diff and run tests.
- Model agreement is not verification. Repository content can prompt-inject either model.

The bridge discards Grok thought chunks and retains only bounded public text, plan entries, tool titles/status, and sanitized errors in memory.

## Development and tests

No dependency installation is required:

```bash
npm test
```

This checks JavaScript syntax, exercises MCP initialization and all eight tool definitions, and validates the marketplace layout.

The authenticated end-to-end test consumes a small amount of Grok usage:

```bash
npm run test:e2e
```

Set `GROK_E2E_CWD=/absolute/project/path` to choose another read-only target. The test also confirms that writing mode rejects a normal checkout.

## Current limitations

- One bridge process owns its own in-memory agent list; sessions are not resumed after Codex closes the MCP server.
- Public answer text is bounded to prevent unbounded memory growth.
- The bridge does not merge, commit, push, or delete worktrees.
- It does not make Grok a native Codex team subagent; Grok is an external ACP worker exposed through MCP.
- Grok CLI behavior, model names, and sandbox implementation may change. Pin or centrally manage Grok versions for sensitive environments.

## License

MIT. See [LICENSE](LICENSE).
