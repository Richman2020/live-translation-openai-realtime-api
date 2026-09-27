"""Offline RVC compute probe; never records, trains a voice, or places a call.

Run inside a separate Python environment with an audited official RVC checkout.
The checkpoint must be an inference-format, non-personalized official base model.
Results establish compute throughput only, not voice quality or phone latency.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time
import traceback
from types import SimpleNamespace


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path, help="Local WAV; no upload")
    parser.add_argument("--output", required=True, type=Path, help="New JSON, never overwritten")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--block-ms", type=int, default=200)
    parser.add_argument("--context-ms", type=int, default=1000)
    parser.add_argument("--crossfade-ms", type=int, default=40)
    duration = parser.add_mutually_exclusive_group()
    duration.add_argument("--seconds", type=float, default=None,
                          help="Seconds of simulated source audio, not wall time")
    duration.add_argument("--iterations", type=int)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--pace", action="store_true", help="Wait for real-time block arrivals")
    parser.add_argument("--force-legacy-cuda", action="store_true",
                        help="Experimental process-only FP32 override of upstream GPU gate")
    args = parser.parse_args()
    if args.block_ms < 20 or args.block_ms > 1500 or args.block_ms % 10:
        parser.error("block-ms must be a multiple of 10 in [20,1500]")
    if args.context_ms < 0 or args.context_ms % 10:
        parser.error("context-ms must be a nonnegative multiple of 10")
    if not 10 <= args.crossfade_ms <= 150 or args.crossfade_ms % 10:
        parser.error("crossfade-ms must be a multiple of 10 in [10,150]")
    if args.context_ms + args.crossfade_ms + args.block_ms + 10 > 10000:
        parser.error("total input window must be <= 10000 ms for upstream pitch cache")
    if args.threads < 1 or args.warmup < 1:
        parser.error("threads and warmup must be positive")
    if args.iterations is not None and args.iterations < 1:
        parser.error("iterations must be positive")
    if args.seconds is not None and (not math.isfinite(args.seconds) or args.seconds <= 0):
        parser.error("seconds must be positive and finite")
    if args.force_legacy_cuda and args.device != "cuda":
        parser.error("force-legacy-cuda requires device=cuda")
    for field in ("upstream", "checkpoint", "input", "output"):
        setattr(args, field, getattr(args, field).resolve())
    return args


def run(args, report):
    # These settings affect this process only. No provider, microphone, or GUI is opened.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["RVC_CUDA_GRAPH"] = "0"
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    if not (args.upstream / "infer/rtrvc.py").is_file():
        raise ValueError("Expected current official RVC infer/rtrvc.py checkout")
    for field in ("checkpoint", "input"):
        path = getattr(args, field)
        if not path.is_file():
            raise FileNotFoundError(path)
        report[field] = {"filename": path.name, "sha256": sha256(path)}
    if args.input.suffix.lower() != ".wav":
        raise ValueError("Input must be a local WAV")
    report["upstream_commit"] = subprocess.check_output(
        ["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True
    ).strip()
    model_hashes = {
        "assets/hubert_base/pytorch_model.bin": "cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5",
        "assets/rmvpe/rmvpe.pt": "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193",
    }
    report["model_sha256"] = {}
    for relative, expected in model_hashes.items():
        actual = sha256(args.upstream / relative)
        if actual != expected:
            raise ValueError(f"Unexpected official model checksum: {relative}")
        report["model_sha256"][relative] = actual
    sys.path.insert(0, str(args.upstream))
    os.chdir(args.upstream)

    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    import torch

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    report["torch"] = {"version": torch.__version__, "cuda_runtime": torch.version.cuda}
    device = torch.device("cuda:0" if args.device == "cuda" else "cpu")
    if device.type == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("Requested CUDA is unavailable; no silent CPU fallback")
        report["gpu"] = {
            "name": torch.cuda.get_device_name(device),
            "compute_capability": list(torch.cuda.get_device_capability(device)),
            "total_bytes": torch.cuda.get_device_properties(device).total_memory,
            "free_bytes_before_load": torch.cuda.mem_get_info(device)[0],
            "compiled_architectures": torch.cuda.get_arch_list(),
        }
        import configs.config as upstream_config
        original_selector = upstream_config.get_device_dtype_sm
        selected = original_selector(0)
        report["upstream_default_device"] = str(selected[0])
        if str(selected[0]).startswith("cpu") and not args.force_legacy_cuda:
            raise RuntimeError("Upstream rejects this GPU; explicit legacy probe flag required")
        if args.force_legacy_cuda:
            def probe_selector(index):
                if index == 0:
                    major, minor = torch.cuda.get_device_capability(0)
                    memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
                    return torch.device("cuda:0"), torch.float32, major + minor / 10, memory
                return original_selector(index)
            upstream_config.get_device_dtype_sm = probe_selector
        # Exercise actual CUDA kernels before loading models. CUDA visibility is insufficient.
        smoke = torch.randn(1, 8, 256, device=device)
        kernel = torch.randn(8, 8, 3, device=device)
        torch.nn.functional.conv1d(smoke, kernel).sum().item()
        torch.cuda.synchronize(device)
        del smoke, kernel
        torch.cuda.reset_peak_memory_stats(device)

    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    if not all(key in checkpoint for key in ("config", "weight", "version", "f0")):
        raise ValueError("Checkpoint must be converted to inference format first")
    if checkpoint["version"] != "v2" or checkpoint["f0"] != 1:
        raise ValueError("This probe requires the v2 F0 base model")
    provenance = checkpoint.get("probe_metadata", {})
    if (provenance.get("role") != "official-unpersonalized-base" or
            provenance.get("source_sha256") != "2332611297b8d88c7436de8f17ef5f07a2119353e962cd93cda5806d59a1133d"):
        raise ValueError("Use prepare-rvc-probe.py to verify and prepare the official base checkpoint")
    report["checkpoint"]["provenance"] = provenance
    report["checkpoint"].update({"version": "v2", "f0": 1,
                                  "sample_rate": checkpoint["config"][-1]})
    del checkpoint
    from infer.rtrvc import RVC
    model_load_start = time.perf_counter()
    model = RVC(0, 0.0, str(args.checkpoint), "", 0.0,
                SimpleNamespace(device=str(device), is_half=False))
    report["model_load_seconds"] = time.perf_counter() - model_load_start
    # Upstream constructor catches errors instead of raising them.
    if not all(getattr(model, attr, None) is not None for attr in ("model", "net_g", "tgt_sr")):
        raise RuntimeError("RVC initialization failed (upstream may have logged the exception)")
    audio, sample_rate = sf.read(str(args.input), dtype="float32", always_2d=True)
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Input audio is empty or contains non-finite samples")
    report["input"].update({"sample_rate": sample_rate, "channels": audio.shape[1],
                             "duration_seconds": len(audio) / sample_rate})
    audio = audio.mean(axis=1)
    if sample_rate != 16000:
        divisor = math.gcd(sample_rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, sample_rate // divisor).astype("float32")
    source = torch.from_numpy(audio)  # Host-to-device block copies are timed below.
    block = args.block_ms * 16
    buffer = torch.zeros((args.context_ms + args.crossfade_ms + args.block_ms + 10) * 16,
                         device=device, dtype=torch.float32)
    skip_head = args.context_ms // 10
    return_length = (args.block_ms + min(args.crossfade_ms, 40) + 10) // 10
    cursor = 0

    def synchronize():
        if device.type == "cuda":
            torch.cuda.synchronize(device)

    def tick():
        nonlocal cursor
        indexes = (torch.arange(block) + cursor) % len(source)
        incoming = source[indexes]
        cursor = (cursor + block) % len(source)
        buffer[:-block] = buffer[block:].clone()
        buffer[-block:] = incoming.to(device)
        result = model.infer(buffer, block, skip_head, return_length, "rmvpe")
        result = result.detach().cpu()
        if result.numel() == 0 or not torch.isfinite(result).all():
            raise RuntimeError("Inference returned empty/non-finite audio")
        return result.numel()

    warmup_timings = []
    for _ in range(args.warmup):
        synchronize()
        warmup_start = time.perf_counter()
        tick()
        synchronize()
        warmup_timings.append((time.perf_counter() - warmup_start) * 1000)
    report["warmup"] = {"first_tick_ms": warmup_timings[0],
                        "total_ms": sum(warmup_timings), "iterations": args.warmup,
                        "excluded_from_steady_state": True}
    synchronize()
    report["actual_devices"] = {
        "hubert": str(next(model.model.parameters()).device),
        "decoder": str(next(model.net_g.parameters()).device),
        "rmvpe": str(next(model.model_rmvpe.model.parameters()).device),
    }
    report["actual_dtypes"] = {
        "hubert": str(next(model.model.parameters()).dtype),
        "decoder": str(next(model.net_g.parameters()).dtype),
        "rmvpe": str(next(model.model_rmvpe.model.parameters()).dtype),
    }
    if any(value != "torch.float32" for value in report["actual_dtypes"].values()):
        raise RuntimeError("This FP32 probe cannot accept a stage silently selecting lower precision")
    if any(value.split(":")[0] != device.type for value in report["actual_devices"].values()):
        raise RuntimeError("A pipeline stage silently selected a different device")
    # Warm the kernels, then reset stream state so the measured stream starts with silence.
    buffer.zero_()
    model.cache_pitch.zero_()
    model.cache_pitchf.zero_()
    cursor = 0
    iterations = args.iterations or math.ceil((args.seconds or 30) * 1000 / args.block_ms)
    timings, queues, backlog = [], [], 0.0
    arrival_lateness, finish_lateness = [], []
    start = time.perf_counter()
    for index in range(iterations):
        if args.pace:
            wait = start + index * args.block_ms / 1000 - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
        synchronize()
        before = time.perf_counter()
        if args.pace:
            arrival_lateness.append(max(0.0, (before - start) * 1000 - index * args.block_ms))
        output_samples = tick()
        synchronize()
        elapsed = (time.perf_counter() - before) * 1000
        if args.pace:
            finish_lateness.append(max(0.0, (time.perf_counter() - start) * 1000 - (index + 1) * args.block_ms))
        timings.append(elapsed)
        backlog = max(0.0, backlog + elapsed - args.block_ms)
        queues.append(backlog)
    report["measurement"] = {
        "iterations": iterations,
        "source_audio_seconds": iterations * args.block_ms / 1000,
        "wall_seconds": time.perf_counter() - start,
        "p50_ms": percentile(timings, .50), "p95_ms": percentile(timings, .95),
        "p99_ms": percentile(timings, .99), "max_ms": max(timings),
        "mean_ms": statistics.mean(timings),
        "compute_rtf": sum(timings) / (iterations * args.block_ms),
        "deadline_misses": sum(value > args.block_ms for value in timings),
        "simulated_backlog_final_ms": backlog,
        "simulated_backlog_max_ms": max(queues),
        "nominal_chunk_and_overlap_buffer_ms": args.block_ms + args.crossfade_ms + 10,
        "last_output_samples_before_overlap": output_samples,
        "all_tick_ms": timings,
    }
    if args.pace:
        report["measurement"]["paced_clock"] = {
            "start_lateness_p95_ms": percentile(arrival_lateness, .95),
            "finish_lateness_p95_ms": percentile(finish_lateness, .95),
            "finish_lateness_max_ms": max(finish_lateness),
            "finish_lateness_final_ms": finish_lateness[-1],
            "missed_completion_deadlines": sum(value > 0 for value in finish_lateness),
        }
    if device.type == "cuda":
        report["gpu"].update({"peak_allocated_bytes": torch.cuda.max_memory_allocated(device),
                               "peak_reserved_bytes": torch.cuda.max_memory_reserved(device),
                               "free_bytes_after_run": torch.cuda.mem_get_info(device)[0]})
    report["status"] = "completed"


def main():
    args = arguments()
    report = {
        "schema": "rvc-local-compute-probe/1.0", "status": "started",
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": platform.python_version(), "platform": platform.platform(),
        "probe_sha256": sha256(Path(__file__).resolve()),
        "settings": {key: value for key, value in vars(args).items() if not isinstance(value, Path)},
        "scope": {
            "checkpoint_role": "Non-personalized official base model; no clone-quality conclusion",
            "pipeline": "HuBERT + RMVPE + v2 F0 decoder; FP32; host transfers included",
            "index_rate": 0, "cuda_graph": False,
            "excluded": ["input resampling", "retrieval index", "SOLA/crossfade stitching",
                         "telephone codec", "network", "sound device", "translation engine"],
            "latency": "Offline compute and nominal buffers only; not measured mouth-to-ear latency",
            "source_repetition": "Input WAV loops when exhausted; no new recording",
        },
    }
    # Reserve the report before loading anything; never destroy a previous measurement.
    with args.output.open("x", encoding="utf-8") as destination:
        code = 0
        try:
            run(args, report)
        except Exception as error:
            report["status"] = "failed"
            report["error"] = {"type": type(error).__name__, "message": str(error),
                               "traceback": traceback.format_exc()}
            code = 1
        finally:
            report["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            json.dump(report, destination, ensure_ascii=False, indent=2, allow_nan=False)
            destination.write("\n")
        print(json.dumps({"status": report["status"], "report": str(args.output)}, ensure_ascii=False))
        return code


if __name__ == "__main__":
    sys.exit(main())
