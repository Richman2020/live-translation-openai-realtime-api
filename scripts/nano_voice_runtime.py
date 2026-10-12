"""Pinned, offline resident Nano synthesis-CUDA runtime for the phone candidate.

No downloads, credentials, HTTP server, reference overrides, or source edits.
This preserves the tested whole-file generate path; it is not token streaming.
"""
import functools
import hashlib
import importlib.util
import inspect
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import time

REPO = Path(__file__).resolve().parent.parent
LAB = REPO / ".runtime/chatterbox-nano-lab"
GPU_LAB = REPO / ".runtime/chatterbox-nano-gpu-lab"
ACCEPTED_REPORT_SHA256 = "8728e606f1de33608061b59c114c0371c6f850713094969f17e34490707a9115"
TTS_SOURCE_SHA256 = "327f34d83234238ba8434fac3d4105965d70ba6dab3377ce62eba2537d618b70"
MAX_AUDIO_SECONDS = 20
TEMPERATURE = 0.75
SEED = 1709


class NanoRuntimeError(Exception):
    """A public code only: never propagate provider text or local paths."""


def require(condition, code):
    if not condition:
        raise NanoRuntimeError(code)


def load_probe():
    spec = importlib.util.spec_from_file_location("nano_resident_probe", REPO / "scripts/probe-chatterbox-nano.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_git_output(upstream, *arguments):
    """Do not share the IPC stdin or wait on a launcher descendant's pipe.

    Git for Windows cmd/git.exe redirects to mingw64/bin/git.exe. A timeout of
    subprocess.check_output can kill only the launcher and then wait forever on
    the descendant-held stdout PIPE. Use the real executable where available,
    DEVNULL stdin, a temporary output file, and an explicitly bounded wait.
    """
    executable = shutil.which("git")
    require(executable is not None, "NANOVOICE_SOURCE_CHECK_FAILED")
    executable = Path(executable)
    if os.name == "nt" and executable.parent.name.lower() == "cmd":
        real_git = executable.parent.parent / "mingw64/bin/git.exe"
        if real_git.is_file():
            executable = real_git
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    with tempfile.TemporaryFile(mode="w+b") as output:
        process = subprocess.Popen([str(executable), "-C", str(upstream), *arguments],
                                   stdin=subprocess.DEVNULL, stdout=output,
                                   stderr=subprocess.DEVNULL, shell=False,
                                   creationflags=flags, close_fds=True)
        try:
            status = process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            if os.name == "nt" and process.poll() is None:
                # Terminate only this spawned PID and its descendants, never
                # other Git instances. Do not capture taskkill through a pipe.
                killer = None
                try:
                    taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/taskkill.exe"
                    killer = subprocess.Popen([str(taskkill), "/PID", str(process.pid), "/T", "/F"],
                                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL, shell=False,
                                              creationflags=flags, close_fds=True)
                    killer.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    if killer is not None and killer.poll() is None:
                        killer.kill()
                        try:
                            killer.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            pass
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            raise NanoRuntimeError("NANOVOICE_SOURCE_CHECK_TIMEOUT") from None
        require(status == 0, "NANOVOICE_SOURCE_CHECK_FAILED")
        output.seek(0)
        data = output.read(65537)
        require(len(data) <= 65536, "NANOVOICE_SOURCE_CHECK_FAILED")
        return data.decode("utf-8", errors="strict").strip()


class NanoVoiceRuntime:
    def __init__(self, on_stage=None):
        import json
        stage = on_stage if on_stage is not None else lambda _name: None
        stage("probe_helper_import_started")
        probe = load_probe()
        stage("probe_helper_import_completed")
        self.network = {"network": {"blocked_attempts": 0}}
        os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                          DO_NOT_TRACK="1", WANDB_DISABLED="true", TOKENIZERS_PARALLELISM="false",
                          OMP_NUM_THREADS="4", MKL_NUM_THREADS="4")
        probe.prohibit_python_network(self.network)
        stage("offline_guard_installed")
        require(Path(sys.prefix).resolve() == (GPU_LAB / "venv").resolve(), "NANOVOICE_RUNTIME_MISMATCH")
        upstream = GPU_LAB / "upstream"
        model_dir = LAB / "model"
        reference = LAB / "reference-10s.wav"
        accepted = LAB / "probe-clarity-20260928T082702-candidate075/report.private.json"
        stage("verify_reference_started")
        require(probe.sha256(accepted) == ACCEPTED_REPORT_SHA256, "NANOVOICE_INPUT_MISMATCH")
        baseline = json.loads(accepted.read_text(encoding="utf-8"))
        require(probe.sha256(reference) == baseline["reference"]["sha256"], "NANOVOICE_INPUT_MISMATCH")
        stage("verify_reference_completed")
        stage("verify_source_started")
        require(read_git_output(upstream, "rev-parse", "HEAD") == probe.UPSTREAM_COMMIT
                and not read_git_output(upstream, "status", "--porcelain", "--untracked-files=all"),
                "NANOVOICE_SOURCE_MISMATCH")
        require(probe.sha256(upstream / "src/chatterbox/tts_turbo.py") == TTS_SOURCE_SHA256,
                "NANOVOICE_SOURCE_MISMATCH")
        stage("verify_source_completed")
        stage("verify_weights_started")
        for name, expected in probe.MODEL_HASHES.items():
            require(probe.sha256(model_dir / name) == expected, "NANOVOICE_MODEL_MISMATCH")
        if (model_dir / "conds.pt").exists():
            require(probe.sha256(model_dir / "conds.pt") == probe.BUILTIN_CONDITIONAL_HASH,
                    "NANOVOICE_MODEL_MISMATCH")
        # AutoTokenizer must not select an extra, unverified tokenizer/config.
        for name in ("tokenizer.json", "config.json", "tokenizer.model"):
            require(not (model_dir / name).exists(), "NANOVOICE_MODEL_MISMATCH")
        stage("verify_weights_completed")
        sys.path.insert(0, str(upstream / "src"))
        stage("numpy_import_started")
        import numpy as np
        stage("torch_import_started")
        import torch
        stage("torchaudio_import_started")
        import torchaudio
        stage("transformers_import_started")
        import transformers
        stage("chatterbox_import_started")
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        stage("model_imports_completed")
        self.np, self.torch = np, torch
        require(torch.__version__ == "2.7.1+cu118" and torchaudio.__version__ == "2.7.1+cu118"
                and transformers.__version__ == "5.2.0", "NANOVOICE_RUNTIME_MISMATCH")
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        stage("cuda_check_started")
        require(torch.cuda.is_available(), "NANOVOICE_GPU_UNAVAILABLE")
        torch.cuda.set_device(0)
        require(torch.cuda.get_device_capability(0) == (5, 2), "NANOVOICE_GPU_MISMATCH")
        require(any(arch in torch.cuda.get_arch_list() for arch in ("sm_50", "sm_52")), "NANOVOICE_GPU_MISMATCH")
        require(torch.cuda.mem_get_info(0)[0] >= 1500 * 1024**2, "NANOVOICE_GPU_MEMORY")
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cudnn.benchmark = False
        stage("cuda_check_completed")
        self.seed()
        stage("model_load_started")
        model = ChatterboxTurboTTS.from_local(model_dir, device="cpu", nano=True)
        stage("model_load_completed")
        require(model.model_label == "Nano" and model.t3.hp.llama_config_name == "GPT2_small"
                and model.sr == 24000, "NANOVOICE_MODEL_MISMATCH")
        require(type(model.watermarker).__name__ == "PerthImplicitWatermarker", "NANOVOICE_WATERMARK_MISMATCH")
        model.conds = None
        stage("reference_conditioning_started")
        model.prepare_conditionals(str(reference), exaggeration=0.0, norm_loudness=True)
        stage("reference_conditioning_completed")
        stage("cuda_transfer_started")
        for name in ("tfmr", "cond_enc", "text_emb", "speech_emb", "speech_head"):
            getattr(model.t3, name).to(device="cuda:0", dtype=torch.float32)
        model.conds.t3.to(device="cuda:0", dtype=torch.float32)
        self.metrics = {}
        original_t3 = model.t3.inference_turbo

        @functools.wraps(original_t3)
        def hybrid_t3(*args, **kwargs):
            bound = inspect.signature(original_t3).bind(*args, **kwargs)
            bound.arguments["text_tokens"] = bound.arguments["text_tokens"].to("cuda:0")
            torch.cuda.synchronize(0)
            started = time.perf_counter()
            tokens = original_t3(*bound.args, **bound.kwargs).cpu()
            torch.cuda.synchronize(0)
            self.metrics["t3Ms"] = (time.perf_counter() - started) * 1000
            require(tokens.ndim == 2 and tokens.shape[0] == 1 and 0 < tokens.shape[1] < 1000,
                    "NANOVOICE_TOKEN_LIMIT")
            self.metrics["tokenCount"] = int(tokens.shape[1])
            self.metrics["tokenSha256"] = hashlib.sha256(tokens.numpy().astype("<i8").tobytes()).hexdigest()
            return tokens

        model.t3.inference_turbo = hybrid_t3
        def tensors_to(value, device):
            if torch.is_tensor(value):
                return value.to(device=device)
            if isinstance(value, tuple):
                return tuple(tensors_to(item, device) for item in value)
            if isinstance(value, list):
                return [tensors_to(item, device) for item in value]
            if isinstance(value, dict):
                return {key: tensors_to(item, device) for key, item in value.items()}
            return value
        model.s3gen.flow.to(device="cuda:0", dtype=torch.float32)
        model.s3gen.mel2wav.to(device="cuda:0", dtype=torch.float32)
        original_flow = model.s3gen.flow.inference

        @functools.wraps(original_flow)
        def hybrid_flow(*args, **kwargs):
            return tensors_to(original_flow(*tensors_to(args, "cuda:0"),
                                            **tensors_to(kwargs, "cuda:0")), "cpu")

        def hybrid_hift(speech_feat, cache_source=None):
            speech_feat = speech_feat.to(device="cuda:0")
            cache_source = speech_feat.new_zeros(1, 1, 0) if cache_source is None else cache_source.to("cuda:0")
            return tensors_to(model.s3gen.mel2wav.inference(speech_feat=speech_feat,
                                                          cache_source=cache_source), "cpu")
        model.s3gen.flow.inference = hybrid_flow
        model.s3gen.hift_inference = hybrid_hift
        for owner, method, metric in ((model.s3gen, "inference", "decoderMs"),
                                      (model.watermarker, "apply_watermark", "watermarkMs")):
            def measured(fn, key):
                @functools.wraps(fn)
                def wrapper(*args, **kwargs):
                    started = time.perf_counter()
                    result = fn(*args, **kwargs)
                    self.metrics[key] = (time.perf_counter() - started) * 1000
                    return result
                return wrapper
            setattr(owner, method, measured(getattr(owner, method), metric))
        require(all(p.device.type == "cpu" for p in model.t3.text_head.parameters()), "NANOVOICE_DEVICE_MISMATCH")
        require(model.s3gen.trim_fade.device.type == "cpu", "NANOVOICE_DEVICE_MISMATCH")
        for name in ("tokenizer", "speaker_encoder"):
            require(all(p.device.type == "cpu" for p in getattr(model.s3gen, name).parameters()),
                    "NANOVOICE_DEVICE_MISMATCH")
        self.model = model
        require(self.network["network"]["blocked_attempts"] == 0, "NANOVOICE_OFFLINE_VIOLATION")
        stage("cuda_transfer_completed")

    def seed(self):
        random.seed(SEED)
        self.np.random.seed(SEED)
        self.torch.manual_seed(SEED)
        self.torch.cuda.manual_seed_all(SEED)

    def synthesize(self, text):
        torch, np = self.torch, self.np
        self.seed()
        self.metrics = {"seed": SEED, "temperature": TEMPERATURE}
        torch.cuda.synchronize(0)
        started = time.perf_counter()
        with torch.inference_mode():
            output = self.model.generate(text, temperature=TEMPERATURE)
        torch.cuda.synchronize(0)
        self.metrics["generationMs"] = (time.perf_counter() - started) * 1000
        require(output.ndim == 2 and output.shape[0] == 1, "NANOVOICE_INVALID_AUDIO")
        waveform = output[0].detach().cpu().numpy().astype(np.float32, copy=False)
        require(0 < len(waveform) <= 24000 * MAX_AUDIO_SECONDS and np.isfinite(waveform).all(),
                "NANOVOICE_INVALID_AUDIO")
        require(float(np.max(np.abs(waveform))) < 1 and float(np.sqrt(np.mean(waveform.astype(np.float64)**2))) > 1e-7,
                "NANOVOICE_INVALID_AUDIO")
        require(self.network["network"]["blocked_attempts"] == 0, "NANOVOICE_OFFLINE_VIOLATION")
        pcm = np.rint(np.clip(waveform * 32768, -32768, 32767)).astype("<i2").tobytes()
        self.metrics["audioMs"] = len(waveform) / 24
        self.metrics["pcmSha256"] = hashlib.sha256(pcm).hexdigest()
        return pcm, dict(self.metrics)
