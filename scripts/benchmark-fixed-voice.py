"""Offline text-ready TTS: Nano sentence pipeline vs Pocket native sentence streams.

All model/reference/output paths are private .runtime paths. Models must already
exist locally. This measures synthesis availability, not translation or a call.
"""

import argparse
from datetime import datetime, timezone
import functools
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fixed_voice_probe", REPO / "scripts/probe-chatterbox-nano.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
ACTIVE_T3 = ("tfmr", "cond_enc", "text_emb", "speech_emb", "speech_head")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=("nano", "pocket"), required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--reference", type=probe.private_path, required=True)
    parser.add_argument("--output-dir", type=probe.private_path, required=True)
    parser.add_argument("--model-dir", type=probe.private_path)
    parser.add_argument("--upstream-dir", type=probe.private_path)
    parser.add_argument("--pocket-config", type=probe.private_path)
    parser.add_argument("--voice-state", type=probe.private_path,
                        help="Pocket public preset safetensors; reference WAV is provenance only for Pocket")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--seed", type=int, default=2709)
    args = parser.parse_args(argv)
    require(1 <= args.threads <= 8 and 1 <= args.repeats <= 5, "Invalid bounded benchmark settings")
    require(0 <= args.seed <= 2**32 - 1000, "Invalid random seed")
    require(args.reference.is_file() and args.reference.suffix.lower() == ".wav", "Local WAV reference required")
    if args.engine == "nano":
        require(args.model_dir is not None and args.upstream_dir is not None, "Nano requires model-dir and upstream-dir")
    else:
        require(args.pocket_config is not None, "Pocket requires pocket-config")
        require(args.voice_state is not None and args.voice_state.is_file()
                and args.voice_state.suffix == ".safetensors", "Pocket requires local public voice-state safetensors")
    return args


def read_fixtures(path):
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    passages = document["passages"]
    require(len(passages) == 2, "Expected exactly two coherent long-form passages")
    ids = set()
    for passage in passages:
        key = passage["id"]
        require(isinstance(key, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", key), "Unsafe passage id")
        require(key not in ids, "Duplicate passage id")
        ids.add(key)
        sentences = passage["sentences"]
        require(isinstance(sentences, list) and 6 <= len(sentences) <= 12, "Each passage needs 6-12 explicit sentence boundaries")
        require(all(isinstance(text, str) and 10 <= len(text.strip()) <= 350 for text in sentences),
                "Expected bounded nonempty English sentences")
        require(all(not re.search(r"[\u3400-\u9fff]", text) for text in sentences), "TTS inputs must be translated English")
        if passage.get("source_language") == "zh":
            require(len(passage.get("source_sentences", [])) == len(sentences), "Chinese source/translation boundary mismatch")
    require({p.get("source_language") for p in passages} == {"en", "zh"}, "Need authored English and Chinese-to-English passages")
    return document


def save_report(output, report):
    report["updated_at_utc"] = datetime.now(timezone.utc).isoformat()
    temporary = output / "report.private.json.part"
    temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(output / "report.private.json")


def stage(args, report, name):
    report["stage"] = name
    save_report(args.output_dir, report)
    print(json.dumps({"stage": name, "engine": args.engine}), flush=True)


def file_record(path):
    return {"filename": path.name, "sha256": probe.sha256(path), "bytes": path.stat().st_size}


def upstream_record(path, expected=None):
    revision = subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    require(not dirty and (expected is None or revision == expected), "Expected unchanged pinned upstream")
    return {"commit": revision, "tracked_files_clean": True}


def verify_pocket_config(path):
    """Refuse URLs and unresolved paths before loading any model or reference."""
    import yaml
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    files = {}

    def visit(value, prefix=""):
        if isinstance(value, dict):
            for key, item in value.items():
                field = prefix + str(key)
                if isinstance(item, str):
                    require(not re.match(r"(?:https?|hf|s3)://", item), "Pocket config contains remote path: " + field)
                    if key.endswith("_path") or key == "weights_path_without_voice_cloning":
                        candidate = probe.private_path(item)
                        require(Path(item).is_absolute() and candidate.is_file(), "Use absolute local Pocket files: " + field)
                        files[field] = file_record(candidate)
                visit(item, field + ".")
        elif isinstance(value, list):
            for item in value:
                visit(item, prefix)

    visit(document)
    require("weights_path" in files or ("flow_lm.weights_path" in files and "mimi.weights_path" in files),
            "Pocket config must explicitly load pretrained weights")
    require("flow_lm.lookup_table.tokenizer_path" in files, "Pocket tokenizer must be local")
    return {"config": file_record(path), "files": files}


def energy_onset(samples, sample_rate, threshold=0.01):
    """Two consecutive 10ms RMS frames; an energy proxy, not linguistic VAD."""
    import numpy as np
    frame = max(1, round(sample_rate * .010))
    count = len(samples) // frame
    if count < 2:
        return None
    frames = np.asarray(samples[:count * frame], dtype=np.float64).reshape(count, frame)
    active = np.sqrt(np.mean(frames * frames, axis=1)) >= threshold
    pairs = np.flatnonzero(active[:-1] & active[1:])
    if not pairs.size:
        return None
    index = int(pairs[0])
    return {"onset_frame": index * frame, "confirmation_end_frame": (index + 2) * frame,
            "leading_silence_seconds": index * frame / sample_rate}


def analyze_timeline(chunks, waveform, sample_rate):
    """Instant enqueue + ideal FIFO playback; this is a replay, never a phone trace."""
    require(bool(chunks), "No chunks generated")
    playback_end = 0.0
    frames = 0
    previous_available = -1.0
    starvation = []
    for index, chunk in enumerate(chunks):
        available = chunk["available_at_seconds"]
        require(math.isfinite(available) and available >= previous_available, "Chunk availability must be monotonic")
        count = chunk["frames"]
        require(isinstance(count, int) and count > 0, "Invalid chunk frame count")
        chunk["audio_start_frame"] = frames
        frames += count
        chunk["audio_end_frame"] = frames
        duration = count / sample_rate
        chunk["audio_seconds"] = duration
        start = max(available, playback_end)
        gap = max(0.0, available - playback_end)
        chunk["ideal_fifo_start_seconds"] = start
        chunk["ideal_fifo_end_seconds"] = start + duration
        chunk["ideal_fifo_gap_before_seconds"] = gap
        if index and gap > 0:
            starvation.append({"before_chunk": index, "start_seconds": playback_end,
                               "end_seconds": available, "duration_seconds": gap})
        playback_end = start + duration
        previous_available = available
    require(frames == len(waveform), "Chunk sizes disagree with saved waveform")
    onset = energy_onset(waveform, sample_rate)
    result = {"first_chunk_seconds": chunks[0]["available_at_seconds"],
              "audio_seconds": frames / sample_rate,
              "initial_wait_seconds": chunks[0]["available_at_seconds"],
              "buffer_starvation_count": len(starvation), "buffer_starvation": starvation,
              "buffer_starvation_seconds": sum(gap["duration_seconds"] for gap in starvation),
              "ideal_fifo_complete_seconds": playback_end,
              "first_voiced_data_available_seconds": None,
              "ideal_fifo_first_voiced_seconds": None, "leading_silence_seconds": None}
    if onset:
        ready = next(c for c in chunks if c["audio_end_frame"] >= onset["confirmation_end_frame"])
        playing = next(c for c in chunks if c["audio_end_frame"] > onset["onset_frame"])
        result.update(onset)
        result["first_voiced_data_available_seconds"] = ready["available_at_seconds"]
        result["ideal_fifo_first_voiced_seconds"] = playing["ideal_fifo_start_seconds"] + (
            onset["onset_frame"] - playing["audio_start_frame"]) / sample_rate
    return result


def render_fifo(chunks, waveform, sample_rate):
    import numpy as np
    # Rounded sample placement introduces <= one sample of timing quantization.
    total = max(round(c["ideal_fifo_start_seconds"] * sample_rate) + c["frames"] for c in chunks)
    result = np.zeros(total, dtype=np.float32)
    previous_end = 0
    for chunk in chunks:
        start = max(previous_end, round(chunk["ideal_fifo_start_seconds"] * sample_rate))
        end = start + chunk["frames"]
        require(end <= total, "FIFO replay sample bounds mismatch")
        result[start:end] = waveform[chunk["audio_start_frame"]:chunk["audio_end_frame"]]
        previous_end = end
    return result


def audio_exports(output_dir, name, waveform, sample_rate, engine):
    # Same resampler, headroom rule and G.711 implementation for both engines.
    outputs = probe.write_audio_outputs(output_dir, name, waveform, sample_rate)
    outputs["native"] = "MODEL_RETURN_SAVED_AS_FLOAT32_NO_GAIN_OR_TRIM"
    outputs["engine_watermark"] = "OFFICIAL_PERTH_RETAINED" if engine == "nano" else "NO_WATERMARK_CLAIM"
    return outputs


def setup_nano(args, report, torch):
    from chatterbox.tts_turbo import ChatterboxTurboTTS
    import torchaudio
    import transformers
    require(torch.__version__ == "2.7.1+cu118" and torchaudio.__version__ == "2.7.1+cu118", "Use verified isolated Nano CUDA runtime")
    require(transformers.__version__ == "5.2.0", "Expected verified Transformers 5.2.0")
    require(torch.cuda.is_available(), "CUDA unavailable; no silent fallback")
    torch.cuda.set_device(0)
    require(torch.cuda.get_device_capability(0) == (5, 2), "This Nano experiment targets GTX 980")
    require("sm_50" in torch.cuda.get_arch_list() or "sm_52" in torch.cuda.get_arch_list(), "No compatible Maxwell kernels")
    free, total = torch.cuda.mem_get_info(0)
    require(free >= 1500 * 1024**2, "Less than 1500 MiB CUDA free; preserve other applications")
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    report["gpu"] = {"name": torch.cuda.get_device_name(0), "free_before_bytes": free, "total_bytes": total}
    stage(args, report, "load_nano_cpu")
    began = time.perf_counter()
    model = ChatterboxTurboTTS.from_local(args.model_dir, device="cpu", nano=True)
    report["model_load_seconds"] = time.perf_counter() - began
    require(model.model_label == "Nano" and model.t3.hp.llama_config_name == "GPT2_small", "Wrong Nano architecture")
    require(type(model.watermarker).__name__ == "PerthImplicitWatermarker", "Official watermark required")
    model.conds = None
    stage(args, report, "prepare_reference_cpu_once")
    began = time.perf_counter()
    model.prepare_conditionals(str(args.reference), exaggeration=0.0, norm_loudness=True)
    report["conditioning_seconds"] = time.perf_counter() - began
    report["conditioning"] = {"mode": "PUBLIC_FIXED_VOICE_WAV_CONDITIONING", "prepared_once": True,
                              "reference_wav_used_for_conditioning": True, "reference_device": "CPU",
                              "norm_loudness": True, "exaggeration": 0.0,
                              "comparison_boundary": "Nano WAV conditioning differs from Pocket public preset state"}
    for name in ACTIVE_T3:
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

    model.t3.inference_turbo = hybrid_t3
    model.s3gen.flow.to(device="cuda:0", dtype=torch.float32)
    model.s3gen.mel2wav.to(device="cuda:0", dtype=torch.float32)
    original_flow = model.s3gen.flow.inference

    @functools.wraps(original_flow)
    def hybrid_flow(*call_args, **call_kwargs):
        return tensors_to(original_flow(*tensors_to(call_args, "cuda:0"), **tensors_to(call_kwargs, "cuda:0")), "cpu")

    def hybrid_hift(speech_feat, cache_source=None):
        speech_feat = speech_feat.to(device="cuda:0")
        cache_source = speech_feat.new_zeros(1, 1, 0) if cache_source is None else cache_source.to(device="cuda:0")
        return tensors_to(model.s3gen.mel2wav.inference(speech_feat=speech_feat, cache_source=cache_source), "cpu")

    model.s3gen.flow.inference = hybrid_flow
    model.s3gen.hift_inference = hybrid_hift
    torch.cuda.synchronize(0)
    for component in [getattr(model.t3, name) for name in ACTIVE_T3] + [model.s3gen.flow, model.s3gen.mel2wav]:
        require(all(p.device.type == "cuda" and (not p.is_floating_point() or p.dtype == torch.float32)
                    for p in component.parameters()), "Active synthesis must be CUDA FP32")
    for component in (model.ve, model.s3gen.tokenizer, model.s3gen.speaker_encoder):
        require(all(p.device.type == "cpu" for p in component.parameters()), "Reference encoders must stay CPU")
    require(model.s3gen.trim_fade.device.type == "cpu", "Trim/fade must stay CPU")
    report["component_placement"] = {"active_t3": "CUDA_FP32", "flow": "CUDA_FP32", "hift": "CUDA_FP32",
                                     "reference_encoders": "CPU", "watermark": "OFFICIAL_CPU"}
    report["generation_parameters"] = {"temperature": .75, "norm_loudness_reference": True, "exaggeration": 0.0}

    def generate(text, entry):
        original = probe.instrument_t3(model, entry, lambda: None)
        try:
            with torch.inference_mode():
                output = model.generate(text, temperature=.75)
            torch.cuda.synchronize(0)
            require(all(not call["near_or_at_generation_limit"] for call in entry["t3_calls"]),
                    "Near Nano token limit: possible truncation; stop benchmark")
            yield output
        finally:
            model.t3.inference_turbo = original

    return int(model.sr), generate


def setup_pocket(args, report, torch):
    from pocket_tts import TTSModel
    # Pocket imports can set Torch threads; reapply explicit benchmark settings.
    torch.set_num_threads(args.threads)
    stage(args, report, "load_pocket_cpu")
    began = time.perf_counter()
    model = TTSModel.load_model(config=str(args.pocket_config))
    report["model_load_seconds"] = time.perf_counter() - began
    require(model.device.type == "cpu", "Pocket CPU control changed device")
    require(all(p.device.type == "cpu" and (not p.is_floating_point() or p.dtype == torch.float32)
                for p in model.parameters()), "Pocket control requires CPU FP32")
    stage(args, report, "prepare_reference_cpu_once")
    began = time.perf_counter()
    voice_state = model.get_state_for_audio_prompt(args.voice_state)
    report["conditioning_seconds"] = time.perf_counter() - began
    report["conditioning"] = {"mode": "PUBLIC_PRESET_WITHOUT_VOICE_CLONING",
                              "voice_state": file_record(args.voice_state), "prepared_once": True,
                              "reference_wav_used_for_conditioning": False,
                              "comparison_boundary": "Same named public voice; preset state and Nano WAV conditioning are different processing paths"}
    report["runtime"]["pocket_tts"] = importlib.metadata.version("pocket-tts")
    report["implementation"] = {"tts_model": file_record(Path(inspect.getfile(TTSModel)))}
    signature = inspect.signature(model.generate_audio_stream)
    report["generation_parameters"] = {name: str(parameter.default) for name, parameter in signature.parameters.items()
                                       if parameter.default is not inspect.Parameter.empty}
    report["generation_parameters"].update({"temp": model.temp, "copy_state": True})
    report["component_placement"] = {"model": "CPU_FP32", "reference_encoders": "CPU"}

    def generate(text, entry):
        # This is the native incremental generator, never generate_audio + slicing.
        yield from model.generate_audio_stream(voice_state, text, copy_state=True)

    return int(model.sample_rate), generate


def run_passage(args, report, passage, repeat, sample_rate, generate, torch, warmup=False):
    import numpy as np
    key = ("warmup" if warmup else f"repeat-{repeat:02d}") + "-" + passage["id"]
    entry = {"id": key, "passage_id": passage["id"], "repeat": repeat, "warmup_excluded": warmup,
             "status": "running", "sentences": [], "chunks": [], "speech_completeness": "PENDING_HUMAN_LISTENING"}
    report["runs"].append(entry)
    stage(args, report, "generate_" + key)
    arrays = []
    start = time.perf_counter()
    for index, text in enumerate(passage["sentences"]):
        seed = args.seed + (0 if passage["source_language"] == "en" else 100) + index
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        if args.engine == "nano":
            torch.cuda.manual_seed_all(seed)
            torch.cuda.synchronize(0)
        sentence = {"index": index, "text": text, "seed": seed, "chunks": []}
        entry["sentences"].append(sentence)
        sentence_start = time.perf_counter()
        sentence["started_at_seconds"] = sentence_start - start
        for output in generate(text, sentence):
            require(output.ndim in (1, 2) and (output.ndim == 1 or output.shape[0] == 1), "Unexpected mono output shape")
            waveform = output.detach().cpu().numpy().reshape(-1).astype(np.float32, copy=True)
            available = time.perf_counter() - start
            require(waveform.size > 0 and np.isfinite(waveform).all(), "Invalid generated chunk")
            chunk = {"index": len(entry["chunks"]), "sentence_index": index,
                     "sentence_chunk_index": len(sentence["chunks"]), "available_at_seconds": available,
                     "available_since_sentence_start_seconds": available - sentence["started_at_seconds"],
                     "frames": int(waveform.size),
                     "float32_le_sha256": hashlib.sha256(waveform.astype("<f4", copy=False).tobytes()).hexdigest()}
            entry["chunks"].append(chunk)
            sentence["chunks"].append(chunk["index"])
            arrays.append(waveform)
        sentence["generation_seconds"] = time.perf_counter() - sentence_start
        require(bool(sentence["chunks"]), "Sentence returned no audio")
        print(json.dumps({"stage": "sentence_complete", "run": key, "sentence": index + 1,
                          "chunks": len(sentence["chunks"]), "seconds": sentence["generation_seconds"]}), flush=True)
    entry["passage_elapsed_seconds"] = time.perf_counter() - start
    entry["sum_sentence_generation_seconds"] = sum(s["generation_seconds"] for s in entry["sentences"])
    joined = np.concatenate(arrays)
    entry["metrics"] = probe.audio_metrics(joined, sample_rate)
    require(entry["metrics"]["rms"] > 1e-7, "Effectively silent passage")
    entry["timeline"] = analyze_timeline(entry["chunks"], joined, sample_rate)
    for sentence in entry["sentences"]:
        chunks = [dict(entry["chunks"][i]) for i in sentence["chunks"]]
        begin, end = chunks[0]["audio_start_frame"], chunks[-1]["audio_end_frame"]
        for chunk in chunks:
            chunk["available_at_seconds"] -= sentence["started_at_seconds"]
        sentence["timeline"] = analyze_timeline(chunks, joined[begin:end], sample_rate)
    entry["generation_rtf"] = entry["sum_sentence_generation_seconds"] / entry["metrics"]["duration_seconds"]
    entry["elapsed_rtf"] = entry["passage_elapsed_seconds"] / entry["metrics"]["duration_seconds"]
    entry["outputs"] = audio_exports(args.output_dir, key, joined, sample_rate, args.engine)
    entry["ideal_fifo_replay_outputs"] = audio_exports(args.output_dir, key + "-ideal-fifo-replay",
                                                       render_fifo(entry["chunks"], joined, sample_rate), sample_rate, args.engine)
    entry["status"] = "generated_for_listening"
    save_report(args.output_dir, report)


def run(args, report):
    fixtures = read_fixtures(args.fixtures)
    report["fixtures"] = fixtures
    report["fixtures_sha256"] = probe.sha256(args.fixtures)
    stage(args, report, "verify_local_inputs")
    if args.engine == "nano":
        report["upstream"] = upstream_record(args.upstream_dir, probe.UPSTREAM_COMMIT)
        report["model_files"] = {}
        for filename, expected in probe.MODEL_HASHES.items():
            record = file_record(args.model_dir / filename)
            require(record["sha256"] == expected, "Nano checksum mismatch: " + filename)
            report["model_files"][filename] = record
        if (args.model_dir / "conds.pt").exists():
            require(probe.sha256(args.model_dir / "conds.pt") == probe.BUILTIN_CONDITIONAL_HASH, "Unexpected built-in conditionals")
        sys.path.insert(0, str(args.upstream_dir / "src"))
    else:
        report["model_files"] = verify_pocket_config(args.pocket_config)
        if args.upstream_dir:
            report["upstream"] = upstream_record(args.upstream_dir)
            sys.path.insert(0, str(args.upstream_dir))
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      DO_NOT_TRACK="1", WANDB_DISABLED="true", TOKENIZERS_PARALLELISM="false",
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads),
                      POCKET_TTS_SAVE_WEIGHTS="0")
    probe.prohibit_python_network(report)
    stage(args, report, "import_runtime_offline")
    import soundfile as sf
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    report["runtime"] = {"python": sys.version, "torch": str(torch.__version__), "threads": args.threads,
                         "interop_threads": 1, "dtype": "float32", "autocast": False, "compile": False}
    reference, rate = sf.read(args.reference, dtype="float32", always_2d=True)
    require(reference.shape[1] == 1 and 5 < len(reference) / rate <= 60, "Reference must be mono and 5-60 seconds")
    report["reference"] = {**file_record(args.reference), **probe.audio_metrics(reference[:, 0], rate),
                           "scope": "NANO_WAV_CONDITIONING" if args.engine == "nano" else "PUBLIC_PRESET_WAV_PROVENANCE_ONLY",
                           "uploaded": False}
    require(report["reference"]["rms"] > 1e-5, "Reference effectively silent")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    sample_rate, generate = (setup_nano if args.engine == "nano" else setup_pocket)(args, report, torch)
    report["sample_rate"] = sample_rate
    first = dict(fixtures["passages"][0])
    first["sentences"] = first["sentences"][:1]
    run_passage(args, report, first, 0, sample_rate, generate, torch, warmup=True)
    for repeat in range(1, args.repeats + 1):
        for passage in fixtures["passages"]:
            run_passage(args, report, passage, repeat, sample_rate, generate, torch)
    require(report["network"]["blocked_attempts"] == 0, "Dependency attempted network access; inspect report")


def main(argv=None):
    args = arguments(argv)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report = {"schema": "fixed-voice-long-form-benchmark/1", "status": "running", "engine": args.engine,
              "created_at_utc": datetime.now(timezone.utc).isoformat(), "script_sha256": probe.sha256(Path(__file__)),
              "scope": "OFFLINE_TEXT_READY_SYNTHESIS_AVAILABILITY_NOT_TRANSLATION_OR_PHONE_LATENCY",
              "generation_api": "SENTENCE_PIPELINE_WHOLE_FILE_NOT_NATIVE_STREAMING" if args.engine == "nano"
                                else "NATIVE_GENERATE_AUDIO_STREAM_WITH_EXPLICIT_SENTENCE_BOUNDARIES",
              "timing_scope": "Resident model; one excluded warmup; reference prepared once. Serial sentence calls. "
                              "Availability after CPU copy. Elapsed includes RNG/loop/hash/stdout overhead; generation excludes JSON/file export. "
                              "FIFO replay assumes instant enqueue, no device/network cost and zero startup buffer.",
              "energy_detector": {"rms_threshold": .01, "frame_ms": 10, "consecutive_frames": 2,
                                  "scope": "ENERGY_PROXY_NOT_LINGUISTIC_VAD_OR_PROOF_OF_CONTENT"},
              "export_treatment": "Gapless canonical concatenation preserves every returned sample; "
                                  "separate FIFO replay inserts initial wait and measured starvation silence. "
                                  "Both engines use identical native FLOAT and scipy resampling/G711 conversion.",
              "acceptance": {"speech_completeness": "PENDING_HUMAN_LISTENING", "voice_quality": "PENDING_HUMAN_LISTENING",
                             "live_phone": "NOT_TESTED", "translation": "AUTHORED_FIXTURE_ONLY_NO_API"},
              "network": {"downloads": False, "uploads": False, "blocked_attempts": 0,
                          "blocked_local_capability_probes": 0, "python_socket_guard_active": False,
                          "boundary": "Python audit socket guard and offline environment; not OS firewall"}, "runs": []}
    began = time.perf_counter()
    code = 0
    try:
        run(args, report)
        report["status"] = "completed_for_listening"
        report["stage"] = "complete"
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)}
        if report["runs"] and report["runs"][-1]["status"] == "running":
            report["runs"][-1]["status"] = "failed"
        print(json.dumps({"status": "failed", "error": report["error"]}), file=sys.stderr, flush=True)
        code = 1
    finally:
        report["total_wall_seconds"] = time.perf_counter() - began
        save_report(args.output_dir, report)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
