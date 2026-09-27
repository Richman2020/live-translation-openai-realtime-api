"""Generate private, offline RVC voice samples from a declared synthetic English WAV.

Uses real local HuBERT/RMVPE weights and a strictly loaded trained inference checkpoint.
Outputs are full-file 32 kHz and telephone-codec 8 kHz samples, not a real-time or
telephone acceptance test. No downloads, uploads, training, microphone, or playback.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback


REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROOT = (REPO / ".runtime").resolve()
OFFICIAL_HASHES = {
    "assets/hubert_base/pytorch_model.bin": "cc8c20f4b90a520757260197a3ff2505705a7adbd20ad9eeaa4e1a9b38442ef5",
    "assets/hubert_base/config.json": "0346950779dfb7f9316fa74ed846e2b8a22a08eedfdc5387b73f327cb1a4a7cf",
    "assets/hubert_base/preprocessor_config.json": "7c1976a680fb7acc757cd36fb08eef878fa36c70b4c9d2d595df9c608bbbbf0e",
    "assets/rmvpe/rmvpe.pt": "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193",
}
BASE_HASH = "2332611297b8d88c7436de8f17ef5f07a2119353e962cd93cda5806d59a1133d"
UPSTREAM_COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def private_path(value):
    value = Path(value).resolve()
    if not value.is_relative_to(PRIVATE_ROOT) or value == PRIVATE_ROOT:
        raise ValueError("Voice inputs, checkpoints and outputs must stay under this project's .runtime")
    return value


def synthetic_source(input_path, manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if isinstance(manifest, dict) and manifest.get("version") == "own-voice-synthetic-source/1":
        if (manifest.get("upload") is not False or manifest.get("personalVoice") is not False
                or manifest.get("source") != "Installed Microsoft Zira Desktop offline SAPI"):
            raise ValueError("Expected declared non-personal offline SAPI source")
        matches = [item for item in manifest.get("sentences", []) if isinstance(item, dict)
                   and item.get("filename") == input_path.name]
        if len(matches) != 1 or not isinstance(matches[0].get("text"), str) or not matches[0]["text"].strip():
            raise ValueError("Exactly one English fixture must match the source WAV")
        entry = matches[0]
        if entry.get("sha256") != sha256(input_path):
            raise ValueError("Synthetic source changed since its provenance manifest")
        return {"kind": "HASH_BOUND_WINDOWS_SAPI_SYNTHETIC", "voice": "Microsoft Zira Desktop",
                "language": "en-US", "text": entry["text"], "manifest_sha256": sha256(manifest_path),
                "limit": "Source created from fixed public text; not a human reference voice"}
    if not isinstance(manifest, list):
        raise ValueError("Source manifest must be a list of local Windows SAPI fixtures")
    matches = [item for item in manifest if isinstance(item, dict)
               and item.get("basename") == input_path.stem]
    if len(matches) != 1:
        raise ValueError("Exactly one source manifest entry must match the WAV basename")
    entry = matches[0]
    if (not str(entry.get("voice", "")).startswith("Microsoft ")
            or entry.get("language") != "en-US"
            or not isinstance(entry.get("text"), str) or not entry["text"].strip()):
        raise ValueError("Only declared English Microsoft SAPI synthetic fixtures are accepted")
    return {"kind": "DECLARED_WINDOWS_SAPI_SYNTHETIC", "voice": entry["voice"],
            "language": entry["language"], "text": entry["text"],
            "manifest_sha256": sha256(manifest_path),
            "limit": "Manifest provenance; does not independently identify a waveform's speaker"}


def pcm16_to_mulaw(pcm):
    """ITU G.711 mu-law encoding, with integer quantization and saturation."""
    import numpy as np
    values = np.asarray(pcm, dtype=np.int16).astype(np.int32)
    # G.711's 14-bit input quantization, including arithmetic rounding for negatives.
    values = (values >> 2) << 2
    sign = np.where(values < 0, 0x80, 0).astype(np.int32)
    magnitude = np.minimum(np.abs(values), 32635) + 132
    exponent = np.zeros_like(magnitude)
    for exponent_bit in range(1, 8):
        exponent = np.where(magnitude >= (1 << (exponent_bit + 7)), exponent_bit, exponent)
    mantissa = (magnitude >> (exponent + 3)) & 0x0F
    return (~(sign | (exponent << 4) | mantissa) & 0xFF).astype(np.uint8)


def mulaw_to_pcm16(encoded):
    import numpy as np
    values = (~np.asarray(encoded, dtype=np.uint8).astype(np.int32)) & 0xFF
    magnitude = (((values & 0x0F) << 3) + 132) << ((values >> 4) & 0x07)
    samples = np.where(values & 0x80, 132 - magnitude, magnitude - 132)
    return samples.astype(np.int16)


def pitch_inputs(raw_f0, semitones, mode):
    import numpy as np
    f0 = np.asarray(raw_f0, dtype=np.float32).copy()
    if f0.ndim != 1 or not np.isfinite(f0).all() or (f0 < 0).any():
        raise ValueError("RMVPE returned invalid F0")
    voiced = f0 > 0
    if mode == "interpolate" and voiced.any():
        unvoiced = ~voiced
        f0[unvoiced] = np.interp(np.flatnonzero(unvoiced), np.flatnonzero(voiced), f0[voiced])
    f0 *= 2 ** (semitones / 12)
    mel = 1127 * np.log1p(f0 / 700)
    lo, hi = 1127 * np.log1p(50 / 700), 1127 * np.log1p(1100 / 700)
    coarse = np.rint(np.clip(np.where(mel > 0, (mel - lo) * 254 / (hi - lo) + 1, 1), 1, 255))
    return coarse.astype(np.int64), f0, voiced


def blend_retrieved_features(original, retrieved, voiced, rate, protect):
    """Mix at 100 Hz; protect unvoiced consonants using the original pitch mask.

    As in RVC, protect=0.5 disables protection; otherwise it is the fraction of
    the retrieval change retained on unvoiced frames. No temporal smoothing.
    """
    import torch
    if (original.shape != retrieved.shape or original.ndim != 3
            or original.shape[0] != 1 or original.shape[2] != 768
            or tuple(voiced.shape) != (original.shape[1],) or voiced.dtype != torch.bool
            or not math.isfinite(rate) or not 0 <= rate <= 1
            or not math.isfinite(protect) or not 0 <= protect <= .5
            or not torch.isfinite(original).all() or not torch.isfinite(retrieved).all()):
        raise ValueError("Invalid retrieval features, voicing mask or mixing settings")
    if rate == 0:
        return original
    mixed = retrieved * rate + (1 - rate) * original
    if protect < .5:
        mask = torch.where(voiced, 1.0, protect).to(original).view(1, -1, 1)
        mixed = mixed * mask + original * (1 - mask)
    return mixed


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path, help="New private directory, never overwritten")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--force-legacy-cuda", action="store_true")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--semitones", type=float, default=0)
    parser.add_argument("--f0-mode", choices=("preserve-unvoiced", "interpolate"),
                        default="preserve-unvoiced")
    parser.add_argument("--retrieval-feature-report", type=Path,
                        help="Private verified training features; disabled unless rate is positive")
    parser.add_argument("--retrieval-rate", type=float, default=0)
    parser.add_argument("--unvoiced-protect", type=float, default=.33)
    parser.add_argument("--allow-base-control", action="store_true",
                        help="Explicit unpersonalized control only; never a clone-quality result")
    args = parser.parse_args()
    if args.threads < 1 or not math.isfinite(args.semitones) or not -12 <= args.semitones <= 12:
        parser.error("threads must be positive and semitones finite in [-12,12]")
    if args.force_legacy_cuda and args.device != "cuda":
        parser.error("force-legacy-cuda requires device=cuda")
    if (not math.isfinite(args.retrieval_rate) or not 0 <= args.retrieval_rate <= 1
            or not math.isfinite(args.unvoiced_protect) or not 0 <= args.unvoiced_protect <= .5):
        parser.error("retrieval-rate must be in [0,1] and unvoiced-protect in [0,0.5]")
    if bool(args.retrieval_feature_report) != (args.retrieval_rate > 0):
        parser.error("retrieval report and positive retrieval rate must be provided together")
    for name in ("upstream", "checkpoint", "input", "source_manifest", "out_dir"):
        setattr(args, name, private_path(getattr(args, name)))
    if args.retrieval_feature_report:
        args.retrieval_feature_report = private_path(args.retrieval_feature_report)
    if args.input.suffix.lower() != ".wav":
        parser.error("input must be a WAV")
    return args


def run(args, report):
    started = time.perf_counter()
    for name in ("checkpoint", "input", "source_manifest"):
        if not getattr(args, name).is_file():
            raise FileNotFoundError(getattr(args, name))
    report["source"] = synthetic_source(args.input, args.source_manifest)
    report["source"].update({"filename": args.input.name, "sha256": sha256(args.input)})
    report["checkpoint"] = {"filename": args.checkpoint.name, "sha256": sha256(args.checkpoint)}
    report["upstream_commit"] = subprocess.check_output(
        ["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
    if report["upstream_commit"] != UPSTREAM_COMMIT:
        raise ValueError("Unexpected upstream revision")
    if subprocess.check_output(["git", "-C", str(args.upstream), "status", "--porcelain",
                                "--untracked-files=no"], text=True).strip():
        raise ValueError("Upstream tracked files must be unchanged")
    report["model_sha256"] = {}
    for relative, expected in OFFICIAL_HASHES.items():
        actual = sha256(args.upstream / relative)
        if actual != expected:
            raise ValueError("Unexpected official model checksum: " + relative)
        report["model_sha256"][relative] = actual
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "RVC_CUDA_GRAPH": "0", "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1",
                       "OMP_NUM_THREADS": str(args.threads)})
    sys.path.insert(0, str(args.upstream))
    os.chdir(args.upstream)
    import numpy as np
    import soundfile as sf
    from scipy.signal import butter, resample_poly, sosfiltfilt
    import torch
    import torch.nn.functional as functional
    from infer.hubert import load_hubert_model, extract_hubert_features, hubert_audio_requires_normalization
    from infer.module.models import SynthesizerTrnMs768NSFsid
    from infer.rmvpe import RMVPE

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(1709)
    report["torch"] = {"version": str(torch.__version__), "cuda_runtime": torch.version.cuda}
    device = torch.device("cuda:0" if args.device == "cuda" else "cpu")
    if device.type == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("Requested CUDA unavailable; no CPU fallback")
        import configs.config as upstream_config
        selector = upstream_config.get_device_dtype_sm
        report["upstream_default_device"] = str(selector(0)[0])
        if selector(0)[0].type != "cuda" and not args.force_legacy_cuda:
            raise RuntimeError("GPU rejected by upstream; explicit legacy flag required")
        if args.force_legacy_cuda:
            def local_selector(index):
                if index == 0:
                    major, minor = torch.cuda.get_device_capability(0)
                    memory = torch.cuda.get_device_properties(0).total_memory / 1024**3
                    return device, torch.float32, major + minor / 10, memory
                return selector(index)
            upstream_config.get_device_dtype_sm = local_selector
        torch.cuda.reset_peak_memory_stats(device)
        report["gpu"] = {"name": torch.cuda.get_device_name(device),
                         "compute_capability": list(torch.cuda.get_device_capability(device))}

    def sync():
        if device.type == "cuda":
            torch.cuda.synchronize(device)

    timings = report["timings_seconds"] = {}
    def measured(name, callback):
        sync()
        before = time.perf_counter()
        result = callback()
        sync()
        timings[name] = time.perf_counter() - before
        return result

    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    if checkpoint.get("version") != "v2" or checkpoint.get("f0") != 1:
        raise ValueError("Expected actual v2 F0 inference checkpoint")
    config = list(checkpoint["config"])
    if len(config) != 18 or config[-1] != 32000:
        raise ValueError("Expected v2 32k inference configuration")
    own_metadata = checkpoint.get("own_voice_metadata")
    probe_metadata = checkpoint.get("probe_metadata", {})
    if own_metadata:
        if (not isinstance(own_metadata, dict)
                or own_metadata.get("role") != "own-voice-local-trained"
                or not isinstance(own_metadata.get("training_steps"), int)
                or isinstance(own_metadata["training_steps"], bool)
                or own_metadata["training_steps"] <= 0
                or own_metadata.get("source_sha256") != BASE_HASH
                or not isinstance(own_metadata.get("dataset_sha256"), str)
                or len(own_metadata["dataset_sha256"]) != 64):
            raise ValueError("Require actual completed own-voice training and dataset/source provenance")
        report["checkpoint"].update({"role": "OWN_VOICE_TRAINED_CANDIDATE",
                                     "own_voice_metadata": own_metadata})
    elif (args.allow_base_control and probe_metadata.get("role") == "official-unpersonalized-base"
          and probe_metadata.get("source_sha256") == BASE_HASH):
        report["checkpoint"]["role"] = "UNPERSONALIZED_BASE_CONTROL_NOT_A_CLONE"
    else:
        raise ValueError("Require own_voice_metadata; use explicit flag only for verified base control")
    bank = None
    report["retrieval"] = {"enabled": False}
    if args.retrieval_feature_report:
        if not own_metadata:
            raise ValueError("Feature retrieval requires an actual own-voice checkpoint")
        from own_voice_retrieval import VoiceFeatureBank
        bank = measured("retrieval_bank_load", lambda: VoiceFeatureBank(
            args.retrieval_feature_report, own_metadata["dataset_sha256"],
            UPSTREAM_COMMIT, OFFICIAL_HASHES, threads=args.threads))
        report["retrieval"] = {**bank.metadata, "enabled": True,
                               "rate": args.retrieval_rate, "unvoiced_protect": args.unvoiced_protect,
                               "voicing_policy": "raw RMVPE mask before any F0 interpolation"}
        report["limits"].remove("No retrieval index")
        report["limits"].append("Exact local training-feature retrieval; quality and phone latency unaccepted")
    weights = checkpoint["weight"]
    if any(key.startswith("enc_q.") for key in weights):
        raise ValueError("Export an inference checkpoint without the training posterior encoder")
    config[-3] = weights["emb_g.weight"].shape[0]
    def load_decoder():
        decoder = SynthesizerTrnMs768NSFsid(*config, is_half=False)
        del decoder.enc_q
        decoder.load_state_dict(weights, strict=True)
        decoder = decoder.float().eval().to(device)
        decoder.remove_weight_norm()
        return decoder
    decoder = measured("decoder_load", load_decoder)
    del weights, checkpoint
    hubert = measured("hubert_load", lambda: load_hubert_model(str(device), False))
    normalize_hubert_audio = hubert_audio_requires_normalization()
    report["hubert_audio_normalization"] = normalize_hubert_audio
    rmvpe = measured("rmvpe_load", lambda: RMVPE(
        str(args.upstream / "assets/rmvpe/rmvpe.pt"), is_half=False, device=str(device)))
    report["actual_models"] = {
        name: {"device": str(next(model.parameters()).device),
               "dtype": str(next(model.parameters()).dtype),
               "parameters": sum(parameter.numel() for parameter in model.parameters())}
        for name, model in (("hubert", hubert), ("rmvpe", rmvpe.model), ("decoder", decoder))
    }
    if any(value["device"].split(":")[0] != device.type or value["dtype"] != "torch.float32"
           for value in report["actual_models"].values()):
        raise RuntimeError("A model selected a different device or precision")

    original, sample_rate = sf.read(args.input, dtype="float32", always_2d=True)
    if original.shape[1] != 1 or not np.isfinite(original).all():
        raise ValueError("Controlled source must be finite mono audio")
    original = original[:, 0]
    duration = len(original) / sample_rate
    if not .1 <= duration <= 15:
        raise ValueError("Offline whole-file sample must be 0.1 to 15 seconds")
    if float(np.max(np.abs(original))) < .0001:
        raise ValueError("Source is effectively silent")
    report["source"].update({"sample_rate": sample_rate, "duration_seconds": duration,
                             "narrowband_source": sample_rate <= 8000})
    divisor = math.gcd(sample_rate, 16000)
    audio16 = measured("input_resampling", lambda: resample_poly(
        original, 16000 // divisor, sample_rate // divisor).astype(np.float32))
    filtered = sosfiltfilt(butter(5, 48, btype="highpass", fs=16000, output="sos"), audio16).astype(np.float32)
    pad = 16000
    tail_frame_pad = (-len(filtered)) % 160
    padded = np.pad(filtered, (pad, pad + tail_frame_pad), mode="reflect")
    frames = len(padded) // 160
    with torch.no_grad():
        wave_tensor = torch.from_numpy(padded).unsqueeze(0).to(device)
        if normalize_hubert_audio:
            wave_tensor = functional.layer_norm(wave_tensor, (wave_tensor.shape[-1],))
        features = measured("hubert_features", lambda: extract_hubert_features(hubert, wave_tensor, "v2"))
        retrieved_features = None
        if bank is not None:
            retrieved_features = measured("feature_retrieval", lambda: torch.from_numpy(
                bank.retrieve(features[0].detach().cpu().float().numpy())).unsqueeze(0).to(device))
        # Realtime RVC repeats the final HuBERT frame before doubling to 100 Hz.
        # This supplies edge context while retaining the entire last source phoneme.
        features = torch.cat((features, features[:, -1:, :]), dim=1)
        features = functional.interpolate(features.transpose(1, 2), scale_factor=2).transpose(1, 2)
        if features.shape[1] < frames or features.shape[2] != 768 or not torch.isfinite(features).all():
            raise RuntimeError("Invalid or insufficient actual HuBERT features")
        features = features[:, :frames, :]
        if retrieved_features is not None:
            retrieved_features = torch.cat((retrieved_features, retrieved_features[:, -1:, :]), dim=1)
            retrieved_features = functional.interpolate(
                retrieved_features.transpose(1, 2), scale_factor=2).transpose(1, 2)[:, :frames, :]
        raw_f0 = measured("rmvpe_f0", lambda: rmvpe.infer_from_audio(padded, thred=.03))
        if len(raw_f0) < frames:
            raise RuntimeError("RMVPE frame count is shorter than source")
        coarse, fine, voiced = pitch_inputs(raw_f0[:frames], args.semitones, args.f0_mode)
        if retrieved_features is not None:
            original_features = features
            features = measured("retrieval_blend", lambda: blend_retrieved_features(
                original_features, retrieved_features, torch.from_numpy(voiced).to(device),
                args.retrieval_rate, args.unvoiced_protect))
            report["retrieval"]["feature_change_rms"] = float(
                (features - original_features).square().mean().sqrt().item())
        report["features"] = {"frames": frames, "dimensions": 768,
                              "raw_voiced_fraction": float(voiced.mean()),
                              "raw_voiced_median_hz": float(np.median(raw_f0[:frames][voiced])) if voiced.any() else None,
                              "f0_mode": args.f0_mode, "semitones": args.semitones,
                              "left_reflection_pad_ms": 1000, "right_reflection_pad_ms": 1000 + tail_frame_pad / 16}
        lengths = torch.tensor([frames], device=device)
        speaker = torch.tensor([0], device=device)
        coarse_tensor = torch.from_numpy(coarse).unsqueeze(0).to(device)
        fine_tensor = torch.from_numpy(fine).unsqueeze(0).to(device)
        generated = measured("generation_and_copy", lambda: decoder.infer(
            features, lengths, coarse_tensor, fine_tensor, speaker)[0][0, 0].detach().cpu().float().numpy())
    target_frames = round(duration * 32000)
    generated = generated[32000:32000 + target_frames]
    if len(generated) != target_frames or not np.isfinite(generated).all():
        raise RuntimeError("Generated sample is truncated or non-finite")
    peak = float(np.max(np.abs(generated)))
    if peak < 1e-6:
        raise RuntimeError("Generated sample is effectively silent")
    # Attenuate only to prevent encoding overload; never hide quiet output by boosting it.
    gain = min(1.0, .98 / peak)
    audio32 = (generated * gain).astype(np.float32)
    before_codec = time.perf_counter()
    audio8 = resample_poly(audio32, 1, 4).astype(np.float32)
    pcm8 = np.rint(np.clip(audio8, -1, 32767 / 32768) * 32768).astype(np.int16)
    ulaw = pcm16_to_mulaw(pcm8)
    decoded = mulaw_to_pcm16(ulaw)
    timings["telephone_resampling_and_g711_roundtrip"] = time.perf_counter() - before_codec
    outputs = {
        "source-original.wav": (original, sample_rate),
        "converted-32k.wav": (audio32, 32000),
        "converted-phone-8k.wav": (decoded, 8000),
    }
    report["outputs"] = {}
    for filename, (wave, rate) in outputs.items():
        path = args.out_dir / filename
        with path.open("xb") as stream:
            sf.write(stream, wave, rate, format="WAV", subtype="PCM_16")
        report["outputs"][filename] = {"sha256": sha256(path), "sample_rate": rate,
                                        "frames": len(wave), "duration_seconds": len(wave) / rate}
    with (args.out_dir / "converted-phone-8k.ulaw").open("xb") as stream:
        stream.write(ulaw.tobytes())
    report["outputs"]["converted-phone-8k.ulaw"] = {
        "sha256": sha256(args.out_dir / "converted-phone-8k.ulaw"),
        "format": "G711_MULAW_8000_MONO", "bytes": len(ulaw), "duration_seconds": len(ulaw) / 8000,
    }
    compute_seconds = sum(timings.get(name, 0) for name in (
        "hubert_features", "rmvpe_f0", "feature_retrieval", "retrieval_blend", "generation_and_copy"))
    report["measurement"] = {"actual_input_seconds": duration,
                             "actual_output_seconds": len(audio32) / 32000,
                             "whole_file_compute_seconds": compute_seconds,
                             "whole_file_compute_rtf": compute_seconds / duration,
                             "raw_output_peak": peak, "anti_clip_gain": gain,
                             "raw_output_rms": float(np.sqrt(np.mean(generated.astype(np.float64) ** 2))),
                             "phone_before_pcm_peak": float(np.max(np.abs(audio8))),
                             "phone_pcm_clipped_samples": int(np.count_nonzero((audio8 < -1) | (audio8 > 32767 / 32768))),
                             "ready_for_listening_only": True,
                             "voice_similarity": "NOT_ASSESSED", "meaning_preservation": "NOT_ASSESSED",
                             "telephone_added_latency": "NOT_MEASURED"}
    if device.type == "cuda":
        report["gpu"].update({"peak_allocated_bytes": torch.cuda.max_memory_allocated(device),
                               "peak_reserved_bytes": torch.cuda.max_memory_reserved(device)})
    report["total_wall_seconds"] = time.perf_counter() - started
    report["status"] = "completed"


def main():
    args = arguments()
    args.out_dir.mkdir(exist_ok=False)
    report = {"schema": "own-voice-offline-sample/1.0", "status": "started",
              "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "scope": "LOCAL_FULL_FILE_SAMPLE_NOT_PHONE_OR_STREAMING_ACCEPTANCE",
              "settings": {key: value for key, value in vars(args).items() if not isinstance(value, Path)},
              "limits": ["No retrieval index", "No translation evaluation", "No live-phone latency measurement",
                         "Synthetic source may retain its pitch, accent and timing", "Human listening required"]}
    with (args.out_dir / "report.private.json").open("x", encoding="utf-8") as destination:
        try:
            run(args, report)
        except Exception as error:
            report["status"] = "failed"
            report["error"] = {"type": type(error).__name__, "message": str(error),
                               "traceback": traceback.format_exc()}
        finally:
            report["finished_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            json.dump(report, destination, ensure_ascii=False, indent=2, allow_nan=False)
            destination.write("\n")
    print(json.dumps({"status": report["status"], "report": str(args.out_dir / "report.private.json")},
                     ensure_ascii=False))
    return 0 if report["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
