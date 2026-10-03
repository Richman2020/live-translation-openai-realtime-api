"""Private CPU / hybrid-CUDA FP32 Nano whole-file timing and replay inputs.

Uses local pinned weights and explicit own-voice conditions. No phone calls,
network, streaming claim, model edits or changes to the accepted CPU samples.
Text-ready times are a synthetic workload, not captured phone timings.
"""
import argparse
from datetime import datetime, timezone
import functools
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time
import traceback

REPO = Path(__file__).resolve().parent.parent


def load_helper(name, filename):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = load_helper("nano_timing_probe_helpers", "probe-chatterbox-nano.py")
validator = load_helper("nano_timing_audio_validator", "build-nano-voice-review.py")
FIXTURES = [
    {"id": key, "text": text, "seed": 1709 + index, "group": "whole",
     "arrival_spacing_seconds": spacing}
    for index, ((key, text), spacing) in enumerate(zip(probe.FIXTURES, (7.16, 2.24, 4.36)))
] + [
    {"id": "phrase-greeting", "text": "Hello, thank you for calling.", "seed": 1809,
     "group": "phrase", "arrival_spacing_seconds": 1.5},
    {"id": "phrase-evening", "text": "I finish work at five, so we can talk this evening.", "seed": 1810,
     "group": "phrase", "arrival_spacing_seconds": 3.1},
    {"id": "phrase-availability", "text": "Please tell me what time is good for you.", "seed": 1811,
     "group": "phrase", "arrival_spacing_seconds": 2.6},
]
ACTIVE_T3_MODULES = ("tfmr", "cond_enc", "text_emb", "speech_emb", "speech_head")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def arguments():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model-dir", required=True, type=probe.private_path)
    p.add_argument("--reference", required=True, type=probe.private_path)
    p.add_argument("--upstream-dir", required=True, type=probe.private_path)
    p.add_argument("--accepted-report", required=True, type=probe.private_path)
    p.add_argument("--output-dir", required=True, type=probe.private_path)
    p.add_argument("--mode", choices=("cpu", "t3-cuda", "synthesis-cuda"), required=True)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--fixture-set", choices=("whole", "phrases", "both"), default="both")
    args = p.parse_args()
    require(1 <= args.threads <= 8 and 2 <= args.repeats <= 5, "Invalid bounded benchmark settings")
    return args


def save(output, report):
    report["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    path = output / "report.private.json"
    temporary = path.with_suffix(".json.part")
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def cuda_memory(torch):
    free, total = torch.cuda.mem_get_info(0)
    return {"free_bytes": free, "total_bytes": total,
            "allocated_bytes": torch.cuda.memory_allocated(0),
            "reserved_bytes": torch.cuda.memory_reserved(0),
            "peak_allocated_bytes": torch.cuda.max_memory_allocated(0),
            "peak_reserved_bytes": torch.cuda.max_memory_reserved(0),
            "scope": "Torch allocator / CUDA reported memory; not WDDM dedicated residency"}


def run(args, report):
    persist = lambda: save(args.output_dir, report)
    report["stage"] = "verify_pinned_inputs"
    persist()
    accepted_groups, _ = validator.load_nano(args.accepted_report)
    accepted = accepted_groups[0]["report"]["report"]
    require(all(row.get("generation_parameters", {}).get("temperature") == 0.75
                for row in accepted["fixtures"]), "Expected accepted B parameter report")
    require(probe.sha256(args.reference) == accepted["reference"]["sha256"], "Reference differs from B")
    revision = subprocess.check_output(["git", "-C", str(args.upstream_dir), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(args.upstream_dir), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    require(revision == probe.UPSTREAM_COMMIT and not dirty, "Expected unchanged pinned upstream")
    report["upstream"] = {"commit": revision,
                          "tts_turbo_sha256": probe.sha256(args.upstream_dir / "src/chatterbox/tts_turbo.py")}
    report["accepted_report_sha256"] = probe.sha256(args.accepted_report)
    report["reference_sha256"] = probe.sha256(args.reference)
    report["model_files"] = {}
    for filename, expected in probe.MODEL_HASHES.items():
        path = args.model_dir / filename
        require(probe.sha256(path) == expected, "Model checksum mismatch: " + filename)
        report["model_files"][filename] = {"sha256": expected, "bytes": path.stat().st_size}
    if (args.model_dir / "conds.pt").exists():
        require(probe.sha256(args.model_dir / "conds.pt") == probe.BUILTIN_CONDITIONAL_HASH,
                "Unexpected built-in conditionals")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      DO_NOT_TRACK="1", WANDB_DISABLED="true", TOKENIZERS_PARALLELISM="false",
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads))
    if args.mode == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    probe.prohibit_python_network(report)
    sys.path.insert(0, str(args.upstream_dir / "src"))
    report["stage"] = "import_runtime"
    persist()
    began = time.perf_counter()
    import numpy as np
    import torch
    import torchaudio
    import transformers
    import psutil
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    require(torch.__version__ == "2.7.1+cu118" and torchaudio.__version__ == "2.7.1+cu118",
            "Use the isolated pinned GPU runtime for both controls")
    require(transformers.__version__ == "5.2.0", "Expected the verified Transformers 5.2.0 implementation")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    report["import_seconds"] = time.perf_counter() - began
    report["runtime"] = {"python": sys.version, "torch": str(torch.__version__),
                         "torchaudio": str(torchaudio.__version__), "cuda_runtime": torch.version.cuda,
                         "transformers": transformers.__version__,
                         "threads": args.threads, "interop_threads": 1, "mode": args.mode,
                         "dtype": "float32", "autocast": False, "compile": False}
    report["host_ram_before_models"] = dict(psutil.virtual_memory()._asdict())
    is_cuda = args.mode != "cpu"
    if is_cuda:
        require(torch.cuda.is_available(), "CUDA unavailable; no silent fallback")
        torch.cuda.set_device(0)
        require(torch.cuda.get_device_capability(0) == (5, 2), "This bounded experiment targets GTX 980")
        require("sm_50" in torch.cuda.get_arch_list() or "sm_52" in torch.cuda.get_arch_list(),
                "Installed Torch lacks compatible Maxwell kernels")
        torch.backends.cuda.matmul.allow_tf32 = False
        torch.backends.cudnn.allow_tf32 = False
        torch.backends.cudnn.benchmark = False
        report["gpu"] = {"name": torch.cuda.get_device_name(0),
                         "capability": list(torch.cuda.get_device_capability(0)),
                         "arch_list": torch.cuda.get_arch_list(), "before_models": cuda_memory(torch)}
        # Keep room for the approximately 535 MiB active T3 weights plus context,
        # KV cache and temporary operations. Do not evict user applications.
        minimum_free_mib = 1500 if args.mode == "synthesis-cuda" else 1000
        require(report["gpu"]["before_models"]["free_bytes"] >= minimum_free_mib * 1024**2,
                f"Less than {minimum_free_mib} MiB CUDA free memory; preserve other applications")
    report["stage"] = "load_models_on_cpu"
    persist()
    random.seed(1709); np.random.seed(1709); torch.manual_seed(1709)
    began = time.perf_counter()
    model = ChatterboxTurboTTS.from_local(args.model_dir, device="cpu", nano=True)
    report["model_load_seconds"] = time.perf_counter() - began
    require(model.model_label == "Nano" and model.t3.hp.llama_config_name == "GPT2_small",
            "Expected Nano model")
    report["runtime"]["attention_implementation"] = model.t3.tfmr.config._attn_implementation
    require(type(model.watermarker).__name__ == "PerthImplicitWatermarker", "Official watermark required")
    model.conds = None
    report["stage"] = "prepare_reference_cpu"
    persist()
    began = time.perf_counter()
    model.prepare_conditionals(str(args.reference), exaggeration=0.0, norm_loudness=True)
    report["conditioning_seconds"] = time.perf_counter() - began
    report["conditioning"] = {"explicit_own_reference": True, "norm_loudness": True,
                              "reference_device": "cpu", "reference_uploaded": False}
    if is_cuda:
        began = time.perf_counter()
        for name in ACTIVE_T3_MODULES:
            getattr(model.t3, name).to(device="cuda:0", dtype=torch.float32)
        model.conds.t3.to(device="cuda:0", dtype=torch.float32)
        original_t3 = model.t3.inference_turbo

        @functools.wraps(original_t3)
        def hybrid_t3(*call_args, **call_kwargs):
            bound = inspect.signature(original_t3).bind(*call_args, **call_kwargs)
            bound.arguments["text_tokens"] = bound.arguments["text_tokens"].to("cuda:0")
            torch.cuda.synchronize(0)
            result = original_t3(*bound.args, **bound.kwargs)
            torch.cuda.synchronize(0)
            return result.cpu()

        model.t3.inference_turbo = hybrid_t3
        if args.mode == "synthesis-cuda":
            # Leave reference-only tokenizer / speaker encoder and their device
            # property on CPU. Bridge tensor arguments at the active flow/HiFT
            # boundaries; preserve integer dtypes and the upstream CPU target
            # noise creation. CFM prefix / HiFT RNG now run on CUDA, so the same
            # seed does not promise the accepted CPU waveform or voice quality.
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
            def hybrid_flow(*call_args, **call_kwargs):
                result = original_flow(*tensors_to(call_args, "cuda:0"),
                                       **tensors_to(call_kwargs, "cuda:0"))
                return tensors_to(result, "cpu")

            original_hift = model.s3gen.hift_inference

            @functools.wraps(original_hift)
            def hybrid_hift(speech_feat, cache_source=None):
                speech_feat = speech_feat.to(device="cuda:0")
                if cache_source is None:
                    cache_source = speech_feat.new_zeros(1, 1, 0)
                else:
                    cache_source = cache_source.to(device="cuda:0")
                result = model.s3gen.mel2wav.inference(speech_feat=speech_feat,
                                                       cache_source=cache_source)
                return tensors_to(result, "cpu")

            model.s3gen.flow.inference = hybrid_flow
            model.s3gen.hift_inference = hybrid_hift
            report["decoder_device_boundaries"] = {
                "flow": "CUDA FP32; CPU-created noise and conditions transferred at call boundary",
                "vocoder": "CUDA FP32; mel / cache transferred; waveform and source returned to CPU",
                "reference_encoders": "CPU", "trim_fade": "CPU", "watermark": "official CPU",
                "streaming": False,
            }
        torch.cuda.synchronize(0)
        report["device_setup_seconds"] = time.perf_counter() - began
        report["gpu"]["after_device_setup"] = cuda_memory(torch)
        torch.cuda.reset_peak_memory_stats(0)
    report["component_placement"] = {}
    for name, component in (("t3", model.t3), ("s3gen", model.s3gen), ("ve", model.ve)):
        placement = {}
        for parameter in component.parameters():
            require(not parameter.is_floating_point() or parameter.dtype == torch.float32,
                    "Unexpected model dtype")
            key = str(parameter.device)
            placement[key] = placement.get(key, 0) + parameter.numel() * parameter.element_size()
        report["component_placement"][name] = placement
    require(set(report["component_placement"]["ve"]) == {"cpu"}, "VE must remain CPU")
    if args.mode == "synthesis-cuda":
        for name in ("flow", "mel2wav"):
            require(all(p.device.type == "cuda" for p in getattr(model.s3gen, name).parameters()),
                    "Active decoder component was not moved to CUDA")
        for name in ("tokenizer", "speaker_encoder"):
            require(all(p.device.type == "cpu" for p in getattr(model.s3gen, name).parameters()),
                    "Reference-only component must remain CPU")
        require(model.s3gen.trim_fade.device.type == "cpu", "Trim/fade must remain CPU")
    else:
        require(set(report["component_placement"]["s3gen"]) == {"cpu"}, "Decoder must remain CPU")
    if is_cuda:
        for name in ACTIVE_T3_MODULES:
            require(all(p.device.type == "cuda" for p in getattr(model.t3, name).parameters()),
                    "Active T3 module was not moved to CUDA")
        require(all(p.device.type == "cpu" for p in model.t3.text_head.parameters()),
                "Unused text head must stay CPU")
    else:
        require(set(report["component_placement"]["t3"]) == {"cpu"}, "CPU control changed device")

    current = {}
    for owner, method_name, metric in ((model.s3gen, "inference", "decoder_wall_seconds"),
                                       (model.s3gen.flow, "inference", "flow_wall_seconds"),
                                       (model.s3gen, "hift_inference", "vocoder_wall_seconds"),
                                       (model.watermarker, "apply_watermark", "watermark_wall_seconds")):
        original = getattr(owner, method_name)
        def wrap(fn, metric_name):
            @functools.wraps(fn)
            def measured(*a, **kw):
                start = time.perf_counter()
                try:
                    return fn(*a, **kw)
                finally:
                    current["sample"][metric_name] = time.perf_counter() - start
            return measured
        setattr(owner, method_name, wrap(original, metric))

    fixtures = [f for f in FIXTURES if args.fixture_set == "both"
                or f["group"] == ("phrase" if args.fixture_set == "phrases" else "whole")]
    workload = [("warmup", 0, fixtures[0])] + [
        ("warm_repeat", repeat, fixture)
        for repeat in range(1, args.repeats + 1) for fixture in fixtures]
    report["resident_model"] = True
    report["generation_api"] = "OFFICIAL_WHOLE_FILE_GENERATE_NOT_STREAMING"
    for phase, repeat, fixture in workload:
        sample_id = f"{phase}-{repeat:02d}-{fixture['id']}"
        entry = {"id": sample_id, "phase": phase, "repeat": repeat,
                 "fixture_id": fixture["id"], "group": fixture["group"], "text": fixture["text"],
                 "seed": fixture["seed"], "status": "running", "human_listening": "PENDING"}
        current["sample"] = entry
        invocation = inspect.signature(model.generate).bind(fixture["text"], temperature=0.75)
        invocation.apply_defaults()
        entry["generation_parameters"] = {k: v for k, v in invocation.arguments.items() if k != "text"}
        accepted_fixture = next((row for row in accepted["fixtures"] if row["id"] == fixture["id"]), None)
        if fixture["group"] == "whole":
            require(accepted_fixture is not None
                    and accepted_fixture["text"] == fixture["text"]
                    and accepted_fixture["seed"] == fixture["seed"]
                    and accepted_fixture["generation_parameters"] == entry["generation_parameters"],
                    "Whole fixture inputs differ from the accepted B report")
        else:
            require(entry["generation_parameters"] == accepted["fixtures"][0]["generation_parameters"],
                    "Phrase synthesis parameters differ from the accepted B report")
        report["samples"].append(entry)
        report["stage"] = sample_id
        persist()
        random.seed(fixture["seed"]); np.random.seed(fixture["seed"]); torch.manual_seed(fixture["seed"])
        if is_cuda:
            torch.cuda.manual_seed_all(fixture["seed"])
            torch.cuda.synchronize(0)
        # Keep JSON serialization and disk I/O outside the generation timer.
        original = probe.instrument_t3(model, entry, lambda: None)
        start = time.perf_counter()
        try:
            with torch.inference_mode():
                output = model.generate(*invocation.args, **invocation.kwargs)
            if is_cuda:
                torch.cuda.synchronize(0)
        finally:
            entry["generate_wall_seconds"] = time.perf_counter() - start
            model.t3.inference_turbo = original
        require(output.ndim == 2 and output.shape[0] == 1, "Unexpected waveform shape")
        require(all(not trace["near_or_at_generation_limit"] for trace in entry["t3_calls"]),
                "Possible token-limit truncation; stop benchmark")
        waveform = output[0].detach().cpu().numpy().astype(np.float32, copy=False)
        metrics = probe.audio_metrics(waveform, model.sr)
        require(metrics["rms"] > 1e-7 and metrics["samples_at_or_above_full_scale"] == 0,
                "Silent or full-scale output; stop benchmark")
        entry["outputs"] = probe.write_audio_outputs(args.output_dir, sample_id, waveform, model.sr)
        entry["native"] = entry["outputs"]["files"][0]
        entry["whole_file_rtf"] = entry["generate_wall_seconds"] / metrics["duration_seconds"]
        entry["status"] = "completed"
        entry["memory"] = probe.memory_snapshot()
        if is_cuda:
            entry["cuda_memory"] = cuda_memory(torch)
        persist()
        print(json.dumps({"sample": sample_id, "seconds": metrics["duration_seconds"],
                          "generation_seconds": entry["generate_wall_seconds"],
                          "rtf": entry["whole_file_rtf"]}), flush=True)
    report["replay_mode"] = "SIMULATED_FIFO_FROM_MEASURED_WHOLE_FILE_RUNS"
    report["replay"] = []
    for group in ("whole", "phrase"):
        ready_at = 0.0
        for sample in report["samples"]:
            if sample["phase"] != "warm_repeat" or sample["group"] != group:
                continue
            fixture = next(f for f in fixtures if f["id"] == sample["fixture_id"])
            report["replay"].append({"sample_id": sample["id"], "scenario": group,
                                     "text_ready_at_seconds": ready_at})
            ready_at += fixture["arrival_spacing_seconds"]
    report["replay_scope"] = "Separate whole/phrase synthetic input schedules, not real text delta arrival or network playback"
    require(report["network"]["blocked_attempts"] == 0, "Unexpected network attempt")
    report["stage"] = "complete"
    report["status"] = "completed"
    persist()


def main():
    args = arguments()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report = {"schema": "nano-realtime-probe/1", "status": "running", "samples": [],
              "created_at_utc": datetime.now(timezone.utc).isoformat(),
              "script_sha256": probe.sha256(Path(__file__)), "mode": args.mode,
              "network": {"downloads": False, "uploads": False, "blocked_attempts": 0,
                          "python_socket_guard_active": False},
              "acceptance": {"human_quality": "PENDING", "speech_completeness": "UNVERIFIED",
                             "live_phone": "NOT_TESTED", "streaming_latency": "NOT_MEASURED"}}
    start = time.perf_counter()
    code = 0
    try:
        run(args, report)
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        traceback.print_exc()
        code = 1
    finally:
        report["total_wall_seconds"] = time.perf_counter() - start
        save(args.output_dir, report)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
