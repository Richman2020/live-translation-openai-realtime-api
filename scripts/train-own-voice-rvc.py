"""Bounded, private RVC v2/32k own-voice fine-tuning pilot.

Uses the pinned upstream loader, collate, full GAN models and losses. Inputs must
be normalized float32 WAV plus real HuBERT/F0 files produced locally. This is an
offline pilot, not a voice-quality or phone-latency acceptance. --validate-only
exercises the complete official dataset on CPU without allocating a GPU/model.
The cooperative training deadline cannot preempt a running CUDA operation.
"""

import argparse
import gc
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time
import traceback
from types import SimpleNamespace


SCOPE = "OWN_VOICE_LOCAL_TRAINING_PILOT"
RUNTIME = Path(__file__).resolve().parents[1] / ".runtime"
HELPERS = Path(__file__).with_name("benchmark-rvc-training.py")
helper_spec = importlib.util.spec_from_file_location("rvc_training_probe", HELPERS)
probe = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(probe)


def private_path(path):
    path = path.resolve()
    if not path.is_relative_to(RUNTIME.resolve()) or path == RUNTIME.resolve():
        raise ValueError("Personal dataset and output paths must be below this repository's .runtime")
    return path


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--filelist", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path,
                        help="New private run directory; never reuse or overwrite an existing directory")
    parser.add_argument("--steps", type=int, default=120)
    parser.add_argument("--max-seconds", type=float, default=600)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--force-legacy-cuda", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--resume-dir", type=Path,
                        help="Previous successful pilot run; --steps means additional updates")
    args = parser.parse_args()
    if not 2 <= args.steps <= 2000:
        parser.error("steps must be in [2,2000]")
    if not 1 <= args.threads <= 32:
        parser.error("threads must be in [1,32]")
    if not math.isfinite(args.max_seconds) or not 1 <= args.max_seconds <= 7200:
        parser.error("max-seconds must be finite and in [1,7200]")
    args.upstream = args.upstream.resolve()
    args.filelist = private_path(args.filelist)
    args.output_dir = private_path(args.output_dir)
    if args.resume_dir:
        args.resume_dir = private_path(args.resume_dir)
        if args.validate_only:
            parser.error("resume-dir cannot be combined with validate-only")
    return args


def validate_filelist(path, report):
    import numpy as np
    from scipy.io import wavfile

    rows = path.read_text(encoding="utf-8-sig").splitlines()
    if not 1 <= len(rows) <= 2000:
        raise ValueError("Expected 1..2000 real speech segments")
    assets, seen = [], set()
    for number, line in enumerate(rows, 1):
        fields = line.strip().split("|")
        if len(fields) != 5 or fields[4] != "0":
            raise ValueError(f"Filelist row {number}: expected four paths and speaker 0")
        paths = [private_path(Path(field)) for field in fields[:4]]
        if any(not Path(field).is_absolute() for field in fields[:4]):
            raise ValueError(f"Filelist row {number}: absolute paths required")
        if paths[0] in seen:
            raise ValueError("Duplicate waveform in training filelist")
        seen.add(paths[0])
        if paths[0].suffix != ".wav" or any(item.suffix != ".npy" for item in paths[1:]):
            raise ValueError("Expected .wav/.npy training assets")
        rate, wave = wavfile.read(paths[0])
        if rate != 32000 or wave.dtype != np.float32 or wave.ndim != 1:
            raise ValueError(f"Row {number}: official loader requires normalized mono float32/32k WAV")
        if not 16000 <= len(wave) <= 118400 or not np.isfinite(wave).all():
            raise ValueError(f"Row {number}: waveform must be finite and 0.5..3.7 seconds")
        if not 0 < float(np.max(np.abs(wave))) <= 1:
            raise ValueError(f"Row {number}: waveform must be nonzero and normalized")
        phone, pitch, pitchf = [np.load(item, allow_pickle=False) for item in paths[1:]]
        if (phone.ndim != 2 or phone.shape[1] != 768 or phone.dtype != np.float32
                or not np.isfinite(phone).all() or not 20 <= len(phone) <= 185):
            raise ValueError(f"Row {number}: expected finite float32 HuBERT [frames,768] at 50 Hz")
        if (pitch.ndim != 1 or pitch.dtype.kind not in "iu" or not 1 <= pitch.min()
                or pitch.max() > 255 or pitchf.ndim != 1 or pitchf.dtype != np.float32
                or not np.isfinite(pitchf).all() or np.any(pitchf < 0) or np.any(pitchf > 2000)):
            raise ValueError(f"Row {number}: invalid coarse/continuous F0")
        expected_frames = len(wave) // 320
        effective_frames = min(2 * len(phone), expected_frames)
        if not 40 <= effective_frames <= 370 or expected_frames - effective_frames > 4:
            raise ValueError(f"Row {number}: excessive audio/feature misalignment")
        if len(pitch) != len(pitchf) or len(pitch) < effective_frames or len(pitch) > expected_frames + 2:
            raise ValueError(f"Row {number}: pitch length differs from audio/features")
        assets.append({"row": number, "files": [{"path": str(item), "sha256": probe.sha256(item)}
                                                for item in paths],
                       "audio_samples": len(wave), "hubert_frames": len(phone),
                       "effective_frames": effective_frames, "peak": float(np.abs(wave).max()),
                       "rms": float(np.sqrt(np.mean(wave.astype(np.float64) ** 2)))})
    report["dataset"] = {"filelist": str(path), "sha256": probe.sha256(path), "segments": assets,
                         "segment_count": len(assets), "batch_size": 1,
                         "audio_seconds_including_overlap": sum(item["audio_samples"] for item in assets) / 32000,
                         "speaker_id": 0, "format": "normalized-float32/32000/mono",
                         "semantics_or_intelligibility_verified": False}
    return assets


def load_dataset(torch, args, config, report):
    import train.data_utils as data_utils
    from train.data_utils import TextAudioLoaderMultiNSFsid, TextAudioCollateMultiNSFsid
    from train.mel_processing import spectrogram_torch
    from scipy.io import wavfile

    # Official read_text tries the Windows locale before UTF-8 and may silently
    # mojibake a Chinese path. Scope only explicit filelist decoding to loader
    # construction; all waveform/feature processing remains the official code.
    original_reader = data_utils.load_filepaths_and_text
    def utf8_filelist(filename, split="|"):
        return [line.strip().split(split) for line in Path(filename).read_text(encoding="utf-8-sig").splitlines()]
    data_utils.load_filepaths_and_text = utf8_filelist
    try:
        dataset = TextAudioLoaderMultiNSFsid(str(args.filelist), SimpleNamespace(**config["data"]))
    finally:
        data_utils.load_filepaths_and_text = original_reader
    collate = TextAudioCollateMultiNSFsid()
    if len(dataset) != report["dataset"]["segment_count"]:
        raise RuntimeError("Official loader unexpectedly filtered training records")
    frame_counts = []
    # Preflight every real segment on CPU, including official spectral cache and
    # feature/audio alignment, before occupying the limited GPU memory.
    for index in range(len(dataset)):
        batch = collate([dataset[index]])
        phone, lengths, pitch, pitchf, spec, spec_lengths, wave, wave_lengths, sid = batch
        frames = int(lengths.item())
        if frames != report["dataset"]["segments"][index]["effective_frames"]:
            raise RuntimeError(f"Official loader changed expected real-input frame count at record {index}")
        if (phone.shape != (1, frames, 768) or spec.shape != (1, 513, frames)
                or pitch.shape != (1, frames) or pitchf.shape != (1, frames)
                or not 40 <= frames <= 370 or int(spec_lengths.item()) != frames
                or wave.shape != (1, 1, int(wave_lengths.item()))
                or int(wave_lengths.item()) < frames * 320 or int(sid.item()) != 0):
            raise RuntimeError(f"Official loader/collate unexpected shape at record {index}")
        if any(not bool(torch.isfinite(tensor).all()) for tensor in batch):
            raise RuntimeError(f"Official loader produced a nonfinite tensor at record {index}")
        # Upstream trusts a sibling .spec.pt cache by filename. Independently
        # recompute it from the hash-verified WAV so stale but finite caches can
        # never silently change the target spectrum on either first run/resume.
        wave_path = Path(dataset.audiopaths_and_text[index][0])
        _, raw = wavfile.read(wave_path)
        data = config["data"]
        expected_spec = spectrogram_torch(torch.from_numpy(raw).unsqueeze(0),
                                          data["filter_length"], data["sampling_rate"],
                                          data["hop_length"], data["win_length"], center=False)
        if not torch.allclose(spec, expected_spec[:, :, :frames], rtol=1e-5, atol=1e-6):
            raise RuntimeError(f"Spectrogram cache differs from actual waveform at record {index}")
        frame_counts.append(frames)
    report["official_loader_validation"] = {
        "loader": "train.data_utils.TextAudioLoaderMultiNSFsid",
        "collate": "train.data_utils.TextAudioCollateMultiNSFsid",
        "segments_checked": len(frame_counts), "min_frames": min(frame_counts),
        "max_frames": max(frame_counts), "all_shapes_and_values_valid": True,
        "spectrogram_cache_written_beside_derived_wavs": True,
        "every_cached_spectrum_verified_against_waveform": True,
        "filelist_encoding_adapter": "explicit UTF-8 only during loader construction; upstream unchanged",
    }
    return dataset, collate


def export_config(config):
    data, model = config["data"], config["model"]
    # Same inference shape list as official train/process_ckpt.py::savee.
    return [data["filter_length"] // 2 + 1, 32, model["inter_channels"],
            model["hidden_channels"], model["filter_channels"], model["n_heads"],
            model["n_layers"], model["kernel_size"], model["p_dropout"], model["resblock"],
            model["resblock_kernel_sizes"], model["resblock_dilation_sizes"],
            model["upsample_rates"], model["upsample_initial_channel"],
            model["upsample_kernel_sizes"], model["spk_embed_dim"],
            model["gin_channels"], data["sampling_rate"]]


def save_roundtrip(torch, payload, path):
    expected = probe.tree_digest(torch, payload)
    with path.open("xb") as stream:
        torch.save(payload, stream)
    # Deliberately weights-only; no unsafe pickle fallback for our own artifacts.
    restored = torch.load(path, map_location="cpu", weights_only=True)
    if probe.tree_digest(torch, restored) != expected:
        raise RuntimeError(f"Checkpoint roundtrip mismatch: {path.name}")
    del restored
    gc.collect()
    return {"path": str(path), "sha256": probe.sha256(path), "bytes": path.stat().st_size,
            "exact_cpu_roundtrip": True}


def validate_resume(args, config, report):
    if not args.resume_dir:
        return None
    prior_path = args.resume_dir / "training-report.json"
    prior = json.loads(prior_path.read_text(encoding="utf-8"))
    if (prior.get("schema") != "own-voice-rvc-training/1"
            or prior.get("status") != "pilot_training_passed"
            or prior.get("scope") != SCOPE or prior.get("completed_steps", 0) < 2
            or prior.get("upstream_commit") != probe.UPSTREAM_COMMIT
            or prior.get("configuration", {}).get("values") != config):
        raise ValueError("Resume requires a successful compatible real-voice pilot")
    # Rehash every actual input, not only the filelist text, to prevent silent
    # continuation against changed voice data/features under unchanged paths.
    for key in ("sha256", "segments", "segment_count"):
        if prior["dataset"][key] != report["dataset"][key]:
            raise ValueError(f"Resume dataset differs: {key}")
    for name in ("G", "D"):
        path = args.resume_dir / f"{name}_training.pt"
        if probe.sha256(path) != prior["checkpoints"][name]["sha256"]:
            raise ValueError(f"Resume {name} checkpoint checksum mismatch")
    report["resume"] = {"directory": str(args.resume_dir), "report_sha256": probe.sha256(prior_path),
                         "initial_completed_steps": prior["completed_steps"],
                         "same_dataset_bytes_verified": True}
    return prior


def read_resume(torch, args, name, config, report):
    state = torch.load(args.resume_dir / f"{name}_training.pt", map_location="cpu", weights_only=True)
    if (state.get("scope") != SCOPE or state.get("config") != config
            or state.get("completed_steps") != report["resume"]["initial_completed_steps"]
            or state.get("dataset_sha256") != report["dataset"]["sha256"]
            or state.get("upstream_commit") != probe.UPSTREAM_COMMIT):
        raise ValueError("Resume state metadata mismatch")
    return state


def training(torch, args, config, dataset, collate, models, report, update):
    from infer.module import commons
    from train.losses import discriminator_loss, feature_loss, generator_loss, kl_loss
    from train.mel_processing import spec_to_mel_torch, mel_spectrogram_torch
    from torch.nn import functional as F

    data, train = config["data"], config["train"]
    device = torch.device("cuda:0")
    net_g, net_d = models
    net_g.to(device).train()
    net_d.to(device).train()
    report["models"] = {"G": probe.tensor_summary(torch, net_g, device, True),
                        "D": probe.tensor_summary(torch, net_d, device, True)}
    if not hasattr(net_g, "enc_q") or len(net_d.discriminators) != 9:
        raise RuntimeError("Incomplete full v2 GAN training architecture")
    optimizers = [torch.optim.AdamW(model.parameters(), train["learning_rate"],
                                   betas=train["betas"], eps=train["eps"])
                  for model in models]
    optim_g, optim_d = optimizers
    schedulers = [torch.optim.lr_scheduler.ExponentialLR(optimizer, gamma=train["lr_decay"])
                  for optimizer in optimizers]
    report["optimizer"] = {"name": "AdamW", "learning_rate": train["learning_rate"],
                           "betas": train["betas"], "eps": train["eps"], "weight_decay": 0.01,
                           "scheduler": "ExponentialLR once per complete dataset pass",
                           "lr_decay": train["lr_decay"]}
    segment_frames = train["segment_size"] // data["hop_length"]
    shuffle = random.Random(train["seed"])
    order, position, epoch = [], 0, 0
    initial_steps = 0
    seen_rows = set()
    if args.resume_dir:
        for name, optimizer, scheduler in zip(("G", "D"), optimizers, schedulers):
            state = read_resume(torch, args, name, config, report)
            optimizer.load_state_dict(state["optimizer"])
            scheduler.load_state_dict(state["scheduler"])
            initial_steps = state["completed_steps"]
            probe.optimizer_summary(torch, optimizer, initial_steps)
            if name == "G":
                sampler = state["sampler"]
                order, position, epoch = sampler["order"], sampler["position"], sampler["epoch"]
                if sorted(order) != list(range(len(dataset))) or not 0 <= position <= len(order):
                    raise ValueError("Invalid resumed sampler state")
                shuffle.setstate(sampler["random_state"])
                torch.set_rng_state(state["torch_cpu_rng_state"])
                torch.cuda.set_rng_state(state["torch_cuda_rng_state"], device)
                seen_rows = set(state.get("seen_dataset_rows", []))
            del state
            gc.collect()
        report["resume"]["optimizer_scheduler_rng_sampler_restored"] = True
    report["training_steps"] = []
    torch.cuda.synchronize(device)
    started = time.perf_counter()

    def deadline(stage):
        elapsed = time.perf_counter() - started
        report["training_elapsed_seconds"] = elapsed
        if elapsed >= args.max_seconds:
            raise TimeoutError(f"Training deadline reached before {stage}")

    for index in range(args.steps):
        step = initial_steps + index + 1
        deadline("next real segment")
        if position == len(order):
            if order:
                for scheduler in schedulers:
                    scheduler.step()
            epoch += 1
            order = list(range(len(dataset)))
            shuffle.shuffle(order)
            position = 0
        row = order[position]
        batch = collate([dataset[row]])
        phone, lengths, pitch, pitchf, spec, spec_lengths, wave_full, _, sid = [
            value.to(device, non_blocking=False) for value in batch]
        torch.cuda.synchronize(device)
        step_start = time.perf_counter()
        update(f"step_{step}_forward")
        before_g, before_d = probe.parameter_samples(net_g), probe.parameter_samples(net_d)
        y_hat, ids_slice, _, z_mask, (_, z_p, m_p, logs_p, _, logs_q) = net_g(
            phone, lengths, pitch, pitchf, spec, spec_lengths, sid)
        mel = spec_to_mel_torch(spec, data["filter_length"], data["n_mel_channels"],
                                data["sampling_rate"], data["mel_fmin"], data["mel_fmax"])
        y_mel = commons.slice_segments(mel, ids_slice, segment_frames)
        y_hat_mel = mel_spectrogram_torch(
            y_hat.float().squeeze(1), data["filter_length"], data["n_mel_channels"],
            data["sampling_rate"], data["hop_length"], data["win_length"],
            data["mel_fmin"], data["mel_fmax"])
        wave = commons.slice_segments(wave_full, ids_slice * data["hop_length"], train["segment_size"])
        if y_hat.shape != wave.shape or y_mel.shape != y_hat_mel.shape:
            raise RuntimeError("Generated waveform/mel differs from real target shape")
        deadline("discriminator backward")
        y_d_hat_r, y_d_hat_g, _, _ = net_d(wave, y_hat.detach())
        loss_disc, _, _ = discriminator_loss(y_d_hat_r, y_d_hat_g)
        if not bool(torch.isfinite(loss_disc).item()):
            raise RuntimeError("Nonfinite discriminator loss")
        optim_d.zero_grad()
        loss_disc.backward()
        gradients_d = probe.gradient_summary(torch, net_d, commons)
        deadline("discriminator optimizer")
        optim_d.step()
        changed_d = probe.changed_samples(torch, before_d, net_d)
        state_d = probe.optimizer_summary(torch, optim_d, step)
        deadline("generator backward")
        y_d_hat_r, y_d_hat_g, fmap_r, fmap_g = net_d(wave, y_hat)
        loss_mel = F.l1_loss(y_mel, y_hat_mel) * train["c_mel"]
        loss_kl = kl_loss(z_p, logs_q, m_p, logs_p, z_mask) * train["c_kl"]
        loss_fm = feature_loss(fmap_r, fmap_g)
        loss_gen, _ = generator_loss(y_d_hat_g)
        loss_gen_all = loss_gen + loss_fm + loss_mel + loss_kl
        losses = {"discriminator": loss_disc, "generator_adversarial": loss_gen,
                  "feature_matching": loss_fm, "mel_weighted": loss_mel,
                  "kl_weighted": loss_kl, "generator_total": loss_gen_all}
        if not all(bool(torch.isfinite(value).item()) for value in losses.values()):
            raise RuntimeError("Nonfinite generator loss")
        optim_g.zero_grad()
        loss_gen_all.backward()
        gradients_g = probe.gradient_summary(torch, net_g, commons)
        deadline("generator optimizer")
        optim_g.step()
        changed_g = probe.changed_samples(torch, before_g, net_g)
        state_g = probe.optimizer_summary(torch, optim_g, step)
        torch.cuda.synchronize(device)
        position += 1
        seen_rows.add(row + 1)
        report["training_steps"].append({
            "step": step, "epoch": epoch, "dataset_row": row + 1,
            "encoder_frames": int(lengths.item()), "decoder_segment_samples": train["segment_size"],
            "seconds_including_validation": time.perf_counter() - step_start,
            "losses": {name: float(value.detach().item()) for name, value in losses.items()},
            "gradients": {"G": gradients_g, "D": gradients_d},
            "changed_parameter_samples": {"G": changed_g, "D": changed_d},
            "adamw_state": {"G": state_g, "D": state_d},
            "learning_rate": optim_g.param_groups[0]["lr"],
        })
        report["completed_steps"] = step
        report["new_completed_steps"] = index + 1
        update(f"step_{step}_complete")
        # Release autograd/output references before the following step/checkpoint.
        del losses, loss_gen_all, loss_disc, loss_gen, loss_fm, loss_mel, loss_kl
        del y_hat, y_hat_mel, y_mel, mel, wave, y_d_hat_r, y_d_hat_g, fmap_r, fmap_g
        del z_p, m_p, logs_p, logs_q, z_mask, batch
    probe.tensor_summary(torch, net_g, device, True)
    probe.tensor_summary(torch, net_d, device, True)
    report["all_final_parameters_finite"] = True
    report["training_loop_seconds"] = time.perf_counter() - started
    samples = [item["seconds_including_validation"] for item in report["training_steps"]]
    report["step_timing"] = {"first_seconds": samples[0], "mean_seconds": statistics.mean(samples),
                             "subsequent_mean_seconds": statistics.mean(samples[1:]),
                             "max_seconds": max(samples), "includes_finite_checks_and_start_report_io": True}
    report["dataset_exposure"] = {"unique_segments_this_run": len({item["dataset_row"] for item in report["training_steps"]}),
                                   "unique_segments_cumulative": len(seen_rows),
                                   "total_segments": len(dataset), "epoch": epoch,
                                   "position_in_epoch": position,
                                   "full_passes": ((initial_steps + args.steps) // len(dataset))}
    update("saving_private_training_state")
    common = {"scope": SCOPE, "config": config, "completed_steps": initial_steps + args.steps,
              "dataset_sha256": report["dataset"]["sha256"],
              "seen_dataset_rows": sorted(seen_rows),
              "sampler": {"epoch": epoch, "position": position, "order": order,
                          "random_state": shuffle.getstate()},
              "torch_cpu_rng_state": torch.get_rng_state(),
              "torch_cuda_rng_state": torch.cuda.get_rng_state(device),
              "upstream_commit": probe.UPSTREAM_COMMIT}
    report["checkpoints"] = {}
    for name, model, optimizer, scheduler in zip(("G", "D"), models, optimizers, schedulers):
        model.zero_grad(set_to_none=True)
        model.cpu()
        payload = {**common, "model": model.state_dict(),
                   "optimizer": probe.cpu_tree(torch, optimizer.state_dict()),
                   "scheduler": scheduler.state_dict()}
        # Transfer optimizer state out of GPU before roundtrip; retain full state
        # only in this CPU payload to limit simultaneous GPU and host duplication.
        optimizer.state.clear()
        gc.collect()
        torch.cuda.empty_cache()
        report["checkpoints"][name] = save_roundtrip(torch, payload, args.output_dir / f"{name}_training.pt")
        del payload
        gc.collect()
    export = {"weight": {name: value.detach().cpu() for name, value in net_g.state_dict().items()
                         if "enc_q" not in name},
              "config": export_config(config), "sr": "32k", "f0": 1, "version": "v2",
              "info": f"Local own-voice pilot, {common['completed_steps']} updates; quality not accepted",
              "speaker_info": [{"id": 0, "name": "own-voice-pilot"}],
              "own_voice_metadata": {"scope": SCOPE, "training_steps": common["completed_steps"],
                                 "role": "own-voice-local-trained",
                                 "dataset_sha256": common["dataset_sha256"],
                                 "source_sha256": probe.MODEL_HASHES["G"],
                                 "precision": "float32", "quality_accepted": False}}
    report["checkpoints"]["inference"] = save_roundtrip(torch, export, args.output_dir / "own_voice_pilot.pth")
    # Prove the export loads through the same official inference architecture,
    # independently of training-only posterior weights. No voice audio generated.
    from infer.module.models import SynthesizerTrnMs768NSFsid
    inference_model = SynthesizerTrnMs768NSFsid(*export["config"], is_half=False)
    del inference_model.enc_q
    inference_model.load_state_dict(export["weight"], strict=True)
    report["inference_export_validation"] = {"strict_official_architecture_load": True,
                                             "posterior_encoder_excluded": True,
                                             "floating_dtype": "torch.float32",
                                             "generated_audio": False, "quality_accepted": False}
    del inference_model, export
    report["training_resume_validation"] = ("PASSED continuing actual updates from saved state" if args.resume_dir
                                             else "NOT_RUN; model/optimizer/scheduler/RNG/sampler state saved")


def run(args, report, update):
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "RVC_CUDA_GRAPH": "0",
                       "TORCH_FORCE_WEIGHTS_ONLY_LOAD": "1", "OMP_NUM_THREADS": str(args.threads)})
    commit = subprocess.check_output(["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(args.upstream), "status", "--porcelain",
                                     "--untracked-files=no"], text=True).strip()
    if commit != probe.UPSTREAM_COMMIT or dirty:
        raise RuntimeError("Pinned upstream commit and unmodified tracked upstream files required")
    report["upstream_commit"] = commit
    report["upstream_tracked_files_clean"] = True
    config_path = args.upstream / "configs/v2/32k.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if config["train"]["segment_size"] != 12800 or config["data"]["hop_length"] != 320:
        raise RuntimeError("Unexpected official 32k configuration")
    report["configuration"] = {"sha256": probe.sha256(config_path), "values": config}
    update("validating_private_training_assets")
    validate_filelist(args.filelist, report)
    validate_resume(args, config, report)
    sys.path.insert(0, str(args.upstream))
    import torch

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.set_default_dtype(torch.float32)
    torch.manual_seed(config["train"]["seed"])
    report["torch"] = {"version": str(torch.__version__), "cuda_runtime": torch.version.cuda}
    update("validating_official_real_dataset_loader")
    dataset, collate = load_dataset(torch, args, config, report)
    if args.validate_only:
        report["status"] = "validated_inputs_only"
        update("complete_without_gpu_training")
        return
    report["model_sources"] = {}
    for name, expected in probe.MODEL_HASHES.items():
        path = args.upstream / f"assets/pretrained_v2/f0{name}32k.pth"
        actual = probe.sha256(path)
        if actual != expected:
            raise RuntimeError(f"Official pretrained {name} checksum mismatch")
        report["model_sources"][name] = {"filename": path.name, "sha256": actual}
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; no implicit CPU training fallback")
    torch.cuda.set_device(0)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    report["gpu"] = {"name": torch.cuda.get_device_name(0),
                     "compute_capability": list(torch.cuda.get_device_capability(0)),
                     "total_bytes": torch.cuda.get_device_properties(0).total_memory,
                     "free_bytes_before_models": torch.cuda.mem_get_info(0)[0]}
    import configs.config as upstream_config

    try:
        selected = upstream_config.get_training_dtype()
        report["upstream_training_policy"] = {"accepted": True, "dtype": str(selected)}
    except RuntimeError as error:
        report["upstream_training_policy"] = {"accepted": False, "error": str(error)}
        if not args.force_legacy_cuda:
            raise RuntimeError("Explicit --force-legacy-cuda required on GPU rejected by upstream") from error
    report["precision"] = {"actual": "torch.float32", "amp": False, "grad_scaler": False,
                           "legacy_policy_bypass_applied": not report["upstream_training_policy"]["accepted"],
                           "upstream_files_changed": False}
    from infer.module.models import SynthesizerTrnMs768NSFsid, MultiPeriodDiscriminatorV2

    update("loading_verified_models_on_cpu")
    data, train = config["data"], config["train"]
    net_g = SynthesizerTrnMs768NSFsid(data["filter_length"] // 2 + 1,
                                    train["segment_size"] // data["hop_length"],
                                    **config["model"], is_half=False, sr=data["sampling_rate"])
    net_d = MultiPeriodDiscriminatorV2(config["model"]["use_spectral_norm"])
    for name, model in (("G", net_g), ("D", net_d)):
        checkpoint = (read_resume(torch, args, name, config, report) if args.resume_dir
                      else torch.load(args.upstream / f"assets/pretrained_v2/f0{name}32k.pth",
                                      map_location="cpu", weights_only=True))
        model.load_state_dict(checkpoint["model"], strict=True)
        del checkpoint
        probe.tensor_summary(torch, model, torch.device("cpu"), True)
    del model
    report["strict_model_load"] = {"G": True, "D": True,
                                    "source": "resume" if args.resume_dir else "official-pretrained"}
    torch.cuda.reset_peak_memory_stats(0)
    update("training_real_voice")
    training(torch, args, config, dataset, collate, (net_g, net_d), report, update)
    del net_g, net_d
    gc.collect()
    torch.cuda.empty_cache()
    report["gpu_after_cleanup"] = {"allocated_bytes": torch.cuda.memory_allocated(0),
                                    "reserved_bytes": torch.cuda.memory_reserved(0)}
    report["status"] = "pilot_training_passed"
    update("complete")


def main():
    args = arguments()
    args.output_dir.mkdir(parents=False, exist_ok=False)
    started = time.perf_counter()
    report = {"schema": "own-voice-rvc-training/1", "scope": SCOPE, "status": "running",
              "stage": "initializing", "completed_steps": 0,
              "script_sha256": probe.sha256(Path(__file__).resolve()),
              "training_helpers_sha256": probe.sha256(HELPERS),
              "python": sys.version, "platform": platform.platform(),
              "requested": {"steps": args.steps, "max_training_seconds": args.max_seconds,
                            "threads": args.threads, "validate_only": args.validate_only,
                            "force_legacy_cuda": args.force_legacy_cuda},
              "limitations": ["Local own-voice pilot; no uploaded audio or telephone changes",
                              "Training losses do not prove speaker similarity or intelligibility",
                              "No phone latency or sustained-training acceptance",
                              "Cooperative deadline excludes preprocessing and checkpoint IO",
                              "External hard timeout required to preempt hung CUDA operations"]}
    with (args.output_dir / "training-report.json").open("x", encoding="utf-8") as stream:
        def update(stage):
            report["stage"] = stage
            report["total_elapsed_seconds"] = time.perf_counter() - started
            torch = sys.modules.get("torch")
            if torch is not None and torch.cuda.is_initialized():
                report["cuda_memory"] = {"peak_allocated_bytes": torch.cuda.max_memory_allocated(0),
                                          "peak_reserved_bytes": torch.cuda.max_memory_reserved(0),
                                          "allocated_bytes": torch.cuda.memory_allocated(0),
                                          "reserved_bytes": torch.cuda.memory_reserved(0)}
            stream.seek(0)
            json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.truncate()
            stream.flush()
            print(json.dumps({"stage": stage, "status": report["status"],
                              "completed_steps": report["completed_steps"]}), flush=True)
        update("initializing")
        try:
            run(args, report, update)
            return 0
        except BaseException as error:
            report["status"] = "failed"
            report["failed_stage"] = report["stage"]
            report["error"] = {"type": type(error).__name__, "message": str(error),
                               "traceback": traceback.format_exc(),
                               "out_of_memory": "out of memory" in str(error).lower()}
            update("failed")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
