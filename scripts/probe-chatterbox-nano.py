"""Private, CPU-only Chatterbox Nano whole-file listening experiment.

Uses already downloaded official weights and the user's local reference. No
training, playback, phone integration, or download. Native audio retains the
official Perth watermark. Whole-file generation time is NOT streaming latency.
"""

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import random
import subprocess
import sys
import time
from datetime import datetime, timezone


REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROOT = (REPO / ".runtime").resolve()
UPSTREAM_COMMIT = "5de7a54aa4e5e2baadb0182dde554908b48b85c2"
MODEL_REVISION = "71ccd1d0081b430592cea481f4307e764e07bc64"
MODEL_HASHES = {
    "t3_nano_v1.safetensors": "72b110185087d945dbdf54dee4e333848e1811bdd5fd6cb16ceb8da50006f0c9",
    "s3gen_meanflow.safetensors": "d65cb687a2ed581ee6cc297e919ffefa63386944f42364ae13b78a594945514f",
    "ve.safetensors": "f0921cab452fa278bc25cd23ffd59d36f816d7dc5181dd1bef9751a7fb61f63c",
    "added_tokens.json": "72e4ab6acb0d9309ac3df4b526ae5fd80a2da5bc5ab7bb02d85096a374f69193",
    "merges.txt": "1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5",
    "special_tokens_map.json": "92ba8063bf40aa163eadebbfe0de07c2aebe44cf0d4a9e8726580b0781fd2640",
    "tokenizer_config.json": "bca16a2ac1ddbd78b8d6228f0031884cc74b6ea54b967d6f6d2ebae9ccde23e6",
    "vocab.json": "f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f",
}
BUILTIN_CONDITIONAL_HASH = "b1852099306fd6a7814eb9d0bd10186caba7249596cc23868f78a0eefbfa5033"
FIXTURES = (
    ("three-sentences", "Hello, thank you for calling. I finish work at five, so we can talk this evening. Please tell me what time is good for you."),
    ("availability", "Could you tell me what time works best for you?"),
    ("negation-time", "I do not need coffee. The appointment is tomorrow at three, not today."),
)


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def private_path(value):
    path = Path(value).resolve()
    if path == PRIVATE_ROOT or not path.is_relative_to(PRIVATE_ROOT):
        raise ValueError("Inputs and outputs must stay under this project's private .runtime")
    return path


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True, type=private_path)
    parser.add_argument("--reference", required=True, type=private_path,
                        help="User's own authorized local WAV, longer than 5 seconds")
    parser.add_argument("--output-dir", required=True, type=private_path,
                        help="New private directory; existing directories are never overwritten")
    parser.add_argument("--upstream-dir", required=True, type=private_path)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1709)
    parser.add_argument("--temperature", type=float, default=0.8,
                        help="T3 sampling temperature; not a speed or articulation control")
    args = parser.parse_args(argv)
    if not 1 <= args.threads <= 16 or not 0 <= args.seed <= 2**32 - 4:
        parser.error("threads must be in [1,16]; seed must be in [0,2^32-4]")
    if args.reference.suffix.lower() != ".wav":
        parser.error("reference must be a WAV")
    if not math.isfinite(args.temperature) or not 0.1 <= args.temperature <= 1.5:
        parser.error("temperature must be finite and in [0.1,1.5]")
    return args


def memory_snapshot():
    """Process peak working set, not system RAM or Python allocation accounting."""
    try:
        if os.name == "nt":
            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                    (name, ctypes.c_size_t) for name in (
                        "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                        "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                        "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            kernel.GetCurrentProcess.argtypes = []
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            return {"available": True, "rss_bytes": counters.WorkingSetSize,
                    "peak_rss_bytes": counters.PeakWorkingSetSize,
                    "scope": "PROCESS_LIFETIME_PEAK_WORKING_SET"}
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {"available": True, "peak_rss_bytes": int(peak if sys.platform == "darwin" else peak * 1024),
                "scope": "PROCESS_LIFETIME_PEAK_RSS"}
    except Exception as error:
        return {"available": False, "reason": type(error).__name__}


def prohibit_python_network(report):
    """Block all listed events, separating one known blocked local probe.

    urllib3 detects IPv6 during import by binding ::1:0 and catches the failure.
    That exact capability probe is still denied, but does not imply an attempted
    download/upload. Unknown binds, connections and DNS remain run failures.
    This Python audit guard is not an OS firewall.
    """
    import socket

    network = report["network"]
    network.setdefault("blocked_local_capability_probes", 0)
    network["counter_meaning"] = (
        "blocked_attempts counts unknown or network access events; "
        "blocked_local_capability_probes counts only the denied urllib3 "
        "IPv6 import capability bind. Both counters describe blocked actions.")
    blocked = {"socket.connect", "socket.bind", "socket.sendto", "socket.sendmsg",
               "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"}

    def audit(event, args):
        if event in blocked:
            known_local_probe = False
            if event == "socket.bind" and len(args) == 2:
                sock, address = args
                caller = sys._getframe(1)
                module = sys.modules.get("urllib3.util.connection")
                function = getattr(module, "_has_ipv6", None)
                # Verify the actual loaded function/code/globals, not just a
                # stack function name that another caller could share.
                known_local_probe = (
                    module is not None
                    and caller.f_globals is vars(module)
                    and caller.f_code is getattr(function, "__code__", None)
                    and caller.f_code.co_name == "_has_ipv6"
                    and caller.f_locals.get("sock") is sock
                    and caller.f_locals.get("host") == "::1"
                    and isinstance(sock, socket.socket)
                    and sock.family == socket.AF_INET6
                    and sock.type == socket.SOCK_STREAM
                    and address == ("::1", 0)
                )
                del caller
            if known_local_probe:
                network["blocked_local_capability_probes"] += 1
                network["last_blocked_local_capability_probe"] = {
                    "event": event, "address": ["::1", 0],
                    "caller": "urllib3.util.connection._has_ipv6",
                    "allowed": False,
                }
            else:
                network["blocked_attempts"] += 1
                network["last_blocked_event"] = event
            # Never allow the known probe either: urllib3 catches this failure
            # and uses its IPv4 fallback without opening a listening socket.
            raise RuntimeError("Offline probe blocked network event: " + event)

    sys.addaudithook(audit)
    network["python_socket_guard_active"] = True


def save_report(output, report):
    report["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    report["memory"] = memory_snapshot()
    temporary = output / "report.private.json.part"
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output / "report.private.json")


def audio_metrics(samples, sample_rate):
    import numpy as np
    values = np.asarray(samples)
    if values.ndim != 1 or not values.size or not np.isfinite(values).all():
        raise ValueError("Audio must be nonempty, finite and mono")
    absolute = np.abs(values.astype(np.float64))
    return {"frames": int(values.size), "sample_rate": int(sample_rate),
            "duration_seconds": float(values.size / sample_rate),
            "peak": float(absolute.max()), "rms": float(np.sqrt(np.mean(absolute**2))),
            "samples_at_or_above_full_scale": int(np.count_nonzero(absolute >= 1)),
            "samples_outside_full_scale": int(np.count_nonzero(absolute > 1)),
            "exact_zero_samples": int(np.count_nonzero(values == 0))}


def codec_helpers():
    path = REPO / "scripts" / "convert-own-voice-sample.py"
    spec = importlib.util.spec_from_file_location("local_rvc_codec_helpers", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.pcm16_to_mulaw, module.mulaw_to_pcm16, sha256(path)


def write_audio_outputs(output, fixture_id, waveform, sample_rate):
    """Preserve native float samples; phone conversion is separately declared."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    encode, decode, helper_hash = codec_helpers()
    native = output / (fixture_id + "-native.wav")
    # FLOAT avoids silently clipping/normalizing the official watermarked return.
    with native.open("xb") as destination:
        sf.write(destination, waveform, sample_rate, format="WAV", subtype="FLOAT")
    divisor = math.gcd(sample_rate, 8000)
    phone = resample_poly(waveform, 8000 // divisor, sample_rate // divisor)
    before = audio_metrics(phone, 8000)
    gain = min(1.0, .98 / before["peak"]) if before["peak"] else 1.0
    pcm = np.rint(np.clip(phone * gain * 32768, -32768, 32767)).astype(np.int16)
    encoded = encode(pcm)
    decoded = decode(encoded)
    phone_path = output / (fixture_id + "-phone-8k.wav")
    ulaw_path = output / (fixture_id + "-phone-8k.ulaw")
    with phone_path.open("xb") as destination:
        sf.write(destination, decoded, 8000, format="WAV", subtype="PCM_16")
    with ulaw_path.open("xb") as destination:
        destination.write(encoded.tobytes())
    files = []
    for path, samples, rate in ((native, waveform, sample_rate),
                                (phone_path, decoded.astype(np.float32) / 32768, 8000)):
        info = sf.info(path)
        files.append({"filename": path.name, "sha256": sha256(path),
                      "bytes": path.stat().st_size, "subtype": info.subtype,
                      "channels": info.channels, **audio_metrics(samples, rate)})
    files.append({"filename": ulaw_path.name, "sha256": sha256(ulaw_path),
                  "bytes": ulaw_path.stat().st_size, "encoding": "G711_MULAW_RAW",
                  "frames": int(encoded.size), "sample_rate": 8000,
                  "channels": 1, "duration_seconds": float(encoded.size / 8000)})
    return {"files": files, "native": "OFFICIAL_WATERMARKED_OUTPUT_SAVED_AS_FLOAT32_NO_GAIN_OR_TRIM",
            "phone": {"resampler": "scipy.signal.resample_poly", "gain": gain,
                      "pre_gain_metrics": before, "codec_helper_sha256": helper_hash,
                      "note": "8 kHz mu-law roundtrip only; not a live call or watermark robustness test"}}


def instrument_t3(model, fixture_report, persist):
    """Observe the bound method's returned tensor without changing its algorithm."""
    original = model.t3.inference_turbo
    signature = inspect.signature(original)
    stop_id = int(model.t3.hp.stop_speech_token)

    def observed(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        loop_limit = int(bound.arguments["max_gen_len"])
        if loop_limit != 1000:
            raise RuntimeError("Pinned upstream's expected token loop limit changed")
        started = time.perf_counter()
        result = original(*args, **kwargs)
        elapsed = time.perf_counter() - started
        if result.ndim != 2 or result.shape[0] != 1:
            raise ValueError("Unexpected T3 token shape")
        count = int(result.shape[1])
        contains_stop = bool((result == stop_id).any().item())
        trace = {"wall_seconds": elapsed, "returned_shape": list(result.shape),
                 "returned_token_count": count, "returned_tokens_below_6561": int((result < 6561).sum().item()),
                 "stop_token_id": stop_id, "stop_token_present_in_return": contains_stop,
                 "eos_status": "UNKNOWN_UPSTREAM_REMOVES_FINAL_EOS_BEFORE_RETURN",
                 "configured_generation_loop_limit": loop_limit,
                 "theoretical_max_sampled_tokens": loop_limit + 1,
                 "definite_limit_without_terminal_eos": count == loop_limit + 1,
                 "near_or_at_generation_limit": count >= loop_limit,
                 "boundary": "An initial token precedes the loop. A shorter return may be EOS or the all-infinite-logits early exit; it does not prove complete speech."}
        fixture_report.setdefault("t3_calls", []).append(trace)
        persist()
        if count == 0 or count > loop_limit + 1:
            raise ValueError("Invalid T3 returned token count")
        return result

    model.t3.inference_turbo = observed
    return original


def run(args, report):
    persist = lambda: save_report(args.output_dir, report)
    for path in (args.reference, args.upstream_dir / "src/chatterbox/tts_turbo.py"):
        if not path.is_file():
            raise FileNotFoundError(path)
    report["stage"] = "verify_local_provenance"
    revision = subprocess.check_output(["git", "-C", str(args.upstream_dir), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(args.upstream_dir), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    if revision != UPSTREAM_COMMIT or dirty:
        raise ValueError("Expected the unchanged pinned official upstream checkout")
    report["upstream"] = {"commit": revision, "tts_turbo_sha256": sha256(args.upstream_dir / "src/chatterbox/tts_turbo.py")}
    report["model"] = {"repository": "ResembleAI/chatterbox-nano", "revision": MODEL_REVISION,
                       "files": {}, "device": "cpu", "nano": True}
    for filename, expected in MODEL_HASHES.items():
        path = args.model_dir / filename
        actual = sha256(path)
        if actual != expected:
            raise ValueError("Official model checksum mismatch: " + filename)
        report["model"]["files"][filename] = {"sha256": actual, "bytes": path.stat().st_size}
    builtin = args.model_dir / "conds.pt"
    if builtin.exists() and sha256(builtin) != BUILTIN_CONDITIONAL_HASH:
        raise ValueError("Unexpected optional built-in conditional file")
    persist()
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1",
                       "WANDB_DISABLED": "true", "TOKENIZERS_PARALLELISM": "false",
                       "CUDA_VISIBLE_DEVICES": "", "OMP_NUM_THREADS": str(args.threads),
                       "MKL_NUM_THREADS": str(args.threads)})
    prohibit_python_network(report)
    sys.path.insert(0, str(args.upstream_dir / "src"))
    report["stage"] = "import_libraries"
    persist()
    started = time.perf_counter()
    import numpy as np
    import soundfile as sf
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    report["library_import_seconds"] = time.perf_counter() - started
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    report["runtime"] = {"python": sys.version, "torch": str(torch.__version__),
                         "threads": torch.get_num_threads(), "interop_threads": torch.get_num_interop_threads()}
    reference, rate = sf.read(args.reference, dtype="float32", always_2d=True)
    if reference.shape[1] != 1 or not 5 < len(reference) / rate <= 60:
        raise ValueError("Reference must be mono and longer than 5 but no more than 60 seconds")
    report["reference"] = {"filename": args.reference.name, "sha256": sha256(args.reference),
                           **audio_metrics(reference[:, 0], rate),
                           "use": "EXPLICIT_USER_OWN_VOICE_LOCAL_CONDITIONING", "uploaded": False}
    if not np.any(reference) or report["reference"]["rms"] < 1e-5:
        raise ValueError("Reference is silent or effectively empty")

    def seed(value):
        random.seed(value)
        np.random.seed(value)
        torch.manual_seed(value)

    seed(args.seed)
    report["stage"] = "load_models_cpu"
    persist()
    started = time.perf_counter()
    model = ChatterboxTurboTTS.from_local(args.model_dir, device="cpu", nano=True)
    report["model_load_seconds"] = time.perf_counter() - started
    if model.model_label != "Nano" or len(model.tokenizer) != 50276:
        raise ValueError("Unexpected model type or tokenizer")
    if model.t3.hp.llama_config_name != "GPT2_small":
        raise ValueError("Expected Nano GPT2_small configuration")
    report["model"]["parameter_counts"] = {}
    for name in ("t3", "s3gen", "ve"):
        module = getattr(model, name)
        tensors = list(module.parameters()) + list(module.buffers())
        if any(item.device.type != "cpu" for item in tensors):
            raise ValueError("CPU-only contract violated: " + name)
        report["model"]["parameter_counts"][name] = sum(item.numel() for item in module.parameters())
    if type(model.watermarker).__name__ != "PerthImplicitWatermarker":
        raise ValueError("Expected official Perth watermarker")
    report["watermark"] = {"implementation": type(model.watermarker).__module__ + "." + type(model.watermarker).__name__,
                           "official_generate_apply_watermark_retained": True, "detection_test": "NOT_RUN"}
    report["stage"] = "prepare_own_voice_conditionals"
    persist()
    # Discard any built-in conditioning, then explicitly build this user's reference.
    model.conds = None
    started = time.perf_counter()
    model.prepare_conditionals(str(args.reference), exaggeration=0.0, norm_loudness=True)
    report["conditioning_seconds"] = time.perf_counter() - started
    if model.conds is None:
        raise RuntimeError("Explicit own-voice conditioning did not produce conditionals")
    report["conditioning"] = {"explicit_reference": True, "norm_loudness_requested": True,
                              "target_lufs_upstream": -27, "exaggeration": 0,
                              "limits": "Official path uses first 10s for decoder, first 15s for T3 prompt, full reference for speaker encoder"}
    persist()
    for index, (fixture_id, text) in enumerate(FIXTURES):
        invocation = inspect.signature(model.generate).bind(text, temperature=args.temperature)
        invocation.apply_defaults()
        fixture = {"id": fixture_id, "text": text, "seed": args.seed + index,
                   "status": "generating", "streaming": False,
                   "quality_accepted": False, "human_listening": "PENDING",
                   "generation_parameters": {key: value for key, value in invocation.arguments.items()
                                             if key != "text"},
                   "parameter_scope": "Sampling settings only; no speed change or post-generation time stretch"}
        report["fixtures"].append(fixture)
        report["stage"] = "generate_" + fixture_id
        persist()
        seed(fixture["seed"])
        original = instrument_t3(model, fixture, persist)
        started = time.perf_counter()
        try:
            with torch.inference_mode():
                generated = model.generate(*invocation.args, **invocation.kwargs)
        finally:
            fixture["generate_wall_seconds"] = time.perf_counter() - started
            model.t3.inference_turbo = original
        if generated.ndim != 2 or generated.shape[0] != 1:
            raise ValueError("Unexpected generated waveform shape")
        fixture["official_output_dtype"] = str(generated.dtype)
        fixture["native_float32_cast_needed"] = generated.dtype != torch.float32
        waveform = generated[0].detach().cpu().numpy().astype(np.float32, copy=False)
        metrics = audio_metrics(waveform, int(model.sr))
        if metrics["rms"] < 1e-7:
            raise ValueError("Generated audio is effectively silent")
        fixture["native_metrics"] = metrics
        fixture["whole_file_rtf"] = fixture["generate_wall_seconds"] / metrics["duration_seconds"]
        fixture["first_audio_latency_seconds"] = None
        fixture["latency_scope"] = "Whole-file T3 + decoder + official watermark; excludes load, conditioning and file encoding. No streaming latency measurement."
        fixture["outputs"] = write_audio_outputs(args.output_dir, fixture_id, waveform, int(model.sr))
        fixture["warnings"] = []
        if any(call["near_or_at_generation_limit"] for call in fixture["t3_calls"]):
            fixture["warnings"].append("NEAR_OR_AT_TOKEN_LIMIT_POSSIBLE_TRUNCATION_REQUIRES_LISTENING")
        if metrics["samples_outside_full_scale"]:
            fixture["warnings"].append("NATIVE_FLOAT_EXCEEDS_FULL_SCALE_PLAYBACK_MAY_CLIP")
        fixture["status"] = "generated_for_listening"
        fixture["memory"] = memory_snapshot()
        persist()
        print(json.dumps({"fixture": fixture_id, "duration_seconds": metrics["duration_seconds"],
                          "generate_wall_seconds": fixture["generate_wall_seconds"],
                          "whole_file_rtf": fixture["whole_file_rtf"], "status": fixture["status"]}), flush=True)
    if report["network"]["blocked_attempts"]:
        raise RuntimeError("A dependency attempted network access; inspect the private report")


def main():
    args = arguments()
    # An existing directory, even an empty one, is never reused automatically.
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report = {"schema": "chatterbox-nano-offline-probe/1", "status": "running",
              "scope": "LOCAL_CPU_WHOLE_FILE_OWN_VOICE_LISTENING_EXPERIMENT",
              "created_at_utc": datetime.now(timezone.utc).isoformat(),
              "script_sha256": sha256(Path(__file__)), "fixtures": [],
              "network": {"downloads": False, "uploads": False, "blocked_attempts": 0,
                          "blocked_local_capability_probes": 0,
                          "python_socket_guard_active": False,
                          "boundary": "Python socket audit guard and HF offline mode; not an OS firewall"},
              "acceptance": {"naturalness": "PENDING_HUMAN_LISTENING", "voice_similarity": "PENDING_HUMAN_LISTENING",
                             "speech_completeness": "PENDING_HUMAN_LISTENING", "live_phone": "NOT_TESTED",
                             "streaming_latency": "NOT_TESTED", "quality_accepted": False}}
    began = time.perf_counter()
    save_report(args.output_dir, report)
    exit_code = 0
    try:
        run(args, report)
        report["status"] = "completed_for_listening"
        report["stage"] = "complete"
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        if report["fixtures"] and report["fixtures"][-1]["status"] == "generating":
            report["fixtures"][-1]["status"] = "failed"
        print("Probe failed; inspect report.private.json: " + type(error).__name__, file=sys.stderr, flush=True)
        exit_code = 1
    finally:
        report["total_wall_seconds"] = time.perf_counter() - began
        save_report(args.output_dir, report)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
