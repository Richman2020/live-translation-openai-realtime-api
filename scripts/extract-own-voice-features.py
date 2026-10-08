"""Extract real local RVC v2 HuBERT/RMVPE training features, without uploads.

Consumes the completed private preprocessing report. All outputs are new files;
no phone service, raw recording, upstream code, or provider settings are changed.
Feature validity is not voice quality, speaker identity, or clone acceptance.
"""

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"
MODELS = {
    "assets/hubert_base/pytorch_model.bin": "cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5",
    "assets/hubert_base/config.json": "0346950779dfb7f9316fa74ed846e2b8a22a08eedfdc5387b73f327cb1a4a7cf",
    "assets/hubert_base/preprocessor_config.json": "7c1976a680fb7acc757cd36fb08eef878fa36c70b4c9d2d595df9c608bbbbf0e",
    "assets/rmvpe/rmvpe.pt": "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193",
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def coarse_f0(f0, np):
    mel = 1127 * np.log(1 + f0 / 700)
    minimum, maximum = 1127 * math.log(1 + 50 / 700), 1127 * math.log(1 + 1100 / 700)
    mel[mel > 0] = (mel[mel > 0] - minimum) * 254 / (maximum - minimum) + 1
    return np.rint(np.clip(mel, 1, 255)).astype(np.int64)


def run(args, report):
    import numpy as np
    import soundfile as sf
    import torch
    import torch.nn.functional as F

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    source = args.prepared / "preprocess-report.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    require(data.get("version") == "own-voice-rvc-preprocess/1" and data.get("status") == "complete",
            "A completed real own-voice preprocessing report is required")
    segments = data.get("segments", [])
    require(bool(segments), "No prepared segments")
    report.update({"preprocessReportSha256": sha256(source), "expectedSegments": len(segments),
                   "upstreamCommit": COMMIT, "modelSha256": MODELS, "segments": [], "excluded": []})
    actual = subprocess.check_output(["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
    require(actual == COMMIT, "Unexpected upstream revision")
    require(not subprocess.check_output(["git", "-C", str(args.upstream), "status", "--porcelain", "--untracked-files=no"], text=True).strip(),
            "Upstream tracked files must be unchanged")
    for relative, expected in MODELS.items():
        require(sha256(args.upstream / relative) == expected, f"Model hash mismatch: {relative}")
    keys = set()
    for entry in segments:
        key = entry["key"]
        require(isinstance(key, str) and key and key not in keys and Path(key).name == key
                and not any(c in key for c in "|/\\\n\r:"), "Unsafe or duplicate segment key")
        keys.add(key)
        for field, subdir, hashfield in (("wav32k", "0_gt_wavs", "sha256_32k"), ("wav16k", "1_16k_wavs", "sha256_16k")):
            path = Path(entry[field]).resolve(strict=True)
            require(path.parent == args.prepared / subdir and path.stem == key, "Segment escaped prepared directory")
            require(sha256(path) == entry[hashfield], f"Changed prepared segment: {key}")
    require(torch.cuda.is_available(), "CUDA unavailable; no silent CPU fallback")
    device = torch.device("cuda:0")
    require(args.force_legacy_cuda, "Explicit --force-legacy-cuda required for this isolated FP32 run")
    report["device"] = {"name": torch.cuda.get_device_name(device), "capability": list(torch.cuda.get_device_capability(device)),
                        "torch": str(torch.__version__), "dtype": "float32", "processOnlyLegacyOverride": True}
    sys.path.insert(0, str(args.upstream))
    import configs.config as upstream_config
    original_selector = upstream_config.get_device_dtype_sm

    def legacy_selector(index):
        if index == 0:
            major, minor = torch.cuda.get_device_capability(0)
            memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
            return device, torch.float32, major + minor / 10, memory
        return original_selector(index)

    upstream_config.get_device_dtype_sm = legacy_selector
    from infer.rmvpe import RMVPE
    from infer.hubert import extract_hubert_features, hubert_audio_requires_normalization, load_hubert_model

    for dirname in ("2a_f0", "2b-f0nsf", "3_feature768"):
        (args.output / dirname).mkdir()
    torch.cuda.reset_peak_memory_stats(device)
    started = time.monotonic()

    def check_deadline():
        require(time.monotonic() - started <= args.max_seconds, "Feature extraction time budget exceeded")

    def read_audio(entry):
        audio, rate = sf.read(entry["wav16k"], dtype="float32")
        require(rate == 16000 and audio.ndim == 1 and 8000 <= len(audio) <= 59200,
                "Expected mono 16k segment between 0.5 and 3.7 seconds")
        require(np.isfinite(audio).all() and 0 < np.max(np.abs(audio)) <= 1, "Invalid segment samples")
        return audio

    pitch_started = time.monotonic()
    pitch_model = RMVPE(str(args.upstream / "assets/rmvpe/rmvpe.pt"), is_half=False, device=str(device))
    require(next(pitch_model.model.parameters()).device == device, "RMVPE device mismatch")
    voiced_values = []
    accepted = []
    for index, entry in enumerate(segments):
        check_deadline()
        audio = read_audio(entry)
        with torch.inference_mode():
            original = np.asarray(pitch_model.infer_from_audio(audio, thred=0.03), dtype=np.float32)
        require(original.ndim == 1 and np.isfinite(original).all() and (original >= 0).all(), "Invalid extracted F0")
        require(len(original) >= len(audio) // 160 and len(original) <= len(audio) // 160 + 2,
                "Unexpected RMVPE frame alignment")
        voiced = original > 0
        if not voiced.any():
            report["excluded"].append({"key": entry["key"], "reason": "NO_RMVPE_VOICED_FRAMES"})
            continue
        voiced_values.extend(original[voiced].tolist())
        f0 = original.copy()
        unvoiced = ~voiced
        # Match pinned official training extractor; do not claim this is voiced speech.
        f0[unvoiced] = np.interp(np.flatnonzero(unvoiced), np.flatnonzero(voiced), f0[voiced])
        coarse = coarse_f0(f0, np)
        key = entry["key"]
        coarse_path = args.output / "2a_f0" / f"{key}.wav.npy"
        f0_path = args.output / "2b-f0nsf" / f"{key}.wav.npy"
        for path, values in ((coarse_path, coarse), (f0_path, f0)):
            with path.open("xb") as stream:
                np.save(stream, values, allow_pickle=False)
        item = {"key": key, "wav32k": entry["wav32k"], "wav16k": entry["wav16k"],
                "sha256_32k": entry["sha256_32k"], "sha256_16k": entry["sha256_16k"],
                "pitch": str(coarse_path), "pitchf": str(f0_path), "f0Frames": len(f0),
                "rawVoicedFraction": float(voiced.mean()), "rawVoicedF0MedianHz": float(np.median(original[voiced])),
                "f0UnvoicedTrainingPolicy": "official interpolation, not evidence of voiced audio"}
        accepted.append((entry, item))
        if (index + 1) % 20 == 0:
            print(f"RMVPE {index + 1}/{len(segments)}", flush=True)
    del pitch_model
    gc.collect()
    torch.cuda.empty_cache()
    require(bool(accepted), "No voiced training segments survived extraction")
    report["rmvpeSeconds"] = time.monotonic() - pitch_started
    report["rawVoicedF0MedianHz"] = float(np.median(voiced_values))
    feature_started = time.monotonic()
    hubert = load_hubert_model(str(device), is_half=False)
    require(next(hubert.parameters()).device == device, "HuBERT device mismatch")
    normalize = hubert_audio_requires_normalization()
    report["hubertAudioNormalization"] = normalize
    rows = []
    for index, (entry, item) in enumerate(accepted):
        check_deadline()
        source_audio = torch.from_numpy(read_audio(entry)).to(device)
        with torch.inference_mode():
            if normalize:
                source_audio = F.layer_norm(source_audio, source_audio.shape)
            features = extract_hubert_features(hubert, source_audio.unsqueeze(0), "v2").squeeze(0).float().cpu().numpy()
        expected_frames = (len(source_audio) - 400) // 320 + 1
        require(features.shape == (expected_frames, 768) and np.isfinite(features).all(), "Invalid HuBERT features")
        require(features.shape[0] * 2 <= item["f0Frames"] and 40 <= features.shape[0] * 2 <= 370,
                "Features and pitch do not satisfy official loader/frame capacity")
        path = args.output / "3_feature768" / f"{entry['key']}.npy"
        with path.open("xb") as stream:
            np.save(stream, features, allow_pickle=False)
        item.update({"feature": str(path), "featureShape": list(features.shape), "alignedFrames": features.shape[0] * 2,
                     "sha256_feature": sha256(path), "sha256_pitch": sha256(Path(item["pitch"])),
                     "sha256_pitchf": sha256(Path(item["pitchf"]))})
        report["segments"].append(item)
        row = [entry["wav32k"], str(path), item["pitch"], item["pitchf"], "0"]
        require(not any(any(c in str(v) for c in "|\n\r") for v in row), "Unsafe filelist path")
        rows.append("|".join(row))
        if (index + 1) % 20 == 0:
            print(f"HuBERT {index + 1}/{len(accepted)}", flush=True)
    with (args.output / "train-filelist.txt").open("x", encoding="utf-8", newline="\n") as stream:
        stream.write("\n".join(rows) + "\n")
    torch.cuda.synchronize(device)
    report.update({"hubertSeconds": time.monotonic() - feature_started, "totalSeconds": time.monotonic() - started,
                   "completedSegments": len(rows), "filelistSha256": sha256(args.output / "train-filelist.txt"),
                   "peakAllocatedMiB": torch.cuda.max_memory_allocated(device) / 1048576,
                   "peakReservedMiB": torch.cuda.max_memory_reserved(device) / 1048576,
                   "status": "complete"})
    print(f"Complete: {len(rows)} real feature sets; {len(report['excluded'])} unvoiced segments excluded.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--prepared", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-seconds", type=float, default=900)
    parser.add_argument("--force-legacy-cuda", action="store_true")
    args = parser.parse_args()
    require(1 <= args.threads <= 16 and math.isfinite(args.max_seconds) and args.max_seconds > 0, "Invalid resource bounds")
    for field in ("upstream", "prepared", "output"):
        setattr(args, field, getattr(args, field).resolve())
    require(".runtime" in args.prepared.parts and ".runtime" in args.output.parts, "Use private .runtime input/output")
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "RVC_CUDA_GRAPH": "0",
                       "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1", "OMP_NUM_THREADS": str(args.threads)})
    report = {"version": "own-voice-rvc-features/1", "status": "failed", "qualityAcceptance": "NOT_ASSESSED"}
    try:
        run(args, report)
    except Exception as exc:
        report["error"] = str(exc)
        traceback.print_exc()
    finally:
        with (args.output / "feature-report.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
