#!/usr/bin/env python3
"""Run checked Grok public search from a repository-free temporary directory.

Adapted for the grok-subagent Codex plugin from the MIT-licensed
`sudoHG/codex-grok-search` project (Copyright (c) 2026 codex-grok-search contributors).
Upstream: https://github.com/sudoHG/codex-grok-search
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterator, NoReturn, Sequence
import uuid


SEARCH_CONTRACT_VERSION = 2
DEFAULT_RETENTION_DAYS = 7
DEFAULT_MAX_TURNS = 6
DEFAULT_TIMEOUT = 180
DEFAULT_MODEL = "grok-4.7"
MAX_OUTPUT_BYTES = 16 * 1024 * 1024
PROCESS_GRACE_SECONDS = 1.5
PIPE_GRACE_SECONDS = 0.5
RUN_MARKER = ".grok-subagent-search-run-v1"
KEEP_MARKER = "KEEP"
RUN_ID_RE = re.compile(r"\A\d{8}T\d{6}Z-[0-9a-f]{32}\Z")
AUTH_FAILURE_RE = re.compile(
    r"not logged in|not authenticated|unauthorized|login required|please (?:log|sign) in|"
    r"authentication (?:failed|required)|invalid (?:access |refresh )?token|"
    r"token (?:expired|invalid)|re-authentication required",
    re.IGNORECASE,
)
AUTH_FAILURE_MESSAGE = "Grok reported that authentication is required. Run `grok login --device-auth`, then retry."
COMPATIBILITY_ENV = {
    "GROK_CURSOR_SKILLS_ENABLED": "false",
    "GROK_CURSOR_RULES_ENABLED": "false",
    "GROK_CURSOR_AGENTS_ENABLED": "false",
    "GROK_CURSOR_MCPS_ENABLED": "false",
    "GROK_CURSOR_HOOKS_ENABLED": "false",
    "GROK_CLAUDE_SKILLS_ENABLED": "false",
    "GROK_CLAUDE_RULES_ENABLED": "false",
    "GROK_CLAUDE_AGENTS_ENABLED": "false",
    "GROK_CLAUDE_MCPS_ENABLED": "false",
    "GROK_CLAUDE_HOOKS_ENABLED": "false",
}


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise BridgeError("invalid_arguments", message)


class ProcessSignal(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(f"Received signal {signum}.")
        self.signum = signum


@dataclass(frozen=True)
class ProcessOutcome:
    exit_code: int | None
    stdout: str
    stderr: str
    termination: str
    elapsed_seconds: float
    signal_number: int | None = None


@dataclass(frozen=True)
class SchemaContext:
    schema: dict[str, Any]
    validator: Any


@dataclass(frozen=True)
class CliResult:
    ok: bool
    error: str | None
    message: str | None
    result: str | None
    structured_result: Any
    partial_text: str | None
    stop_reason: str | None
    session_id: str | None
    reported_models: tuple[str, ...]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_datetime(value: str) -> datetime:
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_since(value: str | None, now: datetime) -> datetime | None:
    if not value:
        return None
    duration = re.fullmatch(r"(\d+)([hdw])", value.strip().lower())
    if duration:
        amount = int(duration.group(1))
        delta = {
            "h": timedelta(hours=amount),
            "d": timedelta(days=amount),
            "w": timedelta(weeks=amount),
        }[duration.group(2)]
        return now - delta
    return parse_datetime(value)


def default_cache_root() -> Path:
    return Path.home() / ".cache" / "grok-subagent" / "search-runs"


def private_mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def private_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def write_json(path: Path, payload: object) -> None:
    private_write(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def read_text(path: Path, limit: int = 32 * 1024 * 1024) -> str:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise BridgeError("invalid_artifact", f"Cannot safely read {path.name}.")
    return path.read_text(encoding="utf-8")


def _inside_git_worktree(path: Path) -> bool:
    resolved = path.resolve()
    for parent in (resolved, *resolved.parents):
        git_entry = parent / ".git"
        if git_entry.exists() or git_entry.is_symlink():
            return True
    return False


def ensure_cache_root(create: bool = True) -> Path:
    root = default_cache_root()
    if create:
        private_mkdir(root)
    if not root.exists():
        raise BridgeError("cache_not_found", "No retained Grok runs were found.")
    resolved = root.resolve()
    if _inside_git_worktree(resolved):
        raise BridgeError(
            "unsafe_cache_root",
            "The Grok run cache resolves inside a Git worktree; move ~/.cache outside the repository.",
        )
    resolved.chmod(0o700)
    return resolved


def is_run_dir(path: Path) -> bool:
    if not RUN_ID_RE.fullmatch(path.name):
        return False
    try:
        return (
            path.is_dir()
            and not path.is_symlink()
            and read_text(path / RUN_MARKER, 128).strip()
            == "grok-subagent search run v1"
        )
    except (FileNotFoundError, OSError, BridgeError):
        return False


def load_manifest(run_dir: Path) -> dict[str, object]:
    try:
        payload = json.loads(read_text(run_dir / "manifest.json"))
    except (FileNotFoundError, json.JSONDecodeError, OSError, BridgeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def cleanup_expired(root: Path, retention_days: int) -> list[str]:
    if retention_days < 0:
        return []
    cutoff = utc_now() - timedelta(days=retention_days)
    removed: list[str] = []
    for path in root.iterdir():
        if not is_run_dir(path) or (path / KEEP_MARKER).is_file():
            continue
        manifest = load_manifest(path)
        try:
            created_at = parse_datetime(str(manifest.get("created_at")))
        except (TypeError, ValueError, OverflowError):
            continue
        if created_at < cutoff:
            shutil.rmtree(path)
            removed.append(path.name)
    return sorted(removed)


def create_run(root: Path, now: datetime, keep: bool) -> tuple[str, Path]:
    run_id = f"{now.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex}"
    run_dir = root / run_id
    run_dir.mkdir(mode=0o700)
    private_write(run_dir / RUN_MARKER, "grok-subagent search run v1\n")
    if keep:
        private_write(run_dir / KEEP_MARKER, "Pinned by user request.\n")
    return run_id, run_dir


def find_grok() -> str:
    explicit = os.environ.get("GROK_BIN")
    if explicit:
        candidate = Path(explicit).expanduser()
        has_separator = os.sep in explicit or (os.altsep is not None and os.altsep in explicit)
        if not candidate.is_absolute() and not has_separator:
            discovered = shutil.which(explicit)
            if not discovered:
                raise BridgeError("grok_not_found", f"GROK_BIN command was not found on PATH: {explicit}")
            candidate = Path(discovered)
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, RuntimeError) as exc:
            raise BridgeError("grok_not_found", f"GROK_BIN does not resolve to an executable: {candidate}") from exc
        if not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise BridgeError("grok_not_found", f"GROK_BIN is not executable: {candidate}")
        return str(resolved)

    candidates = [Path.home() / ".grok" / "bin" / "grok"]
    discovered = shutil.which("grok")
    if discovered:
        candidates.append(Path(discovered))
    for candidate in candidates:
        try:
            resolved = candidate.expanduser().resolve(strict=True)
        except (FileNotFoundError, RuntimeError):
            continue
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return str(resolved)
    raise BridgeError(
        "grok_not_found",
        "Grok Build was not found. Install it, then make sure `grok` is available or ~/.grok/bin/grok exists.",
    )


def search_environment() -> dict[str, str]:
    allowed = (
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
        "GROK_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
        "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM", "NO_COLOR",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
        "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
        "https_proxy", "http_proxy", "all_proxy", "no_proxy", "XAI_API_KEY",
    )
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env.update(COMPATIBILITY_ENV)
    return env


def build_prompt(
    query: str,
    platform: str,
    since: datetime | None,
    until: datetime,
    depth: str,
) -> str:
    focus = {
        "x": "Focus on X/Twitter. Use X Search first, but include useful public-web context when helpful.",
        "reddit": "Focus on Reddit. Use public search and direct Reddit links when available.",
        "web": "Focus on the public web.",
        "auto": "Use X Search, Reddit, and the public web as useful for the task.",
    }[platform]
    window = (
        f"The requested time window is {iso_utc(since)} through {iso_utc(until)}."
        if since
        else f"Research current information through {iso_utc(until)}."
    )
    effort = (
        "Answer quickly with the most useful results; do not over-research."
        if depth == "quick"
        else "Research thoroughly and cross-check important claims when useful."
    )
    return f"""Act as Codex's Grok search worker.

User task:
{query}

Guidance:
- {focus}
- {window}
- {effort}
- Return a useful answer in Markdown with direct source links.
- If a date, metric, or claim cannot be verified, say so instead of inventing it.
- Do not inspect local files, repositories, environment variables, credentials, or configuration.
"""


def _signal_process_group(process: subprocess.Popen[bytes], signum: int) -> None:
    permission_deadline = time.monotonic() + PIPE_GRACE_SECONDS
    while True:
        try:
            os.killpg(process.pid, signum)
            return
        except ProcessLookupError:
            return
        except PermissionError:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                pass
            now = time.monotonic()
            if now >= permission_deadline:
                raise
            time.sleep(min(0.01, permission_deadline - now))


def _process_group_exists(process: subprocess.Popen[bytes]) -> bool:
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_ready(
    selector: selectors.BaseSelector,
    buffers: dict[str, bytearray],
    total: int,
    wait: float = 0.0,
) -> tuple[int, bool]:
    exceeded = False
    for key, _ in selector.select(wait):
        try:
            chunk = os.read(key.fd, 64 * 1024)
        except BlockingIOError:
            continue
        if not chunk:
            selector.unregister(key.fileobj)
            continue
        remaining = max(0, MAX_OUTPUT_BYTES - total)
        buffers[key.data].extend(chunk[:remaining])
        total += len(chunk)
        if total > MAX_OUTPUT_BYTES:
            exceeded = True
    return total, exceeded


def _drain_pipes(
    process: subprocess.Popen[bytes],
    selector: selectors.BaseSelector,
    buffers: dict[str, bytearray],
    total: int,
    deadline: float,
) -> int:
    while selector.get_map() and time.monotonic() < deadline:
        wait = min(0.05, max(0.0, deadline - time.monotonic()))
        total, _ = _read_ready(selector, buffers, total, wait)
        if process.poll() is not None:
            total, _ = _read_ready(selector, buffers, total)
    return total


def _terminate_process_group(
    process: subprocess.Popen[bytes],
    selector: selectors.BaseSelector,
    buffers: dict[str, bytearray],
    total: int,
) -> int:
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(signum, signal.SIG_IGN)
        except ValueError:
            pass
    _signal_process_group(process, signal.SIGTERM)
    total = _drain_pipes(
        process,
        selector,
        buffers,
        total,
        time.monotonic() + PROCESS_GRACE_SECONDS,
    )
    if process.poll() is None or _process_group_exists(process):
        _signal_process_group(process, signal.SIGKILL)
    total = _drain_pipes(
        process,
        selector,
        buffers,
        total,
        time.monotonic() + PIPE_GRACE_SECONDS,
    )
    try:
        process.wait(timeout=PIPE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        _signal_process_group(process, signal.SIGKILL)
        try:
            process.wait(timeout=PIPE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
    return total


def run_process(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    deadline: float,
) -> ProcessOutcome:
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    if process.stdout is None or process.stderr is None:
        raise BridgeError("local_runtime_error", "Could not capture Grok output.")

    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    termination = "exited"
    signal_number = None
    exit_seen_at: float | None = None
    try:
        while process.poll() is None or selector.get_map():
            now = time.monotonic()
            if now >= deadline:
                termination = "timeout"
                break
            if process.poll() is not None:
                if exit_seen_at is None:
                    exit_seen_at = now
                elif now - exit_seen_at >= PIPE_GRACE_SECONDS:
                    termination = "descendant_pipe"
                    break
            wait = min(0.1, max(0.0, deadline - now))
            if selector.get_map():
                total, exceeded = _read_ready(selector, buffers, total, wait)
                if exceeded:
                    termination = "output_limit"
                    break
            else:
                time.sleep(wait)
    except ProcessSignal as exc:
        termination = "interrupted"
        signal_number = exc.signum
    except BaseException:
        _terminate_process_group(process, selector, buffers, total)
        raise

    if termination != "exited":
        total = _terminate_process_group(process, selector, buffers, total)
    else:
        process.wait()
        total = _drain_pipes(
            process,
            selector,
            buffers,
            total,
            time.monotonic() + PIPE_GRACE_SECONDS,
        )
        if _process_group_exists(process):
            termination = "descendant_process"
            total = _terminate_process_group(process, selector, buffers, total)

    for stream in (process.stdout, process.stderr):
        try:
            stream.close()
        except OSError:
            pass
    selector.close()
    return ProcessOutcome(
        exit_code=process.returncode,
        stdout=bytes(buffers["stdout"]).decode("utf-8", errors="replace"),
        stderr=bytes(buffers["stderr"]).decode("utf-8", errors="replace"),
        termination=termination,
        elapsed_seconds=round(time.monotonic() - started, 3),
        signal_number=signal_number,
    )


def _reject_external_references(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"$ref", "$dynamicRef", "$recursiveRef"} and isinstance(child, str) and not child.startswith("#"):
                raise BridgeError(
                    "remote_schema_ref_forbidden",
                    "JSON Schema references must stay inside the supplied schema.",
                )
            _reject_external_references(child)
    elif isinstance(value, list):
        for child in value:
            _reject_external_references(child)


def _deny_schema_retrieval(uri: str) -> NoReturn:
    from referencing.exceptions import NoSuchResource

    raise NoSuchResource(ref=uri)


def prepare_schema(raw: str | None) -> SchemaContext | None:
    if raw is None:
        return None
    try:
        schema = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BridgeError("invalid_schema", f"--json-schema is not valid JSON: {exc}") from exc
    if not isinstance(schema, dict):
        raise BridgeError("invalid_schema", "--json-schema must be a JSON object.")
    _reject_external_references(schema)
    try:
        import jsonschema
        from referencing import Registry
    except ImportError as exc:
        raise BridgeError(
            "schema_validator_unavailable",
            "Structured output requires the optional Python jsonschema package.",
        ) from exc
    try:
        validator_class = jsonschema.validators.validator_for(schema)
        validator_class.check_schema(schema)
        registry = Registry(retrieve=_deny_schema_retrieval)
        validator = validator_class(schema, registry=registry, format_checker=jsonschema.FormatChecker())
    except jsonschema.exceptions.SchemaError as exc:
        raise BridgeError("invalid_schema", f"Invalid JSON Schema: {exc.message}") from exc
    return SchemaContext(schema=schema, validator=validator)


def _reported_models(envelope: dict[str, Any]) -> tuple[str, ...]:
    model_usage = envelope.get("modelUsage")
    if not isinstance(model_usage, dict):
        return ()
    return tuple(str(model) for model in model_usage)


def validate_cli_result(
    outcome: ProcessOutcome,
    schema: SchemaContext | None,
) -> CliResult:
    if outcome.termination == "timeout":
        return CliResult(False, "grok_timed_out", "Grok exceeded the search deadline.", None, None, None, None, None, ())
    if outcome.termination == "interrupted":
        return CliResult(False, "interrupted", "The Grok search was interrupted.", None, None, None, None, None, ())
    if outcome.termination == "output_limit":
        return CliResult(False, "output_limit_exceeded", "Grok output exceeded 16 MiB.", None, None, None, None, None, ())
    if outcome.termination != "exited":
        return CliResult(False, "grok_execution_failed", "Grok left a child process or output pipe open.", None, None, None, None, None, ())

    if outcome.exit_code != 0 and AUTH_FAILURE_RE.search(outcome.stderr):
        return CliResult(False, "grok_not_authenticated", AUTH_FAILURE_MESSAGE, None, None, None, None, None, ())
    try:
        envelope = json.loads(outcome.stdout)
    except json.JSONDecodeError:
        if AUTH_FAILURE_RE.search(f"{outcome.stdout}\n{outcome.stderr}"):
            return CliResult(False, "grok_not_authenticated", AUTH_FAILURE_MESSAGE, None, None, None, None, None, ())
        return CliResult(False, "invalid_cli_json", "Grok stdout was not one valid JSON document.", None, None, None, None, None, ())
    if not isinstance(envelope, dict):
        return CliResult(False, "invalid_cli_envelope", "Grok stdout must be a JSON object.", None, None, None, None, None, ())

    text = envelope.get("text")
    partial_text = text if isinstance(text, str) and text.strip() else None
    stop_reason = envelope.get("stopReason") if isinstance(envelope.get("stopReason"), str) else None
    session_id = envelope.get("sessionId") if isinstance(envelope.get("sessionId"), str) else None
    reported_models = _reported_models(envelope)
    if outcome.exit_code != 0:
        error_fields = "\n".join(
            str(envelope.get(key, ""))
            for key in ("error", "message", "detail")
            if envelope.get(key) is not None
        )
        if AUTH_FAILURE_RE.search(error_fields):
            error = "grok_not_authenticated"
            message = AUTH_FAILURE_MESSAGE
        else:
            error = "cli_exit_nonzero"
            message = f"Grok exited with code {outcome.exit_code}."
        return CliResult(False, error, message, None, None, partial_text, stop_reason, session_id, reported_models)
    if stop_reason != "end_turn":
        return CliResult(False, "incomplete", f"Grok stopped with {stop_reason or 'no stop reason'}.", None, None, partial_text, stop_reason, session_id, reported_models)
    structured_error = envelope.get("structuredOutputError")
    if structured_error not in (None, "", False):
        return CliResult(False, "structured_output_error", "Grok reported a structured-output error.", None, None, partial_text, stop_reason, session_id, reported_models)

    if schema is not None:
        if partial_text is None:
            return CliResult(False, "empty_result", "Grok returned no nonblank Markdown result.", None, None, None, stop_reason, session_id, reported_models)
        if "structuredOutput" not in envelope or envelope.get("structuredOutput") is None:
            return CliResult(False, "structured_output_missing", "Grok did not return structured output.", None, None, partial_text, stop_reason, session_id, reported_models)
        structured = envelope["structuredOutput"]
        try:
            validation_error = next(schema.validator.iter_errors(structured), None)
        except Exception as exc:
            return CliResult(False, "schema_validation_failed", f"Structured output could not be validated: {exc}", None, None, partial_text, stop_reason, session_id, reported_models)
        if validation_error is not None:
            return CliResult(False, "schema_validation_failed", f"Structured output failed validation: {validation_error.message}", None, None, partial_text, stop_reason, session_id, reported_models)
        return CliResult(True, None, None, text, structured, None, stop_reason, session_id, reported_models)

    if partial_text is None:
        return CliResult(False, "empty_result", "Grok returned no nonblank Markdown result.", None, None, None, stop_reason, session_id, reported_models)
    return CliResult(True, None, None, text, None, None, stop_reason, session_id, reported_models)


def diagnostics_for(
    outcome: ProcessOutcome,
    result: CliResult,
    requested_model: str,
) -> dict[str, object]:
    return {
        "requested_model": requested_model,
        "reported_models": list(result.reported_models),
        "stop_reason": result.stop_reason,
        "cli_exit_code": outcome.exit_code,
        "termination": outcome.termination,
        "elapsed_seconds": outcome.elapsed_seconds,
        "telemetry_warnings": outcome.stderr.count("mixpanel track failed"),
        "mcp_initialization_warnings": outcome.stderr.count("MCP server failed to initialize"),
        "plugin_collision_warnings": outcome.stderr.count("plugin name collision"),
    }


def _read_prompt(args: argparse.Namespace) -> tuple[str | None, str]:
    if bool(args.query) == bool(args.prompt_file):
        raise BridgeError("invalid_arguments", "Provide exactly one query or --prompt-file.")
    if args.prompt_file:
        try:
            prompt = read_text(args.prompt_file, 1024 * 1024)
        except (OSError, BridgeError) as exc:
            raise BridgeError("invalid_arguments", str(exc)) from exc
        query = None
    else:
        query = args.query
        prompt = ""
    if query is not None and not query.strip():
        raise BridgeError("invalid_arguments", "The search request cannot be blank.")
    if args.prompt_file and not prompt.strip():
        raise BridgeError("invalid_arguments", "The prompt file cannot be blank.")
    return query, prompt


def run_grok(args: argparse.Namespace) -> int:
    query, direct_prompt = _read_prompt(args)
    if not isinstance(args.model, str) or not args.model.strip():
        raise BridgeError("invalid_arguments", "--model cannot be blank.")
    schema = prepare_schema(args.json_schema)
    now = utc_now()
    try:
        since = parse_since(args.since, now)
        until = parse_datetime(args.until) if args.until else now
    except (ValueError, OverflowError) as exc:
        raise BridgeError("invalid_arguments", f"Invalid time boundary: {exc}") from exc
    if since and since > until:
        raise BridgeError("invalid_arguments", "--since must not be later than --until.")

    prompt = direct_prompt or build_prompt(query or "", args.platform, since, until, args.depth)
    grok = find_grok()
    cache_root = ensure_cache_root()
    removed = cleanup_expired(cache_root, args.retention_days)
    run_id, run_dir = create_run(cache_root, now, args.keep_run)
    private_write(run_dir / "prompt.txt", prompt)
    manifest: dict[str, object] = {
        "contract_version": SEARCH_CONTRACT_VERSION,
        "run_id": run_id,
        "created_at": iso_utc(now),
        "query": query,
        "prompt_source": "file" if args.prompt_file else "query",
        "platform_hint": args.platform,
        "depth": args.depth,
        "window": {
            "since": iso_utc(since) if since else None,
            "until": iso_utc(until),
        },
        "status": "running",
        "requested_model": args.model,
        "max_turns": args.max_turns,
        "execution_cwd": "temporary",
        "authentication": "native_grok_cli",
        "cleaned_runs": removed,
        "keep": args.keep_run,
    }
    write_json(run_dir / "manifest.json", manifest)

    deadline = time.monotonic() + args.timeout
    with tempfile.TemporaryDirectory(prefix="grok-subagent-search-") as temporary:
        execution_dir = Path(temporary)
        execution_dir.chmod(0o700)
        if _inside_git_worktree(execution_dir):
            raise BridgeError("unsafe_execution_cwd", "The temporary Grok directory is inside a Git worktree.")
        execution_prompt = execution_dir / "prompt.txt"
        private_write(execution_prompt, prompt)
        command = [
            grok,
            "--no-auto-update",
            "--cwd", str(execution_dir),
            "--prompt-file", str(execution_prompt),
            "--model", args.model,
            "--effort", "high",
            "--max-turns", str(args.max_turns),
            "--output-format", "json",
            "--tools", "x_search,web_search,web_fetch",
            "--deny", "Read",
            "--deny", "Bash",
            "--deny", "Edit",
            "--deny", "MCPTool",
            "--disallowed-tools", "read_file,list_dir,grep,search_replace,run_terminal_cmd",
            "--no-memory",
            "--no-subagents",
        ]
        if schema is not None:
            command.extend(["--json-schema", json.dumps(schema.schema, ensure_ascii=False, separators=(",", ":"))])
        outcome = run_process(command, execution_dir, search_environment(), deadline)

    private_write(run_dir / "stdout.txt", outcome.stdout)
    private_write(run_dir / "stderr.txt", outcome.stderr)
    result = validate_cli_result(outcome, schema)
    diagnostics = diagnostics_for(outcome, result, args.model)

    if result.ok:
        result_path = run_dir / "result.md"
        private_write(result_path, result.result or "")
        structured_path = None
        if schema is not None:
            structured_path = run_dir / "structured-result.json"
            write_json(structured_path, result.structured_result)
        manifest.update(
            {
                "status": "complete",
                "completed_at": iso_utc(utc_now()),
                "result_path": str(result_path),
                "structured_result_path": str(structured_path) if structured_path else None,
                "session_id": result.session_id,
                "diagnostics": diagnostics,
            }
        )
        write_json(run_dir / "manifest.json", manifest)
        payload: dict[str, object] = {
            "ok": True,
            "run_id": run_id,
            "status": "complete",
            "result": result.result,
            "result_path": str(result_path),
            "diagnostics": diagnostics,
        }
        if schema is not None:
            payload["structured_result"] = result.structured_result
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    partial_path = None
    if result.partial_text is not None:
        partial_path = run_dir / "partial.md"
        private_write(partial_path, result.partial_text)
    manifest.update(
        {
            "status": "failed",
            "completed_at": iso_utc(utc_now()),
            "error": result.error,
            "message": result.message,
            "partial_path": str(partial_path) if partial_path else None,
            "session_id": result.session_id,
            "diagnostics": diagnostics,
        }
    )
    write_json(run_dir / "manifest.json", manifest)
    print(
        json.dumps(
            {
                "ok": False,
                "run_id": run_id,
                "status": "failed",
                "error": result.error,
                "message": result.message,
                "run_path": str(run_dir),
                "partial_path": str(partial_path) if partial_path else None,
                "diagnostics": diagnostics,
            },
            ensure_ascii=False,
        )
    )
    if outcome.termination == "timeout":
        return 124
    if outcome.termination == "interrupted":
        return 130
    return 1


def list_runs(_args: argparse.Namespace) -> int:
    try:
        root = ensure_cache_root(create=False)
    except BridgeError as exc:
        if exc.code == "cache_not_found":
            print("[]")
            return 0
        raise
    rows = []
    for run_dir in sorted(root.iterdir(), reverse=True):
        if not is_run_dir(run_dir):
            continue
        manifest = load_manifest(run_dir)
        rows.append(
            {
                "run_id": run_dir.name,
                "created_at": manifest.get("created_at"),
                "status": manifest.get("status", "unknown"),
                "platform_hint": manifest.get("platform_hint", manifest.get("platform")),
                "keep": (run_dir / KEEP_MARKER).is_file(),
            }
        )
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def show_run(args: argparse.Namespace) -> int:
    if not RUN_ID_RE.fullmatch(args.run_id):
        raise BridgeError("invalid_run_id", "The run ID is malformed.")
    root = ensure_cache_root(create=False)
    run_dir = root / args.run_id
    if not is_run_dir(run_dir):
        raise BridgeError("run_not_found", "The requested run was not found.")
    manifest = load_manifest(run_dir)
    if manifest.get("contract_version") != SEARCH_CONTRACT_VERSION:
        print(
            json.dumps(
                {
                    "ok": False,
                    "run_id": args.run_id,
                    "status": "failed",
                    "error": "legacy_result_unverified",
                    "message": "This retained run predates the checked search contract.",
                    "manifest": manifest,
                    "run_path": str(run_dir),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    if manifest.get("status") != "complete":
        print(
            json.dumps(
                {
                    "ok": False,
                    "run_id": args.run_id,
                    "status": "failed",
                    "error": manifest.get("error", "grok_execution_failed"),
                    "message": manifest.get("message", "The retained search failed."),
                    "manifest": manifest,
                    "run_path": str(run_dir),
                    "partial_path": manifest.get("partial_path"),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1

    result_path = run_dir / "result.md"
    if not result_path.is_file():
        raise BridgeError("invalid_artifact", "The retained result is missing.")
    result = read_text(result_path)
    payload: dict[str, object] = {
        "ok": True,
        "run_id": args.run_id,
        "status": "complete",
        "manifest": manifest,
        "result": result,
        "result_path": str(result_path),
        "diagnostics": manifest.get("diagnostics", {}),
    }
    structured_path = run_dir / "structured-result.json"
    if structured_path.is_file():
        try:
            payload["structured_result"] = json.loads(read_text(structured_path))
        except json.JSONDecodeError as exc:
            raise BridgeError("invalid_artifact", "The retained structured result is invalid JSON.") from exc
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cleanup_command(args: argparse.Namespace) -> int:
    root = ensure_cache_root()
    removed = cleanup_expired(root, args.retention_days)
    print(json.dumps({"ok": True, "removed": removed, "count": len(removed)}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Run Grok from a repository-free temporary directory")
    run_parser.add_argument("query", nargs="?", help="Complete search or research request")
    run_parser.add_argument("--prompt-file", type=Path, help="Use a complete prompt from a UTF-8 file")
    run_parser.add_argument("--platform", choices=("auto", "x", "reddit", "web"), default="auto")
    run_parser.add_argument("--depth", choices=("quick", "deep"), default="quick")
    run_parser.add_argument("--since", help="ISO-8601 timestamp or duration such as 24h, 7d, or 2w")
    run_parser.add_argument("--until", help="ISO-8601 end timestamp; defaults to now")
    run_parser.add_argument("--keep-run", action="store_true", help="Keep this run during cleanup")
    run_parser.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    run_parser.add_argument("--model", default=DEFAULT_MODEL)
    run_parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    run_parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    run_parser.add_argument("--json-schema", help="Optional JSON Schema for structured output")
    run_parser.set_defaults(handler=run_grok)

    list_parser = subparsers.add_parser("list", help="List retained runs")
    list_parser.set_defaults(handler=list_runs)

    show_parser = subparsers.add_parser("show", help="Read a retained Grok answer")
    show_parser.add_argument("run_id")
    show_parser.set_defaults(handler=show_run)

    cleanup_parser = subparsers.add_parser("cleanup", help="Remove expired unpinned runs")
    cleanup_parser.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    cleanup_parser.set_defaults(handler=cleanup_command)
    return parser


@contextmanager
def process_signal_handlers() -> Iterator[None]:
    previous: dict[int, Any] = {}
    received = False

    def handle_signal(signum: int, _frame: object) -> None:
        nonlocal received
        if received:
            return
        received = True
        raise ProcessSignal(signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            previous[signum] = signal.signal(signum, handle_signal)
        except ValueError:
            pass
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if hasattr(args, "retention_days") and args.retention_days < 0:
            parser.error("--retention-days must be non-negative")
        if hasattr(args, "timeout") and args.timeout < 1:
            parser.error("--timeout must be at least 1 second")
        if hasattr(args, "max_turns") and args.max_turns < 1:
            parser.error("--max-turns must be at least 1")
        with process_signal_handlers():
            return args.handler(args)
    except ProcessSignal as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": "failed",
                    "error": "interrupted",
                    "message": f"The Grok run was interrupted by signal {exc.signum}.",
                },
                ensure_ascii=False,
            )
        )
        return 130
    except BridgeError as exc:
        print(
            json.dumps(
                {"ok": False, "status": "failed", "error": exc.code, "message": str(exc)},
                ensure_ascii=False,
            )
        )
        return 2
    except (OSError, subprocess.SubprocessError) as exc:
        print(
            json.dumps(
                {"ok": False, "status": "failed", "error": "local_runtime_error", "message": str(exc)},
                ensure_ascii=False,
            )
        )
        return 2


if __name__ == "__main__":
    sys.exit(main())
