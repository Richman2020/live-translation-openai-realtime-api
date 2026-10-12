"""Offline WAV intake checks. Signal statistics are not speech or quality acceptance."""

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import struct
import sys
import wave

import numpy as np


TOLERANCE = 2 / 32768  # Capture uses asymmetric PCM16 scaling and rounding.
FILENAME = re.compile(r"own-voice-[A-Za-z0-9][A-Za-z0-9._-]*\.wav", re.ASCII)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_manifest(manifest):
    require(isinstance(manifest, dict), "manifest must be an object")
    require(manifest.get("version") == "own-voice-recordings/1", "unsupported manifest version")
    clips = manifest.get("clips")
    require(isinstance(clips, list) and clips, "manifest clips must be a nonempty list")
    ids, names = set(), set()
    for clip in clips:
        require(isinstance(clip, dict), "clip must be an object")
        clip_id, filename = clip.get("id"), clip.get("filename")
        require(type(clip_id) is int and clip_id > 0 and clip_id not in ids, "invalid or duplicate clip id")
        require(isinstance(filename, str) and len(filename) <= 255 and FILENAME.fullmatch(filename)
                and ".." not in filename, f"clip {clip_id}: unsafe WAV filename")
        require(filename.casefold() not in names, f"clip {clip_id}: duplicate filename")
        ids.add(clip_id)
        names.add(filename.casefold())
    return clips


def signal_stats(samples, rate):
    values = samples.astype(np.float64) / 32768
    frame_size = max(1, round(rate * 0.02))
    starts = np.arange(0, len(values), frame_size)
    lengths = np.minimum(frame_size, len(values) - starts)
    frame_rms = np.sqrt(np.add.reduceat(values * values, starts) / lengths)
    p10, p50, p90 = np.percentile(frame_rms, [10, 50, 90])
    threshold = max(0.002, float(p90) * 0.08)
    active = frame_rms >= threshold
    indices = np.flatnonzero(active)
    leading = int(starts[indices[0]]) if len(indices) else len(values)
    trailing = len(values) - int(starts[indices[-1]] + lengths[indices[-1]]) if len(indices) else len(values)
    absolute = np.abs(values)  # Float conversion first also handles PCM value -32768.
    return {
        "rms": float(np.sqrt(np.mean(values * values))), "peak": float(absolute.max()),
        "dcOffset": float(np.mean(values)),
        "railClipSampleCount": int(np.count_nonzero((samples == -32768) | (samples == 32767))),
        "nearFullSampleCount": int(np.count_nonzero(absolute >= 0.999)),
        "nearFullThreshold": 0.999,
        "frameMilliseconds": 20, "frameRmsP10": float(p10), "frameRmsP50": float(p50),
        "frameRmsP90": float(p90), "lowEnergyThreshold": threshold,
        "lowEnergyThresholdRule": "max(0.002, frameRmsP90 * 0.08)",
        "leadingLowEnergySeconds": leading / rate, "trailingLowEnergySeconds": trailing / rate,
        "signalActiveFraction": float(lengths[active].sum() / len(values)),
        "interpretation": "Signal energy only; not speech VAD, SNR, intelligibility or quality acceptance.",
    }


def inspect_clip(clip, path):
    result = {"id": clip["id"], "filename": clip["filename"], "validationPassed": False, "errors": []}
    try:
        require(clip.get("format") == "PCM16LE" and clip.get("channels") == 1, "manifest must declare mono PCM16LE")
        rate, frames, duration = clip.get("sampleRate"), clip.get("frames"), clip.get("durationSeconds")
        require(type(rate) is int and 8000 <= rate <= 192000, "invalid declared sample rate (supported: 8000-192000 Hz)")
        require(type(frames) is int and frames > 0, "invalid declared frame count")
        require(number(duration) and duration > 0 and abs(duration * rate - frames) <= 1.000001,
                "declared duration differs from frame count by more than one sample")
        for name in ("rms", "peak"):
            require(number(clip.get(name)) and 0 <= clip[name] <= 1, f"invalid declared {name}")
        count = clip.get("clippingSampleCount")
        require(type(count) is int and 0 <= count <= frames, "invalid declared clipping sample count")
        raw = path.read_bytes()
        result["sha256"] = hashlib.sha256(raw).hexdigest()
        require(len(raw) >= 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", "not a RIFF WAVE file")
        require(struct.unpack_from("<I", raw, 4)[0] + 8 == len(raw), "RIFF size does not equal actual file size")
        with wave.open(io.BytesIO(raw), "rb") as wav:
            require(wav.getcomptype() == "NONE" and wav.getsampwidth() == 2 and wav.getnchannels() == 1,
                    "WAV must contain uncompressed mono PCM16")
            require(wav.getframerate() == rate, "WAV sample rate differs from manifest")
            require(wav.getnframes() == frames, "WAV frame count differs from manifest")
            pcm = wav.readframes(frames + 1)
        require(len(pcm) == frames * 2, "PCM data length differs from declared frames")
        stats = signal_stats(np.frombuffer(pcm, dtype="<i2"), rate)
        result.update({"sampleRate": rate, "frames": frames, "durationSeconds": frames / rate,
                       "channels": 1, "format": "PCM16LE", "bytes": len(raw), "signal": stats})
        result["manifestComparison"] = {"rmsDifference": abs(stats["rms"] - clip["rms"]),
                                        "peakDifference": abs(stats["peak"] - clip["peak"]),
                                        "absoluteTolerance": TOLERANCE,
                                        "declaredClippingSampleCount": count}
        for name in ("rms", "peak"):
            require(abs(stats[name] - clip[name]) <= TOLERANCE, f"WAV {name} differs from manifest beyond PCM16 tolerance")
        result["validationPassed"] = True
    except (OSError, ValueError, wave.Error, EOFError, struct.error) as exc:
        result["errors"].append(str(exc))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output", type=Path, help="Optional new private JSON path; never overwrite")
    parser.add_argument("--clip-id", type=int, help="Inspect one clip; entire intake remains incomplete")
    args = parser.parse_args()
    report = {"version": "own-voice-intake/1", "intakeComplete": False,
              "qualityAcceptance": "NOT_ASSESSED", "errors": [], "missingFiles": [], "clips": []}
    try:
        clips = validate_manifest(json.loads(args.manifest.read_text(encoding="utf-8-sig")))
        root = args.source_dir.resolve(strict=True)
        require(root.is_dir(), "source directory does not exist")
        require(args.clip_id is None or any(c["id"] == args.clip_id for c in clips), "clip id not found in manifest")
        report["expectedClipCount"] = len(clips)
        report["scope"] = "all" if args.clip_id is None else f"clip-{args.clip_id}"
        for clip in clips:
            path = (root / clip["filename"]).resolve()
            require(path.parent == root, f"clip {clip['id']}: resolved file escapes source directory")
            if not path.is_file():
                report["missingFiles"].append(clip["filename"])
            if args.clip_id is None or clip["id"] == args.clip_id:
                report["clips"].append(inspect_clip(clip, path))
        report["selectedChecksPassed"] = bool(report["clips"]) and all(c["validationPassed"] for c in report["clips"])
        report["intakeComplete"] = args.clip_id is None and not report["missingFiles"] and report["selectedChecksPassed"]
    except (OSError, ValueError, UnicodeError) as exc:
        report["errors"].append(str(exc))
    if args.output:
        try:
            descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
                output.write("\n")
        except OSError as exc:
            print(f"Report was not saved: {exc}", file=sys.stderr)
            return 2
    passed = sum(c["validationPassed"] for c in report["clips"])
    print(f"WAV checks: {passed}/{len(report['clips'])} selected passed; {len(report['missingFiles'])} manifest files missing.")
    print(f"Entire intake complete: {report['intakeComplete']}. Quality acceptance: NOT ASSESSED.")
    for error in report["errors"]:
        print(f"Error: {error}")
    for clip in report["clips"]:
        for error in clip["errors"]:
            print(f"Clip {clip['id']}: {error}")
    if args.output:
        print(f"Private metadata report: {args.output}")
    return 0 if report.get("selectedChecksPassed") and not report["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
