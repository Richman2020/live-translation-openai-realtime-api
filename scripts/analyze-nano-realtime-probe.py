"""Analyze private whole-file Nano measurements and a separate ideal FIFO model.

Input: nano-realtime-probe/1, status=completed, samples with phase warmup or
warm_repeat; each sample has id, fixture_id, text, seed, generation_parameters,
generate_wall_seconds, native WAV metadata, t3_calls and status=completed.
replay_mode must be SIMULATED_FIFO_FROM_MEASURED_WHOLE_FILE_RUNS. replay entries
contain sample_id, scenario and synthetic text_ready_at_seconds in FIFO order
within each independent scenario. Sample group must match the replay scenario.

No model, sound device, telephone, network, or audio transformation is invoked.
Whole-file return time is not streaming first audio or measured phone latency.
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics
import struct
import sys


REPO = Path(__file__).resolve().parent.parent
VALIDATOR_PATH = REPO / "scripts/build-nano-voice-review.py"
spec = importlib.util.spec_from_file_location("nano_measurement_wav_validator", VALIDATOR_PATH)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
require = validator.require
REPLAY_MODE = "SIMULATED_FIFO_FROM_MEASURED_WHOLE_FILE_RUNS"
PARAMETER_KEYS = {
    "repetition_penalty", "min_p", "top_p", "audio_prompt_path", "exaggeration",
    "cfg_weight", "temperature", "top_k", "norm_loudness",
}


def number(value, label, positive=False):
    require(validator.finite_number(value) and (value > 0 if positive else value >= 0),
            "Invalid " + label)
    return float(value)


def identifier(value, label):
    require(isinstance(value, str) and 0 < len(value) <= 160
            and all(char.isalnum() or char in "_-" for char in value), "Invalid " + label)
    return value


def percentile(values, fraction):
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def summarize(values):
    require(bool(values) and all(math.isfinite(value) for value in values), "Invalid summary inputs")
    return {"count": len(values), "min": min(values), "median": statistics.median(values),
            "mean": statistics.mean(values), "p95": percentile(values, .95), "max": max(values)}


def waveform_data_sha256(asset):
    """Hash only validated sample bytes, excluding RIFF/PEAK timestamp metadata."""
    raw = asset["raw"]
    offset, data = 12, None
    while offset + 8 <= len(raw):
        kind, size = struct.unpack_from("<4sI", raw, offset)
        start = offset + 8
        end = start + size
        require(end <= len(raw), "Truncated WAV chunk while extracting waveform identity")
        if kind == b"data":
            require(data is None, "Duplicate WAV data while extracting waveform identity")
            data = raw[start:end]
        offset = end + (size % 2)
    require(offset == len(raw) and data is not None and len(data) > 0,
            "Missing WAV data while extracting waveform identity")
    # asset() already verified the entire container, frames, rate and sample values.
    # Keep format separately and require it to match before comparing data hashes.
    return hashlib.sha256(data).hexdigest()


def validate_sample(sample, directory):
    require(isinstance(sample, dict) and sample.get("status") == "completed", "Failed or incomplete sample")
    sample_id = identifier(sample.get("id"), "sample id")
    fixture_id = identifier(sample.get("fixture_id"), "fixture id")
    group = identifier(sample.get("group"), "sample group")
    phase = sample.get("phase")
    require(phase in ("warmup", "warm_repeat"), "Unknown sample phase")
    repeat = sample.get("repeat")
    require(type(repeat) is int and (repeat == 0 if phase == "warmup" else repeat > 0),
            "Invalid sample repeat index")
    text = sample.get("text")
    require(isinstance(text, str) and 0 < len(text.strip()) <= 10000, "Missing fixed sample text")
    seed = sample.get("seed")
    require(type(seed) is int and 0 <= seed <= 2**32 - 1, "Invalid sample seed")
    parameters = sample.get("generation_parameters")
    require(isinstance(parameters, dict) and set(parameters) == PARAMETER_KEYS,
            "Missing complete explicit generation parameters")
    for key in PARAMETER_KEYS - {"audio_prompt_path", "norm_loudness", "top_k"}:
        number(parameters[key], "generation parameter " + key)
    require(parameters["audio_prompt_path"] is None and type(parameters["norm_loudness"]) is bool
            and type(parameters["top_k"]) is int and parameters["top_k"] >= 0,
            "Invalid explicit generation configuration")
    elapsed = number(sample.get("generate_wall_seconds"), "whole-file generation duration", positive=True)
    traces = sample.get("t3_calls")
    require(isinstance(traces, list) and len(traces) == 1, "Expected exactly one recorded T3 invocation")
    trace = traces[0]
    require(isinstance(trace, dict), "Invalid T3 trace")
    limit, count = trace.get("configured_generation_loop_limit"), trace.get("returned_token_count")
    require(type(limit) is int and limit > 0 and type(count) is int and 0 < count < limit,
            "Missing token count or possible generation-limit truncation")
    require(trace.get("near_or_at_generation_limit") is False
            and trace.get("definite_limit_without_terminal_eos") is False,
            "Generation-limit or truncation flags prevent throughput acceptance")
    require(trace.get("returned_shape") == [1, count]
            and type(trace.get("returned_tokens_below_6561")) is int
            and 0 < trace["returned_tokens_below_6561"] <= count, "Invalid returned speech-token shape")
    t3_seconds = number(trace.get("wall_seconds"), "T3 wall time", positive=True)
    require(t3_seconds <= elapsed + .001, "T3 duration exceeds whole-file measurement")
    warnings = sample.get("warnings", [])
    require(isinstance(warnings, list) and all(isinstance(item, str) for item in warnings), "Invalid sample warnings")
    require(not any("TRUNCAT" in item.upper() or "TOKEN_LIMIT" in item.upper() for item in warnings),
            "Sample reports possible truncation")
    native = sample.get("native")
    require(isinstance(native, dict), "Missing native audio artifact")
    asset = validator.asset(directory, native.get("filename"), native, sample_id + ".wav")
    require(asset["subtype"] == "FLOAT", "Expected original FLOAT32 Nano output")
    require(asset["rms"] >= 1e-7, "Native audio is effectively silent")
    require(asset["peak"] < 1, "Native audio reaches full scale; inspect it before accepting speed samples")
    duration = asset["duration_seconds"]
    return {"sample_id": sample_id, "phase": phase, "fixture_id": fixture_id, "group": group,
            "repeat": repeat, "text": text,
            "seed": seed, "generation_parameters": parameters,
            "measured_whole_file_return_seconds": elapsed, "audio_duration_seconds": duration,
            "measured_whole_file_rtf": elapsed / duration,
            "native_filename": native["filename"], "native_sha256": asset["sha256"],
            "native_pcm_data_sha256": waveform_data_sha256(asset),
            "native_frames": asset["frames"], "native_sample_rate": asset["sample_rate"],
            "native_channels": asset["channels"], "native_subtype": asset["subtype"],
            "returned_speech_tokens": count, "semantic_completeness": "UNVERIFIED_BY_TIMING_OR_TOKEN_COUNT"}


def simulate_fifo(replay, samples):
    """Single generator + separate serial playback; all times here are modeled."""
    require(isinstance(replay, list) and 2 <= len(replay) <= 2000, "Expected 2..2000 synthetic FIFO arrivals")
    previous_arrival = generator_end = playback_end = zero_compute_end = 0.0
    rows = []
    usage = Counter()
    for index, arrival in enumerate(replay):
        require(isinstance(arrival, dict), "Invalid replay entry")
        sample_id = arrival.get("sample_id")
        require(sample_id in samples and samples[sample_id]["phase"] == "warm_repeat",
                "Replay must reference measured warm-repeat samples, not warmup or missing output")
        sample = samples[sample_id]
        ready = number(arrival.get("text_ready_at_seconds"), "synthetic text-ready timestamp")
        require(ready >= previous_arrival, "Synthetic arrivals must be in declared FIFO order")
        generate_start = max(ready, generator_end)
        generated = generate_start + sample["measured_whole_file_return_seconds"]
        start = max(generated, playback_end)
        end = start + sample["audio_duration_seconds"]
        zero_start = max(ready, zero_compute_end)
        zero_end = zero_start + sample["audio_duration_seconds"]
        row = {"index": index, "sample_id": sample_id, "synthetic_text_ready_at_seconds": ready,
               "simulated_generation_start_at_seconds": generate_start,
               "simulated_whole_file_audio_available_at_seconds": generated,
               "simulated_generator_queue_wait_seconds": generate_start - ready,
               "simulated_text_ready_to_whole_file_available_seconds": generated - ready,
               "ideal_playback_start_at_seconds": start, "ideal_playback_end_at_seconds": end,
               "ideal_playback_queue_wait_seconds": start - generated,
               "ideal_text_ready_to_playback_start_seconds": start - ready,
               "ideal_text_ready_to_playback_end_seconds": end - ready,
               "ideal_queued_audio_seconds_at_generation_return": end - generated,
               "zero_compute_reference_playback_end_at_seconds": zero_end,
               "ideal_extra_tail_vs_zero_compute_seconds": end - zero_end}
        require(all(math.isfinite(value) for value in row.values() if type(value) in (int, float)),
                "FIFO simulation overflowed")
        rows.append(row)
        usage[sample_id] += 1
        previous_arrival, generator_end, playback_end, zero_compute_end = ready, generated, end, zero_end
    return {"kind": REPLAY_MODE, "actual_paced_replay": False,
            "assumptions": [
                "Synthetic times mean text is already ready; no ASR, translation, or clause-finalization delay is included.",
                "One FIFO generator reuses measured whole-file times; repeated references are not new runtime trials.",
                "Playback can overlap the next generation and consumes each saved WAV at its native duration.",
                "The entire WAV must return before it is available; no streaming first audio is inferred.",
                "No transport, codec/file encoding overhead, playback device, jitter, cancellation, or queue capacity is modeled.",
                "The zero-compute reference uses identical arrivals and WAV durations with instantaneous synthesis.",
            ], "arrival_count": len(rows), "unique_measured_samples_used": len(usage),
            "sample_reuse_counts": dict(usage), "rows": rows,
            "simulated_first_whole_file_audio_available_at_seconds": rows[0]["simulated_whole_file_audio_available_at_seconds"],
            "simulated_generator_queue_wait_seconds": summarize([r["simulated_generator_queue_wait_seconds"] for r in rows]),
            "ideal_playback_queue_wait_seconds": summarize([r["ideal_playback_queue_wait_seconds"] for r in rows]),
            "ideal_text_ready_to_playback_start_seconds": summarize([r["ideal_text_ready_to_playback_start_seconds"] for r in rows]),
            "ideal_max_queued_audio_seconds_at_generation_return": max(r["ideal_queued_audio_seconds_at_generation_return"] for r in rows),
            "ideal_final_tail_after_last_text_ready_seconds": playback_end - previous_arrival,
            "ideal_final_extra_tail_vs_zero_compute_seconds": playback_end - zero_compute_end,
            "ideal_extra_tail_definition": "Final audio end minus zero-compute FIFO audio end, preserving the same output durations; not mouth-to-ear latency."}


def analyze(report_path):
    loaded = validator.load_report(report_path)
    report, directory = loaded["report"], loaded["path"].parent
    require(report.get("schema") == "nano-realtime-probe/1" and report.get("status") == "completed",
            "Only completed nano-realtime-probe/1 measurements can be analyzed")
    require(report.get("replay_mode") == REPLAY_MODE, "Only explicitly simulated FIFO replay is supported")
    require(report.get("resident_model") is True
            and report.get("generation_api") == "OFFICIAL_WHOLE_FILE_GENERATE_NOT_STREAMING",
            "Missing resident whole-file generation evidence")
    network = report.get("network", {})
    require(network.get("blocked_attempts") == 0 and network.get("downloads") is False
            and network.get("uploads") is False and network.get("python_socket_guard_active") is True,
            "Missing successful offline guard evidence")
    raw_samples = report.get("samples")
    require(isinstance(raw_samples, list) and 3 <= len(raw_samples) <= 500, "Missing or oversized sample list")
    samples = [validate_sample(sample, directory) for sample in raw_samples]
    by_id = {sample["sample_id"]: sample for sample in samples}
    require(len(by_id) == len(samples), "Duplicate measured sample IDs")
    warmups = [sample for sample in samples if sample["phase"] == "warmup"]
    measured = [sample for sample in samples if sample["phase"] == "warm_repeat"]
    require(bool(warmups), "A successful recorded warmup is required before steady-state interpretation")
    require(raw_samples[0].get("phase") == "warmup", "Warmup must precede formal measurements")
    require(all(sample["phase"] == "warm_repeat" for sample in samples[len(warmups):]),
            "Warmup cannot be interleaved with steady-state measurements")
    groups = defaultdict(list)
    for sample in measured:
        groups[sample["fixture_id"]].append(sample)
    require(bool(groups), "No formal warm-repeat measurements")
    summaries = []
    for fixture_id, repeats in groups.items():
        require(len(repeats) >= 2, "Each measured fixture requires at least two warm repeats")
        require(len({sample["repeat"] for sample in repeats}) == len(repeats), "Duplicate fixture repeat index")
        first = repeats[0]
        for sample in repeats[1:]:
            require(all(sample[key] == first[key] for key in ("text", "seed", "generation_parameters", "group")),
                    "Warm repeats must retain identical text, seed and explicit parameters")
            require(all(sample[key] == first[key] for key in
                        ("native_sample_rate", "native_channels", "native_subtype")),
                    "Warm repeats must retain identical WAV sampling format for waveform comparison")
        elapsed = sum(sample["measured_whole_file_return_seconds"] for sample in repeats)
        duration = sum(sample["audio_duration_seconds"] for sample in repeats)
        summaries.append({"fixture_id": fixture_id, "group": first["group"], "text": first["text"], "seed": first["seed"],
                          "generation_parameters": first["generation_parameters"], "repeat_count": len(repeats),
                          "measured_whole_file_return_seconds": summarize([s["measured_whole_file_return_seconds"] for s in repeats]),
                          "measured_whole_file_rtf": summarize([s["measured_whole_file_rtf"] for s in repeats]),
                          "weighted_compute_rtf": elapsed / duration,
                          "output_audio_duration_seconds": summarize([s["audio_duration_seconds"] for s in repeats]),
                          "unique_file_hashes": len({s["native_sha256"] for s in repeats}),
                          "unique_waveform_hashes": len({s["native_pcm_data_sha256"] for s in repeats})})
    total_compute = sum(sample["measured_whole_file_return_seconds"] for sample in measured)
    total_audio = sum(sample["audio_duration_seconds"] for sample in measured)
    replay = report.get("replay")
    require(isinstance(replay, list) and 2 <= len(replay) <= 2000, "Missing or oversized replay plan")
    scenarios = defaultdict(list)
    for job in replay:
        require(isinstance(job, dict), "Invalid replay entry")
        scenario = identifier(job.get("scenario"), "replay scenario")
        sample = by_id.get(job.get("sample_id"))
        require(sample is not None and sample["group"] == scenario,
                "Replay scenario does not match the measured sample group")
        scenarios[scenario].append(job)
    require(set(scenarios) == {sample["group"] for sample in measured},
            "Every measured group must have its own explicit replay scenario")
    simulations = [{"scenario": scenario, **simulate_fifo(jobs, by_id)} for scenario, jobs in scenarios.items()]
    return {"schema": "nano-realtime-analysis/1", "status": "analyzed_not_phone_accepted",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "source_report": {"filename": loaded["path"].name, "sha256": loaded["sha256"]},
            "measurement_context": {key: report.get(key) for key in
                                    ("mode", "runtime", "upstream", "reference_sha256", "accepted_report_sha256",
                                     "component_placement", "resident_model", "generation_api")},
            "analysis_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "validator_sha256": hashlib.sha256(VALIDATOR_PATH.read_bytes()).hexdigest(),
            "measured_whole_file_runs": {
                "scope": "Measured generate() call duration and independently verified WAV duration; not streaming first audio.",
                "warmup_count_excluded": len(warmups), "formal_sample_count": len(measured),
                "total_compute_seconds": total_compute, "total_output_audio_seconds": total_audio,
                "weighted_compute_rtf": total_compute / total_audio,
                "whole_file_return_seconds": summarize([s["measured_whole_file_return_seconds"] for s in measured]),
                "rtf_per_sample": summarize([s["measured_whole_file_rtf"] for s in measured]),
                "percentile_boundary": "Descriptive percentiles of these runs only; no population confidence or real-time guarantee.",
                "waveform_identity_scope": "native_pcm_data_sha256 hashes only WAV data sample bytes, with sample rate/channels/subtype checked equal within each fixture. RIFF metadata including PEAK timestamps is excluded; native_sha256 and unique_file_hashes refer to the complete WAV container.",
                "fixtures": summaries, "samples": measured,
            }, "ideal_queue_simulations": simulations,
            "scenario_boundary": "Each synthetic scenario has an independent clock, generator and playback queue; clocks are never concatenated.",
            "acceptance": {"streaming_first_audio_seconds": None, "measured_phone_latency_seconds": None,
                           "actual_paced_replay": "NOT_RUN", "live_phone": "NOT_TESTED",
                           "speech_completeness": "NOT_PROVEN_BY_TOKEN_COUNTS_OR_TIMING",
                           "voice_quality": "NOT_ASSESSED", "realtime_ready": "NOT_ESTABLISHED"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New private JSON; never overwrites")
    args = parser.parse_args()
    try:
        output = validator.private_path(args.output, exists=False)
        require(output.suffix.lower() == ".json" and not output.exists(), "Output must be a new private JSON")
        result = analyze(args.report)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as destination:
            json.dump(result, destination, indent=2, ensure_ascii=False, allow_nan=False)
            destination.write("\n")
        print(json.dumps({"status": result["status"], "output": str(output),
                          "weighted_compute_rtf": result["measured_whole_file_runs"]["weighted_compute_rtf"],
                          "replay": "IDEAL_SIMULATION_ONLY"}, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print("Nano analysis rejected: " + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
