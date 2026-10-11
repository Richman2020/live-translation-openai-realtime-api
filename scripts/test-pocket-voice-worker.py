"""No model load: validate the private worker boundary and truly incremental IPC."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("pocket-voice-worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class PocketWorkerTests(unittest.TestCase):
    def test_runtime_directory_is_local_absolute_and_explicit(self):
        with tempfile.TemporaryDirectory(prefix="pocket fixture ") as directory:
            self.assertEqual(worker.runtime_directory(directory), Path(directory))
        for value in ("", "relative/model", "https://model.invalid/", "/tmp/model\nprivate", "/tmp/\0model", " /tmp/model"):
            with self.assertRaisesRegex(ValueError, "INVALID_RUNTIME_PATH"):
                worker.runtime_directory(value)

    def test_configured_empty_runtime_fails_closed_before_model_import(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {key: value for key, value in os.environ.items()
                           if key in ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP")}
            environment.update(POCKET_RUNTIME_DIR=directory, HF_HUB_OFFLINE="1",
                               TRANSFORMERS_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
            result = subprocess.run([sys.executable, "-u", str(Path(worker.__file__))],
                                    input="", text=True, capture_output=True,
                                    env=environment, timeout=10, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout),
                             {"type": "fatal", "code": "POCKETVOICE_ASSET_MISMATCH"})
            self.assertNotIn(directory, result.stdout)
            self.assertEqual(list(Path(directory).iterdir()), [], "Runtime must not install or download")

    def test_text_and_request_validation(self):
        for text in ("", "中文", "x" * 241, "Hello\nthere.", "[laugh]", "<html>", "!!!"):
            with self.assertRaises(ValueError):
                worker.validate_job({"id": "valid-id", "text": text})
        for job in ({"id": "../bad", "text": "Hello."}, {"id": "ok", "text": "Hello.", "voice": "private"}):
            with self.assertRaises(ValueError):
                worker.validate_job(job)
        self.assertEqual(worker.validate_job({"id": "ok", "text": "  It’s fine. "})["text"], "It’s fine.")

    def test_chunks_emitted_before_generation_finishes_and_bound_to_digest(self):
        emitted = []
        class Fake:
            def stream(self, text):
                self.text = text
                yield b"\x01\x00\x02\x00"
                self_count = len(emitted)
                if self_count != 1:
                    raise AssertionError("first native chunk was buffered until end")
                yield b"\x03\x00"
        fake = Fake()
        worker.run_job(fake, {"id": "fixture", "text": "Hello."}, emitted.append)
        self.assertEqual([x["type"] for x in emitted], ["chunk", "chunk", "done"])
        self.assertEqual([x["sequence"] for x in emitted[:-1]], [0, 1])
        pcm = b"".join(base64.b64decode(x["pcm"]) for x in emitted[:-1])
        self.assertEqual(emitted[-1]["sha256"], hashlib.sha256(pcm).hexdigest())
        self.assertEqual(emitted[-1]["bytes"], len(pcm))
        self.assertEqual(emitted[-1]["audioMs"], len(pcm) / 48)

    def test_missing_or_tampered_assets_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "model").mkdir()
            with self.assertRaisesRegex(ValueError, "ASSET_MISMATCH"):
                worker.verify_assets(path)
            (path / "model/model.safetensors").write_bytes(b"not a model")
            with self.assertRaisesRegex(ValueError, "ASSET_MISMATCH"):
                worker.verify_assets(path)

    def test_actual_local_asset_hashes_and_config_without_loading_model(self):
        if not (worker.LAB / "model/model.safetensors").is_file():
            self.skipTest("Private local installation not present")
        worker.verify_assets()
        worker.verify_config(worker.LAB / "model/english-public-local.yaml",
                             worker.LAB / "venv/Lib/site-packages/pocket_tts")

    def test_stream_retains_native_boundaries_and_thread_compatible_call(self):
        import numpy as np
        class Tensor:
            def __init__(self, samples): self.samples = np.asarray(samples, dtype=np.float32)
            def detach(self): return self
            def cpu(self): return self
            def numpy(self): return self.samples
        class Torch:
            # There is deliberately no inference_mode. Native Pocket starts
            # separate no_grad workers that must receive normal cache tensors.
            def manual_seed(self, seed): self.seed = seed
        class Model:
            def generate_audio_stream(self, voice, text, copy_state):
                if voice != "public fixture" or text != "Hello." or copy_state is not True:
                    raise AssertionError("native preset API changed")
                yield Tensor([0.0, 0.1])
                yield Tensor([-0.1])
        runtime = worker.PocketRuntime.__new__(worker.PocketRuntime)
        runtime.np, runtime.torch, runtime.model, runtime.voice = np, Torch(), Model(), "public fixture"
        runtime.network = {"network": {"blocked_attempts": 0}}
        chunks = list(runtime.stream("Hello."))
        self.assertEqual([len(chunk) for chunk in chunks], [4, 2])
        self.assertEqual(runtime.torch.seed, worker.SEED)
        self.assertEqual(np.frombuffer(b"".join(chunks), dtype="<i2").tolist(), [0, 3277, -3277])


if __name__ == "__main__":
    unittest.main()
