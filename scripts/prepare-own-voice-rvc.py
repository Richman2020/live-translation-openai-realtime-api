"""Local-only, source-preserving preparation of own-voice WAVs for a bounded RVC pilot.

Uses the pinned upstream silence slicer and filter/normalization conventions.
Numeric integrity and signal statistics do not constitute audible quality acceptance.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys

import librosa
import numpy as np
from scipy import signal
from scipy.io import wavfile


UPSTREAM_COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"
RATE = 32000
MAX_FRAMES = 118400  # 3.7 seconds; bounded by the actual FP32 hardware probe.
OVERLAP = 9600
MIN_FRAMES = 16000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def split_ranges(length):
    """Balanced bounded chunks with a 0.3s overlap, including every slice tail."""
    require(type(length) is int and length > 0, "invalid slice length")
    count = max(1, math.ceil((length - OVERLAP) / (MAX_FRAMES - OVERLAP)))
    chunk = math.ceil((length + OVERLAP * (count - 1)) / count)
    return [(i * (chunk - OVERLAP), min(length, i * (chunk - OVERLAP) + chunk))
            for i in range(count)]


def normalized(samples):
    require(samples.ndim == 1 and samples.size > 0 and np.isfinite(samples).all(),
            "invalid or non-finite waveform")
    peak = float(np.abs(samples).max())
    require(0 < peak <= 2.5, "invalid or abnormal pre-normalization peak")
    # Exact scalar formula from pinned train/preprocess.py (max=.9, alpha=.75).
    result = (samples / peak * 0.675 + 0.25 * samples).astype(np.float32)
    require(np.isfinite(result).all() and np.abs(result).max() < 1,
            "normalization would produce non-finite or clipped waveform")
    return result


def float_stats(samples):
    values = samples.astype(np.float64)
    require(values.ndim == 1 and values.size and np.isfinite(values).all(),
            "invalid finite mono audio")
    return {"rms": float(np.sqrt(np.mean(values ** 2))),
            "peak": float(np.abs(values).max()), "dcOffset": float(values.mean()),
            "samplesAtOrAboveFullScale": int(np.count_nonzero(np.abs(values) >= 1))}


def write_wav_new(path, rate, samples):
    with path.open("xb") as handle:
        wavfile.write(handle, rate, samples.astype(np.float32))
    read_rate, reread = wavfile.read(path)
    require(read_rate == rate and reread.dtype == np.float32
            and np.array_equal(reread, samples), "WAV serialization mismatch")
    return sha256(path)


def checked_paths(source, output, runtime):
    source, output, runtime = source.resolve(strict=True), output.resolve(), runtime.resolve(strict=True)
    require(source.is_dir() and source.is_relative_to(runtime), "source must be a private runtime directory")
    require(output.is_relative_to(runtime) and output != runtime,
            "output must be a child of the private runtime directory")
    require(not output.exists(), "output already exists; refusing overwrite")
    require(not source.is_relative_to(output) and not output.is_relative_to(source),
            "output must not contain or be inside raw source")
    return source, output


def prepare(args):
    repo = Path(__file__).resolve().parent.parent
    source, output = checked_paths(args.source_dir, args.output_dir, repo / ".runtime")
    manifest_path = args.manifest.resolve(strict=True)
    require(manifest_path.parent == source, "manifest must be inside the raw source directory")
    upstream = args.upstream.resolve(strict=True)
    commit = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(upstream), "status", "--porcelain",
                                     "--untracked-files=no"], text=True).strip()
    require(commit == UPSTREAM_COMMIT and not dirty, "requires pinned, clean upstream tracked files")
    intake = load_module("own_voice_intake", repo / "scripts/check-own-voice-recordings.py")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    clips = sorted(intake.validate_manifest(manifest), key=lambda c: c["id"])
    require(len(clips) >= 3 and sum(c.get("trial") is True for c in clips) == 1,
            "requires exactly one trial plus at least two formal clips")
    require(all(type(c.get("trial")) is bool for c in clips), "missing trial marker")
    require(any(c["id"] == args.holdout_id and not c["trial"] for c in clips), "formal holdout id not found")
    sources = []
    for clip in clips:
        path = (source / clip["filename"]).resolve(strict=True)
        require(path.parent == source, "source WAV escaped raw directory")
        info = intake.inspect_clip(clip, path)
        require(info["validationPassed"], f"clip {clip['id']} failed intake checks")
        require(info["sampleRate"] == 48000, "pilot input must be the original 48 kHz capture")
        require(info["signal"]["railClipSampleCount"] == 0, "clipped input requires review")
        split = "heldout" if clip["trial"] or clip["id"] == args.holdout_id else "train"
        sources.append({"clipId": clip["id"], "filename": clip["filename"],
                        "sourcePath": str(path), "sha256": info["sha256"], "split": split,
                        "trial": clip["trial"], "frames48k": info["frames"],
                        "durationSeconds": info["durationSeconds"], "signal": info["signal"]})
    slicer_path = upstream / "train/dataset/slicer2.py"
    slicer_module = load_module("pinned_rvc_slicer", slicer_path)
    slicer = slicer_module.Slicer(sr=RATE, threshold=-42, min_length=1500,
                                  min_interval=400, hop_size=15, max_sil_kept=500)
    bh, ah = signal.butter(N=5, Wn=48, btype="high", fs=RATE)
    report = {"version": "own-voice-rvc-preprocess/1", "status": "incomplete",
              "createdAt": datetime.now(timezone.utc).isoformat(), "upstreamCommit": commit,
              "manifestSha256": sha256(manifest_path), "slicerSha256": sha256(slicer_path),
              "sourceDirectory": str(source), "outputDirectory": str(output),
              "sources": sources, "segments": [], "discarded": [],
              "parameters": {"sampleRate": RATE, "featureInputSampleRate": 16000,
                  "maxSegmentSeconds": 3.7, "minimumSegmentSeconds": 0.5, "overlapSeconds": 0.3,
                  "slicerThresholdDb": -42, "slicerMinimumLengthMs": 1500,
                  "slicerMinimumIntervalMs": 400, "slicerHopMs": 15, "slicerMaximumSilenceKeptMs": 500,
                  "highpassHz": 48, "highpassOrder": 5, "filter": "causal scipy.signal.lfilter",
                  "normalization": "x / peak * 0.675 + 0.25 * x", "resampler": "librosa soxr_hq"},
              "deviationsFromUpstream": [
                  "48k PCM read directly and resampled with librosa soxr_hq instead of FFmpeg.",
                  "Long silence-slicer outputs use balanced segments capped at 3.7s, not up-to-4.0s tails.",
                  "Every silence-slicer output tail is retained; no last-slice-only tail write.",
                  "Fragments below 0.5s or zero/near-zero energy are reported and excluded."],
              "qualityAcceptance": "NOT_ASSESSED", "limitations": [
                  "Silence slicing and signal energy are not speech VAD, SNR, audible quality or speaker verification.",
                  "No denoising, transcription, model extraction, training or network request performed.",
                  "Held-out source clips are never transformed into training segments."]}
    output.mkdir(parents=True, exist_ok=False)
    (output / "0_gt_wavs").mkdir()
    (output / "1_16k_wavs").mkdir()
    for item in sources:
        if item["split"] != "train":
            continue
        rate, pcm = wavfile.read(item["sourcePath"])
        require(rate == 48000 and pcm.dtype == np.int16 and pcm.ndim == 1, "raw format changed")
        audio = librosa.resample(pcm.astype(np.float32) / 32768, orig_sr=rate,
                                 target_sr=RATE, res_type="soxr_hq")
        audio = signal.lfilter(bh, ah, audio)
        require(np.isfinite(audio).all(), "filter/resample produced non-finite data")
        retained = 0
        for slice_index, part in enumerate(slicer.slice(audio)):
            require(np.shares_memory(part, audio), "upstream slice lost positional provenance")
            offset = (part.ctypes.data - audio.ctypes.data) // audio.itemsize
            retained += len(part)
            for piece_index, (begin, end) in enumerate(split_ranges(len(part))):
                piece = part[begin:end]
                stats = float_stats(piece)
                key = f"c{item['clipId']:02d}_s{slice_index:03d}_p{piece_index:03d}"
                if len(piece) < MIN_FRAMES or stats["rms"] < 1e-5:
                    report["discarded"].append({"key": key, "sourceClipId": item["clipId"],
                        "frames32k": len(piece), "reason": "below 0.5s or RMS below 1e-5"})
                    continue
                require(len(piece) <= MAX_FRAMES, "segment exceeded tested capacity")
                wave32 = normalized(piece)
                wave16 = librosa.resample(wave32, orig_sr=RATE, target_sr=16000,
                                          res_type="soxr_hq").astype(np.float32)
                stats32, stats16 = float_stats(wave32), float_stats(wave16)
                require(stats32["samplesAtOrAboveFullScale"] == 0
                        and stats16["samplesAtOrAboveFullScale"] == 0, "resampling introduced clipping")
                path32, path16 = output / "0_gt_wavs" / f"{key}.wav", output / "1_16k_wavs" / f"{key}.wav"
                hash32, hash16 = write_wav_new(path32, RATE, wave32), write_wav_new(path16, 16000, wave16)
                report["segments"].append({"key": key, "sourceClipId": item["clipId"],
                    "sourceSha256": item["sha256"], "sourceRange32k": [offset + begin, offset + end],
                    "wav32k": str(path32), "wav16k": str(path16), "sha256_32k": hash32,
                    "sha256_16k": hash16, "frames32k": len(wave32), "frames16k": len(wave16),
                    "durationSeconds": len(wave32) / RATE, "signal32k": stats32, "signal16k": stats16})
        item["resampledFrames32k"] = len(audio)
        item["slicerRetainedFrames32k"] = retained
        item["slicerRemovedSeconds"] = (len(audio) - retained) / RATE
        print(f"Prepared training clip {item['clipId']}", flush=True)
    require(report["segments"], "no usable segments produced")
    for item in sources:
        require(sha256(Path(item["sourcePath"])) == item["sha256"], "raw source hash changed during processing")
    require(sha256(manifest_path) == report["manifestSha256"], "source manifest changed during processing")
    report["summary"] = {"trainingSourceCount": sum(s["split"] == "train" for s in sources),
        "heldoutSourceCount": sum(s["split"] == "heldout" for s in sources),
        "trainingRawSeconds": sum(s["durationSeconds"] for s in sources if s["split"] == "train"),
        "heldoutRawSeconds": sum(s["durationSeconds"] for s in sources if s["split"] == "heldout"),
        "segmentCount": len(report["segments"]),
        "trainingSegmentSecondsIncludingOverlap": sum(s["durationSeconds"] for s in report["segments"]),
        "slicerRemovedSeconds": sum(s.get("slicerRemovedSeconds", 0) for s in sources),
        "discardedSegmentCount": len(report["discarded"]), "sourceHashesUnchanged": True}
    report["status"] = "complete"
    with (output / "preprocess-report.json").open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps(report["summary"], ensure_ascii=False))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--holdout-id", type=int, default=11)
    args = parser.parse_args()
    try:
        prepare(args)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Preparation stopped: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
