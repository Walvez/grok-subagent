# Security policy

## Supported versions

Security fixes are applied to the latest release. This project is currently pre-1.0, so interfaces may change between minor releases.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, authentication files, exploitable payloads, or private source code.

Include the affected version, operating system, Grok CLI version, reproduction steps, expected boundary, and observed behavior. Use synthetic secrets and a disposable repository whenever possible.

## Trust boundaries

This plugin does not make Grok local or offline. Grok Build may send prompts and file content to xAI according to the user's authentication method, plan, organization settings, and xAI policies. Review the current [Grok Build enterprise and data lifecycle documentation](https://docs.x.ai/build/enterprise) before using private or regulated source code.

Do not delegate:

- API keys, access tokens, cookies, passwords, or private keys;
- production `.env` files or credential stores;
- regulated data unless your organization has approved the relevant xAI configuration;
- unrelated personal files;
- repositories whose contents you are not authorized to share with the configured service.

## Sandbox facts

The bridge currently uses Grok's documented profiles:

- `read-only`: project writes are blocked; `~/.grok` and temporary paths remain writable;
- `workspace`: writes are allowed in the current working directory, `~/.grok`, and temporary paths.

On Linux, Grok documents child-network blocking for read-only and strict profiles. On macOS, that child-network restriction is not currently enforced. Network isolation is therefore not a portable guarantee of this plugin.

Some sensitive directories are protected by Grok independently of these profiles, but users should not rely on deny lists as a substitute for careful scope selection.

## Prompt injection

Repository files are untrusted model input. A malicious file can tell an agent to ignore instructions, expose data, or run commands. The worktree guard and sandbox reduce filesystem impact but do not prove that model output is correct or safe.

Codex should independently inspect relevant files, review every diff, and rerun tests. Agreement between Codex and Grok is not independent evidence if both consumed the same malicious repository content.

## Authentication handling

The bridge asks the official Grok CLI to use its advertised `cached_token` method. It never reads `~/.grok/auth.json`, prints tokens, or stores credentials. Grok child processes receive a minimal environment-variable allowlist instead of the bridge's complete environment. `XAI_API_KEY`, when present, is intentionally passed to the official CLI; additional variables require explicit opt-in through `GROK_PASSTHROUGH_ENV` and may be visible to Grok tools. The server also sanitizes common credential-shaped strings from retained errors and task prompts, but this is only a last-resort safeguard and not a complete secret scanner.

## Dependency and process model

The MCP server uses only Node.js standard-library modules. Grok is launched with argument arrays rather than shell command interpolation. All child processes are terminated when the bridge shuts down, with a forced-kill fallback.
