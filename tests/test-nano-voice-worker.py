"""Worker input protocol tests only; never imports Torch or opens the GPU."""
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("nano_worker_protocol", Path(__file__).resolve().parents[1] / "scripts/nano-voice-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import nano_voice_runtime as runtime


class ProtocolTests(unittest.TestCase):
    def test_stdin_reader_starts_after_warmup_before_ready(self):
        events = []
        class StopAfterReady(Exception):
            pass
        class Runtime:
            def __init__(self, **_kwargs):
                events.append("load")
            def synthesize(self, _text):
                events.append("warmup")
        class InputThread:
            def __init__(self, **_kwargs):
                pass
            def start(self):
                events.append("reader")
        class Jobs:
            def __init__(self, **_kwargs):
                pass
            def get(self):
                raise StopAfterReady()
        class Protocol(io.StringIO):
            def write(self, text):
                if '"type": "ready"' in text:
                    events.append("ready")
                return super().write(text)
        protocol = Protocol()
        fake_os = SimpleNamespace(fdopen=lambda *_a, **_kw: protocol,
                                  dup=lambda _fd: 3, dup2=lambda *_args: None)
        fake_sys = SimpleNamespace(stdout=SimpleNamespace(fileno=lambda: 1),
                                   stderr=io.StringIO())
        fake_sys.stderr.fileno = lambda: 2
        with (patch.object(worker, "os", fake_os), patch.object(worker, "sys", fake_sys),
              patch.object(worker, "threading", SimpleNamespace(Lock=threading.Lock, Thread=InputThread)),
              patch.object(worker, "queue", SimpleNamespace(Queue=Jobs)),
              patch.dict(sys.modules, {"nano_voice_runtime": SimpleNamespace(
                  NanoVoiceRuntime=Runtime, NanoRuntimeError=RuntimeError)})):
            with self.assertRaises(StopAfterReady):
                worker.main()
        self.assertEqual(events, ["load", "warmup", "reader", "ready"])

    def test_valid_english_and_unicode_punctuation(self):
        self.assertEqual(worker.validate_job({"id": "job-1", "text": "  It’s five.  "}),
                         {"id": "job-1", "text": "It’s five."})

    def test_invalid_requests_and_configuration_override(self):
        for value in (None, [], {"text": "Hello"}, {"id": "job", "text": "Hello", "reference": "other.wav"},
                      {"id": "private\nvalue", "text": "Hello"}, {"id": 2, "text": "Hello"}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "NANOVOICE_INVALID_REQUEST"):
                worker.validate_job(value)

    def test_text_boundaries(self):
        for text in (None, "", " ", "x" * 241, "中文", "Hello\nworld", "[laugh] hello", "<tag>hello", "!!!"):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "NANOVOICE_INVALID_TEXT"):
                worker.validate_job({"id": "job", "text": text})
        self.assertEqual(len(worker.validate_job({"id": "job", "text": "x" * 240})["text"]), 240)

    def test_source_git_never_inherits_ipc_stdin_or_uses_stdout_pipe(self):
        calls = []
        class Process:
            def __init__(self, args, **kwargs):
                calls.append((args, kwargs))
                kwargs["stdout"].write(b"pinned-revision\n")
            def wait(self, timeout):
                self.timeout = timeout
                return 0
        with patch.object(runtime.shutil, "which", return_value="git.exe"), patch.object(runtime.subprocess, "Popen", Process):
            self.assertEqual(runtime.read_git_output(Path("upstream"), "rev-parse", "HEAD"), "pinned-revision")
        self.assertEqual(calls[0][1]["stdin"], subprocess.DEVNULL)
        self.assertNotEqual(calls[0][1]["stdout"], subprocess.PIPE)
        self.assertFalse(calls[0][1]["shell"])
        self.assertTrue(calls[0][1]["close_fds"])

    def test_source_git_timeout_has_no_unbounded_communicate(self):
        calls, waits, processes = [], [], []
        class Process:
            def __init__(self, args, **kwargs):
                self.pid = 1234 if not processes else 2345
                self.returncode = None
                self.is_killer = bool(processes)
                processes.append(self)
                calls.append((args, kwargs))
            def wait(self, timeout):
                waits.append(timeout)
                if timeout == 20:
                    raise subprocess.TimeoutExpired("fixture", timeout)
                if self.is_killer:
                    processes[0].returncode = 1
                self.returncode = 1
                return 1
            def poll(self):
                return self.returncode
            def kill(self):
                self.returncode = 1
        with patch.object(runtime.shutil, "which", return_value="git.exe"), patch.object(runtime.subprocess, "Popen", Process):
            with self.assertRaisesRegex(runtime.NanoRuntimeError, "NANOVOICE_SOURCE_CHECK_TIMEOUT"):
                runtime.read_git_output(Path("upstream"), "rev-parse", "HEAD")
        self.assertEqual(waits[0], 20)
        self.assertTrue(all(value in (20, 5, 2) for value in waits))
        if runtime.os.name == "nt":
            self.assertEqual(calls[1][0][-4:], ["/PID", "1234", "/T", "/F"])
            self.assertIn("/T", calls[1][0])
            self.assertEqual(calls[1][0][calls[1][0].index("/PID") + 1], "1234")
            self.assertEqual(calls[1][1]["stdin"], subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()
