"""Resident, local-only Michael preset. Native Pocket chunks cross JSONL as generated.

The parent owns deadlines and process-tree cleanup. No URLs, tokens, recordings,
downloads, cloned voices, audio trimming, or voice postprocessing are accepted.
"""
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import queue
import random
import re
import sys
import threading
import time

REPO = Path(__file__).resolve().parent.parent
LAB = REPO / ".runtime/pocket-tts-lab"
MAX_TEXT_CHARS = 240
MAX_REQUEST_BYTES = 4096
MAX_PCM_BYTES = 24000 * 2 * 20
SEED = 2709
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
TEXT_PATTERN = re.compile(r"[ -~\u00c0-\u024f\u2010-\u2015\u2018-\u201d\u2026]+\Z")
ASSETS = {
    "model.safetensors": (219029196, "916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f"),
    "michael.safetensors": (7276344, "401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c"),
}
TOKENIZER_SIZE = 245020
TOKENIZER_BLOB_SHA1 = "fe3e7fe6185e4a3bc218fa8f5ed993ecb098201c"
TTS_IMPLEMENTATION_SHA256 = "7abdbb4c47615c7b8c04359d13be4cabf3ece7d226205cd5556fb5ff4c06dd22"
UPSTREAM_CONFIG_SHA256 = "1b06236b6a4405a4010c731da097745c23d3d5c543e712e31086b6293fd1124a"


def require(condition, code):
    if not condition:
        raise ValueError(code)


def runtime_directory(value=None):
    """Only an operator-selected, preprovisioned absolute local directory."""
    if value is None:
        value = os.environ.get("POCKET_RUNTIME_DIR", "")
        if not value:
            return LAB
    require(isinstance(value, str) and value == value.strip()
            and not any(ord(char) < 32 or ord(char) == 127 for char in value)
            and Path(value).is_absolute(), "POCKETVOICE_INVALID_RUNTIME_PATH")
    return Path(os.path.abspath(value))


def validate_job(value):
    require(isinstance(value, dict) and set(value) == {"id", "text"}, "POCKETVOICE_INVALID_REQUEST")
    identifier, text = value["id"], value["text"]
    require(isinstance(identifier, str) and ID_PATTERN.fullmatch(identifier), "POCKETVOICE_INVALID_REQUEST")
    require(isinstance(text, str), "POCKETVOICE_INVALID_TEXT")
    text = text.strip()
    require(1 <= len(text) <= MAX_TEXT_CHARS and TEXT_PATTERN.fullmatch(text)
            and not any(char in text for char in "[]<>") and any(char.isalnum() for char in text),
            "POCKETVOICE_INVALID_TEXT")
    return {"id": identifier, "text": text}


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify_assets(lab=LAB):
    for name, (size, digest) in ASSETS.items():
        path = lab / "model" / name
        require(path.is_file() and path.stat().st_size == size and sha256(path) == digest,
                "POCKETVOICE_ASSET_MISMATCH")
    tokenizer = lab / "model/tokenizer.json"
    require(tokenizer.is_file() and tokenizer.stat().st_size == TOKENIZER_SIZE,
            "POCKETVOICE_ASSET_MISMATCH")
    data = tokenizer.read_bytes()
    require(hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == TOKENIZER_BLOB_SHA1,
            "POCKETVOICE_ASSET_MISMATCH")


def verify_config(path, package_root, lab=LAB):
    import yaml
    require(sha256(package_root / "config/english.yaml") == UPSTREAM_CONFIG_SHA256,
            "POCKETVOICE_CONFIG_MISMATCH")
    actual = yaml.safe_load(path.read_text(encoding="utf-8"))
    expected = yaml.safe_load((package_root / "config/english.yaml").read_text(encoding="utf-8"))
    expected.pop("weights_path_without_voice_cloning", None)
    expected["weights_path"] = str(lab / "model/model.safetensors")
    expected["flow_lm"]["lookup_table"]["tokenizer_path"] = str(lab / "model/tokenizer.json")
    require(actual == expected and actual["default_temperature"] == 0.3,
            "POCKETVOICE_CONFIG_MISMATCH")


class PocketRuntime:
    def __init__(self):
        lab = runtime_directory()
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
        # Reuse the audited guard; even the known urllib3 IPv6 probe is blocked.
        # This is a Python socket audit guard, not an OS firewall.
        spec = importlib.util.spec_from_file_location("pocket_network_guard", REPO / "scripts/probe-chatterbox-nano.py")
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        self.network = {"network": {"blocked_attempts": 0}}
        guard.prohibit_python_network(self.network)
        verify_assets(lab)
        require(importlib.metadata.version("pocket-tts") == "3.3.0", "POCKETVOICE_RUNTIME_MISMATCH")
        import numpy as np
        import torch
        import pocket_tts
        from pocket_tts import TTSModel
        package_root = Path(pocket_tts.__file__).parent
        require(sha256(package_root / "models/tts_model.py") == TTS_IMPLEMENTATION_SHA256,
                "POCKETVOICE_RUNTIME_MISMATCH")
        require(torch.__version__ == "2.6.0+cpu", "POCKETVOICE_RUNTIME_MISMATCH")
        config = lab / "model/english-public-local.yaml"
        verify_config(config, package_root, lab)
        torch.set_num_threads(1)
        self.np, self.torch = np, torch
        self.model = TTSModel.load_model(config=str(config))
        require(self.model.sample_rate == 24000 and self.model.device.type == "cpu"
                and all(p.device.type == "cpu" and (not p.is_floating_point() or p.dtype == torch.float32)
                        for p in self.model.parameters()), "POCKETVOICE_RUNTIME_MISMATCH")
        self.voice = self.model.get_state_for_audio_prompt(lab / "model/michael.safetensors")
        self.check_offline()

    def check_offline(self):
        require(self.network["network"]["blocked_attempts"] == 0, "POCKETVOICE_OFFLINE_VIOLATION")

    def stream(self, text):
        random.seed(SEED)
        self.np.random.seed(SEED)
        self.torch.manual_seed(SEED)
        total = 0
        # Preserve native chunk boundaries and every sample. No whole-WAV slicing.
        # The official generator uses no_grad in its worker threads. Wrapping
        # it in inference_mode would create cache tensors that those threads
        # cannot update; retain the exact native benchmark call semantics.
        for chunk in self.model.generate_audio_stream(self.voice, text, copy_state=True):
            self.check_offline()
            audio = chunk.detach().cpu().numpy().reshape(-1)
            require(audio.size > 0 and self.np.isfinite(audio).all(), "POCKETVOICE_INVALID_AUDIO")
            pcm = self.np.rint(self.np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
            total += len(pcm)
            require(total <= MAX_PCM_BYTES, "POCKETVOICE_AUDIO_TOO_LONG")
            yield pcm
        require(total > 0, "POCKETVOICE_INVALID_AUDIO")
        self.check_offline()


def run_job(runtime, job, emit):
    began = time.perf_counter()
    digest = hashlib.sha256()
    total, chunks = 0, 0
    for sequence, pcm in enumerate(runtime.stream(job["text"])):
        total += len(pcm)
        chunks += 1
        digest.update(pcm)
        emit({"type": "chunk", "id": job["id"], "sequence": sequence, "sampleRate": 24000,
              "pcm": base64.b64encode(pcm).decode("ascii"), "sha256": hashlib.sha256(pcm).hexdigest()})
    emit({"type": "done", "id": job["id"], "chunks": chunks, "bytes": total,
          "sha256": digest.hexdigest(), "generationMs": (time.perf_counter() - began) * 1000,
          "audioMs": total / 48})


def main():
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    lock = threading.Lock()

    def emit(event):
        try:
            with lock:
                protocol.write(json.dumps(event, ensure_ascii=True, allow_nan=False) + "\n")
                protocol.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)

    started = time.perf_counter()
    try:
        runtime = PocketRuntime()
        for _pcm in runtime.stream("Hello, thank you for calling, and I hope you are having a good afternoon."):
            pass
    except Exception as error:
        code = str(error) if re.fullmatch(r"POCKETVOICE_[A-Z_]{1,60}", str(error)) else "POCKETVOICE_START_FAILED"
        emit({"type": "fatal", "code": code})
        return 1

    jobs = queue.Queue(maxsize=1)

    def read_input():
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                os._exit(0)
            try:
                require(len(line) <= MAX_REQUEST_BYTES and line.endswith(b"\n"), "POCKETVOICE_INVALID_REQUEST")
                jobs.put_nowait(validate_job(json.loads(line)))
            except (ValueError, UnicodeError, queue.Full):
                emit({"type": "fatal", "code": "POCKETVOICE_INVALID_REQUEST"})
                os._exit(1)

    threading.Thread(target=read_input, name="pocket-stdin", daemon=True).start()
    emit({"type": "ready", "protocol": 1, "sampleRate": 24000, "channels": 1,
          "encoding": "pcm_s16le", "mode": "synthesis-cpu-native-stream", "voice": "michael",
          "version": "3.3.0", "maxTextChars": MAX_TEXT_CHARS, "maxOutputSeconds": 20,
          "startupMs": (time.perf_counter() - started) * 1000})
    while True:
        job = jobs.get()
        try:
            run_job(runtime, job, emit)
        except Exception as error:
            code = str(error) if re.fullmatch(r"POCKETVOICE_[A-Z_]{1,60}", str(error)) else "POCKETVOICE_SYNTHESIS_FAILED"
            emit({"type": "error", "id": job["id"], "code": code})
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
