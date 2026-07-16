# Contributing

Contributions are welcome, especially for ACP compatibility, safer isolation, cross-platform testing, and clearer documentation.

## Development setup

1. Install Node.js 18 or newer.
2. Clone the repository.
3. Run `npm test`.
4. Add the local marketplace with `codex plugin marketplace add "$PWD"`.
5. Install with `codex plugin add grok-subagent@grok-subagent`.
6. Start a new Codex task to load the updated plugin.

No npm dependency installation is required.

## End-to-end testing

Run `npm run test:e2e` only when the official Grok CLI is installed and authenticated. It consumes a small amount of Grok usage. Use a disposable or non-sensitive directory, or set `GROK_E2E_CWD` explicitly.

Never commit authentication files, captured tokens, private prompts, or test repositories containing real secrets.

## Pull requests

- Keep changes focused.
- Explain the behavior and trust-boundary impact.
- Add or update tests for protocol and lifecycle changes.
- Update both English and Chinese documentation when user-facing behavior changes.
- Run `npm test` before opening the pull request.
- Do not weaken the linked-worktree requirement without a documented replacement providing at least equivalent isolation.

By contributing, you agree that your contribution is licensed under the MIT License.
