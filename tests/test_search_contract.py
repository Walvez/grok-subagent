from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "plugins/grok-subagent/scripts/run_search.py"


def load_search_module():
    name = "grok_search_contract"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def fake_cli(body: str):
    with tempfile.TemporaryDirectory(prefix="grok-contract-") as temporary:
        root = Path(temporary)
        binary = root / "fake-grok"
        binary.write_text(
            f"#!{sys.executable}\n"
            "import json\n"
            "import os\n"
            "from pathlib import Path\n"
            "import subprocess\n"
            "import sys\n"
            "import time\n"
            f"{body}\n",
            encoding="utf-8",
        )
        binary.chmod(0o700)
        env = {
            "HOME": str(root),
            "PATH": os.defpath,
            "GROK_BIN": str(binary),
            "PYTHONPATH": os.pathsep.join(path for path in sys.path if path),
        }
        yield root, env


def run_cli(env: dict[str, str], args: list[str], timeout: int = 15) -> tuple[subprocess.CompletedProcess[str], object]:
    process = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return process, json.loads(process.stdout)


def envelope_body(envelope: object, exit_code: int = 0) -> str:
    stdout = json.dumps(envelope)
    return f"print({stdout!r})\nraise SystemExit({exit_code})"


def process_is_gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    status = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    return not status or status.startswith("Z")


class SearchContractTests(unittest.TestCase):
    def invoke(self, stdout: str, exit_code: int = 0, extra_args: list[str] | None = None):
        body = f"print({stdout!r})\nraise SystemExit({exit_code})"
        with fake_cli(body) as (_root, env):
            process, result = run_cli(
                env,
                ["run", "--timeout", "3", *(extra_args or []), "--", "synthetic research request"],
            )
            partial = None
            if isinstance(result, dict) and result.get("partial_path"):
                partial = Path(result["partial_path"]).read_text(encoding="utf-8")
            return process.returncode, result, partial

    def test_contract_version_is_importable(self):
        module = load_search_module()
        self.assertEqual(module.SEARCH_CONTRACT_VERSION, 2)
        self.assertTrue(callable(module.main))

    def test_imported_main_restores_callers_signal_handlers_after_cleanup(self):
        module = load_search_module()

        def custom_int(_signum, _frame):
            pass

        def custom_term(_signum, _frame):
            pass

        previous = {
            signal.SIGINT: signal.getsignal(signal.SIGINT),
            signal.SIGTERM: signal.getsignal(signal.SIGTERM),
        }
        signal.signal(signal.SIGINT, custom_int)
        signal.signal(signal.SIGTERM, custom_term)
        try:
            with fake_cli("time.sleep(60)") as (_root, env):
                with mock.patch.dict(os.environ, env, clear=True), mock.patch(
                    "sys.stdout", new_callable=io.StringIO
                ) as output:
                    code = module.main(["run", "--timeout", "1", "--", "request"])
                result = json.loads(output.getvalue())
                self.assertEqual(code, 124, result)
                self.assertEqual(result["error"], "grok_timed_out")
                self.assertIs(signal.getsignal(signal.SIGINT), custom_int)
                self.assertIs(signal.getsignal(signal.SIGTERM), custom_term)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)

    def test_process_group_signal_accepts_permission_race_only_after_absence_probe(self):
        module = load_search_module()
        process = mock.Mock(pid=1234)
        process.poll.return_value = -signal.SIGTERM
        with mock.patch.object(
            module.os,
            "killpg",
            side_effect=[PermissionError(1, "Operation not permitted"), ProcessLookupError()],
        ) as killpg:
            module._signal_process_group(process, signal.SIGKILL)
        self.assertEqual(killpg.call_args_list, [mock.call(1234, signal.SIGKILL), mock.call(1234, 0)])
        process.poll.assert_called_once_with()

    def test_process_group_signal_retries_transient_permission_failure(self):
        module = load_search_module()
        process = mock.Mock(pid=1234)
        with mock.patch.object(
            module.os,
            "killpg",
            side_effect=[PermissionError(1, "Operation not permitted"), None, None],
        ) as killpg, mock.patch.object(module.time, "sleep") as sleep:
            module._signal_process_group(process, signal.SIGKILL)
        self.assertEqual(
            killpg.call_args_list,
            [mock.call(1234, signal.SIGKILL), mock.call(1234, 0), mock.call(1234, signal.SIGKILL)],
        )
        process.poll.assert_called_once_with()
        sleep.assert_called_once()

    def test_process_group_signal_rejects_persistent_permission_failure_for_live_group(self):
        module = load_search_module()
        process = mock.Mock(pid=1234)
        denied = PermissionError(1, "Operation not permitted")
        with mock.patch.object(module.time, "monotonic", side_effect=[0.0, 0.49, 0.5]), mock.patch.object(
            module.time, "sleep"
        ) as sleep, mock.patch.object(
            module.os,
            "killpg",
            side_effect=[denied, denied, denied, denied],
        ) as killpg:
            with self.assertRaises(PermissionError):
                module._signal_process_group(process, signal.SIGKILL)
        self.assertEqual(
            killpg.call_args_list,
            [
                mock.call(1234, signal.SIGKILL),
                mock.call(1234, 0),
                mock.call(1234, signal.SIGKILL),
                mock.call(1234, 0),
            ],
        )
        self.assertEqual(process.poll.call_count, 2)
        sleep.assert_called_once_with(0.01)

    def test_cancelled_answer_is_not_success(self):
        code, result, partial = self.invoke(json.dumps({"text": "unfinished answer", "stopReason": "cancelled"}))
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "incomplete")
        self.assertEqual(partial, "unfinished answer")
        self.assertNotEqual(code, 0)
        self.assertNotIn("result", result)

    def test_malformed_stdout_is_not_success(self):
        code, result, _partial = self.invoke("not JSON at all")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"], "invalid_cli_json")
        self.assertNotEqual(code, 0)

    def test_valid_markdown_is_preserved_exactly(self):
        markdown = "  Intro before JSON-looking text\n```json\n{\"x\": 1}\n```\n"
        code, result, _partial = self.invoke(
            json.dumps(
                {
                    "text": markdown,
                    "stopReason": "end_turn",
                    "modelUsage": {"grok-4.7-build": {}},
                }
            )
        )
        self.assertEqual(code, 0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"], markdown)
        self.assertEqual(result["diagnostics"]["requested_model"], "grok-4.7")
        self.assertEqual(result["diagnostics"]["reported_models"], ["grok-4.7-build"])

    def test_nonzero_and_empty_results_fail(self):
        code, result, partial = self.invoke(
            json.dumps({"text": "draft", "stopReason": "end_turn"}),
            exit_code=7,
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "cli_exit_nonzero")
        self.assertEqual(partial, "draft")

        code, result, _partial = self.invoke(json.dumps({"text": "  ", "stopReason": "end_turn"}))
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "empty_result")

    def test_failed_auth_output_is_classified_without_scanning_success_content(self):
        cases = (
            "print('not logged in')",
            "print('not logged in')\nraise SystemExit(7)",
            "print('not JSON')\nprint('authentication required', file=sys.stderr)\nraise SystemExit(7)",
        )
        for body in cases:
            with fake_cli(body) as (_root, env):
                process, result = run_cli(env, ["run", "--timeout", "3", "--", "request"])
                self.assertEqual(process.returncode, 1)
                self.assertEqual(result["error"], "grok_not_authenticated")
                self.assertIn("grok login --device-auth", result["message"])

        markdown = "The public post says the example user is not authenticated.\n"
        code, result, _partial = self.invoke(json.dumps({"text": markdown, "stopReason": "end_turn"}))
        self.assertEqual(code, 0)
        self.assertEqual(result["result"], markdown)

    @unittest.skipUnless(importlib.util.find_spec("jsonschema"), "jsonschema is optional")
    def test_structured_output_requires_value_without_error_and_validates_schema(self):
        schema = {
            "$id": "https://example.invalid/root.json",
            "$defs": {"name": {"type": "string"}},
            "type": "array",
            "items": {"$ref": "#/$defs/name"},
        }
        args = ["--json-schema", json.dumps(schema)]
        code, result, _partial = self.invoke(
            json.dumps({"text": "structured\n", "stopReason": "end_turn", "structuredOutput": ["one", "two"]}),
            extra_args=args,
        )
        self.assertEqual(code, 0)
        self.assertEqual(result["result"], "structured\n")
        self.assertEqual(result["structured_result"], ["one", "two"])

        code, result, _partial = self.invoke(
            json.dumps({"text": "draft", "stopReason": "end_turn", "structuredOutput": ["one", 2]}),
            extra_args=args,
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "schema_validation_failed")

        code, result, _partial = self.invoke(
            json.dumps({"text": "draft", "stopReason": "end_turn", "structuredOutput": None}),
            extra_args=args,
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "structured_output_missing")

        code, result, _partial = self.invoke(
            json.dumps(
                {
                    "text": "draft",
                    "stopReason": "end_turn",
                    "structuredOutput": ["one"],
                    "structuredOutputError": "trailing characters",
                }
            ),
            extra_args=args,
        )
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "structured_output_error")

        context = load_search_module().prepare_schema(json.dumps(schema))
        with tempfile.TemporaryDirectory(prefix="grok-schema-retrieval-") as temporary:
            external = Path(temporary) / "external.json"
            external.write_text(json.dumps({"const": "retrieved"}), encoding="utf-8")
            guarded = context.validator.evolve(schema={"$ref": external.as_uri()})
            from referencing.exceptions import Unresolvable

            with self.assertRaises(Unresolvable):
                list(guarded.iter_errors("retrieved"))

    def test_external_schema_reference_is_rejected_before_invocation(self):
        with fake_cli("") as (root, env):
            receipt = root / "invoked"
            binary = Path(env["GROK_BIN"])
            binary.write_text(
                f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(receipt)!r}).write_text('yes')\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)
            for reference in ("file:///tmp/schema.json", "https://example.invalid/schema.json"):
                process, result = run_cli(
                    env,
                    [
                        "run",
                        "--json-schema",
                        json.dumps({"$ref": reference}),
                        "--",
                        "synthetic research request",
                    ],
                )
                self.assertEqual(process.returncode, 2)
                self.assertEqual(result["error"], "remote_schema_ref_forbidden")
            self.assertFalse(receipt.exists())

    def test_invalid_arguments_use_the_failure_envelope(self):
        with fake_cli("raise AssertionError('must not run')") as (_root, env):
            process, result = run_cli(env, ["run", "--max-turns", "0", "--", "request"])
            self.assertEqual(process.returncode, 2)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"], "invalid_arguments")

    def test_bare_grok_bin_resolves_through_path(self):
        with fake_cli(envelope_body({"text": "ok", "stopReason": "end_turn"})) as (root, env):
            env["GROK_BIN"] = "fake-grok"
            env["PATH"] = os.pathsep.join((str(root), env["PATH"]))
            process, result = run_cli(env, ["run", "--timeout", "3", "--", "request"])
            self.assertEqual(process.returncode, 0, result)
            self.assertTrue(result["ok"])

    def test_missing_bare_grok_bin_is_a_clean_failure(self):
        with fake_cli("raise AssertionError('must not run')") as (_root, env):
            env["GROK_BIN"] = "missing-grok-command"
            process, result = run_cli(env, ["run", "--timeout", "3", "--", "request"])
            self.assertEqual(process.returncode, 2)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"], "grok_not_found")

    def test_command_uses_native_home_closed_stdin_and_public_search_restrictions(self):
        with fake_cli("") as (root, env):
            receipt = root / "receipt.json"
            body = (
                f"Path({str(receipt)!r}).write_text(json.dumps({{"
                "'argv': sys.argv[1:], 'cwd': os.getcwd(), 'home': os.environ.get('HOME'), "
                "'grok_home': os.environ.get('GROK_HOME'), 'stdin': sys.stdin.read(), "
                "'compat': os.environ.get('GROK_CURSOR_MCPS_ENABLED')"
                "}))\n"
                "print(json.dumps({'text': 'ok', 'stopReason': 'end_turn'}))"
            )
            binary = Path(env["GROK_BIN"])
            binary.write_text(f"#!{sys.executable}\nimport json, os, sys\nfrom pathlib import Path\n{body}\n", encoding="utf-8")
            binary.chmod(0o700)
            process, result = run_cli(
                env,
                ["run", "--timeout", "3", "--model", "grok-test", "--max-turns", "9", "--", "request"],
            )
            self.assertEqual(process.returncode, 0, result)
            self.assertTrue(result["ok"])
            observed = json.loads(receipt.read_text(encoding="utf-8"))
            argv = observed["argv"]
            self.assertEqual(observed["stdin"], "")
            self.assertEqual(observed["home"], str(root))
            self.assertIsNone(observed["grok_home"])
            self.assertEqual(observed["compat"], "false")
            self.assertNotEqual(Path(observed["cwd"]), root)
            self.assertEqual(Path(argv[argv.index("--cwd") + 1]).resolve(), Path(observed["cwd"]).resolve())
            self.assertEqual(argv[argv.index("--model") + 1], "grok-test")
            self.assertEqual(argv[argv.index("--max-turns") + 1], "9")
            self.assertEqual(argv[argv.index("--effort") + 1], "high")
            self.assertEqual(argv[argv.index("--tools") + 1], "x_search,web_search,web_fetch")
            self.assertEqual([argv[index + 1] for index, value in enumerate(argv) if value == "--deny"], ["Read", "Bash", "Edit", "MCPTool"])
            self.assertEqual(argv[argv.index("--disallowed-tools") + 1], "read_file,list_dir,grep,search_replace,run_terminal_cmd")
            for required in ("--no-auto-update", "--no-memory", "--no-subagents", "--prompt-file"):
                self.assertIn(required, argv)
            self.assertNotIn("--always-approve", argv)
            self.assertNotIn("--sandbox", argv)

    def test_timeout_kills_cli_process_group(self):
        with fake_cli("") as (root, env):
            receipt = root / "pids.json"
            body = (
                "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                f"Path({str(receipt)!r}).write_text(json.dumps({{'parent': os.getpid(), 'child': child.pid}}))\n"
                "time.sleep(60)"
            )
            binary = Path(env["GROK_BIN"])
            binary.write_text(
                f"#!{sys.executable}\nimport json, os, subprocess, sys, time\nfrom pathlib import Path\n{body}\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)
            process, result = run_cli(env, ["run", "--timeout", "1", "--", "request"], timeout=10)
            self.assertEqual(
                process.returncode,
                124,
                f"stdout={process.stdout!r}\nstderr={process.stderr!r}\nresult={result!r}",
            )
            self.assertEqual(result["error"], "grok_timed_out")
            manifest = json.loads((Path(result["run_path"]) / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "failed")
            self.assertEqual(manifest["error"], "grok_timed_out")
            pids = json.loads(receipt.read_text(encoding="utf-8"))
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not all(process_is_gone(pid) for pid in pids.values()):
                time.sleep(0.05)
            self.assertTrue(all(process_is_gone(pid) for pid in pids.values()), pids)

    def test_signal_during_timeout_cleanup_preserves_cleanup_and_failure_manifest(self):
        with fake_cli("") as (root, env):
            receipt = root / "pids.json"
            term_receipt = root / "term-received"
            child_source = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
            body = (
                "def ignore_term(_signum, _frame):\n"
                f"    Path({str(term_receipt)!r}).write_text('yes')\n"
                "signal.signal(signal.SIGTERM, ignore_term)\n"
                f"child = subprocess.Popen([sys.executable, '-c', {child_source!r}])\n"
                f"Path({str(receipt)!r}).write_text(json.dumps({{'cli': os.getpid(), 'descendant': child.pid}}))\n"
                "time.sleep(60)"
            )
            binary = Path(env["GROK_BIN"])
            binary.write_text(
                f"#!{sys.executable}\nimport json, os, signal, subprocess, sys, time\nfrom pathlib import Path\n{body}\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)
            bridge = subprocess.Popen(
                [sys.executable, str(SCRIPT), "run", "--timeout", "1", "--", "request"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            pids = None
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not receipt.exists():
                    time.sleep(0.025)
                self.assertTrue(receipt.exists())
                pids = json.loads(receipt.read_text(encoding="utf-8"))
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not term_receipt.exists():
                    time.sleep(0.025)
                self.assertTrue(term_receipt.exists())
                bridge.send_signal(signal.SIGTERM)
                stdout, stderr = bridge.communicate(timeout=10)
                result = json.loads(stdout)
                self.assertEqual(
                    bridge.returncode,
                    124,
                    f"stdout={stdout!r}\nstderr={stderr!r}\nresult={result!r}",
                )
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], "grok_timed_out")
                manifest = json.loads((Path(result["run_path"]) / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["status"], "failed")
                self.assertEqual(manifest["error"], "grok_timed_out")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not all(process_is_gone(pid) for pid in pids.values()):
                    time.sleep(0.05)
                self.assertTrue(all(process_is_gone(pid) for pid in pids.values()), pids)
            finally:
                if bridge.poll() is None:
                    bridge.kill()
                    bridge.communicate()
                if pids is not None:
                    try:
                        os.killpg(pids["cli"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_interrupt_returns_130_and_cleans_the_cli(self):
        with fake_cli("") as (root, env):
            receipt = root / "pid"
            binary = Path(env["GROK_BIN"])
            binary.write_text(
                f"#!{sys.executable}\nimport os, time\nfrom pathlib import Path\n"
                f"Path({str(receipt)!r}).write_text(str(os.getpid()))\ntime.sleep(60)\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)
            process = subprocess.Popen(
                [sys.executable, str(SCRIPT), "run", "--timeout", "30", "--", "request"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not receipt.exists():
                    time.sleep(0.025)
                self.assertTrue(receipt.exists())
                cli_pid = int(receipt.read_text(encoding="utf-8"))
                process.send_signal(signal.SIGINT)
                stdout, stderr = process.communicate(timeout=10)
                result = json.loads(stdout)
                self.assertEqual(
                    process.returncode,
                    130,
                    json.dumps(
                        {
                            "stdout": stdout,
                            "stderr": stderr,
                            "result": result,
                            "bridge_pid": process.pid,
                            "bridge_returncode": process.returncode,
                            "cli_pid": cli_pid,
                            "cli_gone": process_is_gone(cli_pid),
                        },
                        indent=2,
                    ),
                )
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], "interrupted")
                self.assertTrue(process_is_gone(cli_pid))
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()

    def test_repeated_signals_do_not_interrupt_cleanup_or_failure_manifest(self):
        with fake_cli("") as (root, env):
            receipt = root / "pids.json"
            term_receipt = root / "term-received"
            child_source = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"
            body = (
                "def ignore_term(_signum, _frame):\n"
                f"    Path({str(term_receipt)!r}).write_text('yes')\n"
                "signal.signal(signal.SIGTERM, ignore_term)\n"
                f"child = subprocess.Popen([sys.executable, '-c', {child_source!r}])\n"
                f"Path({str(receipt)!r}).write_text(json.dumps({{'cli': os.getpid(), 'descendant': child.pid}}))\n"
                "time.sleep(60)"
            )
            binary = Path(env["GROK_BIN"])
            binary.write_text(
                f"#!{sys.executable}\nimport json, os, signal, subprocess, sys, time\nfrom pathlib import Path\n{body}\n",
                encoding="utf-8",
            )
            binary.chmod(0o700)
            bridge = subprocess.Popen(
                [sys.executable, str(SCRIPT), "run", "--timeout", "30", "--", "request"],
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            pids = None
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not receipt.exists():
                    time.sleep(0.025)
                self.assertTrue(receipt.exists())
                pids = json.loads(receipt.read_text(encoding="utf-8"))
                bridge.send_signal(signal.SIGINT)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not term_receipt.exists():
                    time.sleep(0.025)
                self.assertTrue(term_receipt.exists())
                bridge.send_signal(signal.SIGTERM)
                stdout, stderr = bridge.communicate(timeout=10)
                result = json.loads(stdout)
                self.assertEqual(bridge.returncode, 130, stderr)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"], "interrupted")
                manifest = json.loads((Path(result["run_path"]) / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["status"], "failed")
                self.assertEqual(manifest["error"], "interrupted")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not all(process_is_gone(pid) for pid in pids.values()):
                    time.sleep(0.05)
                self.assertTrue(all(process_is_gone(pid) for pid in pids.values()), pids)
            finally:
                if bridge.poll() is None:
                    bridge.kill()
                    bridge.communicate()
                if pids is not None:
                    try:
                        os.killpg(pids["cli"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_show_preserves_verified_success_and_rejects_failed_run(self):
        markdown = "verified\n"
        with fake_cli(envelope_body({"text": markdown, "stopReason": "end_turn"})) as (_root, env):
            process, result = run_cli(env, ["run", "--timeout", "3", "--keep-run", "--", "request"])
            self.assertEqual(process.returncode, 0)
            listed_process, listed = run_cli(env, ["list"])
            self.assertEqual(listed_process.returncode, 0)
            row = next(item for item in listed if item["run_id"] == result["run_id"])
            self.assertEqual(row["status"], "complete")
            self.assertTrue(row["keep"])
            shown_process, shown = run_cli(env, ["show", result["run_id"]])
            self.assertEqual(shown_process.returncode, 0)
            self.assertEqual(shown["result"], markdown)
            self.assertEqual(shown["diagnostics"], result["diagnostics"])

        with fake_cli(envelope_body({"text": "draft", "stopReason": "cancelled"})) as (_root, env):
            process, result = run_cli(env, ["run", "--timeout", "3", "--", "request"])
            self.assertEqual(process.returncode, 1)
            shown_process, shown = run_cli(env, ["show", result["run_id"]])
            self.assertEqual(shown_process.returncode, 1)
            self.assertFalse(shown["ok"])
            self.assertEqual(shown["error"], "incomplete")
            self.assertNotIn("result", shown)

        with fake_cli("") as (root, env):
            run_id = "20260101T000000Z-" + "a" * 32
            run_dir = root / ".cache/grok-subagent/search-runs" / run_id
            run_dir.mkdir(parents=True)
            (run_dir / ".grok-subagent-search-run-v1").write_text("grok-subagent search run v1\n", encoding="utf-8")
            (run_dir / "manifest.json").write_text(json.dumps({"status": "complete"}), encoding="utf-8")
            (run_dir / "result.md").write_text("legacy\n", encoding="utf-8")
            shown_process, shown = run_cli(env, ["show", run_id])
            self.assertEqual(shown_process.returncode, 1)
            self.assertFalse(shown["ok"])
            self.assertEqual(shown["error"], "legacy_result_unverified")
            self.assertNotIn("result", shown)


if __name__ == "__main__":
    unittest.main()
