"""Bounded official RVC GAN training-compute probe using synthetic, nonpersonal data.

This exercises full pretrained G/D models, losses, gradients and AdamW state. It
does not extract speech features, train a person's voice, export an inference
voice, or touch the phone application. Results are SYNTHETIC_TRAINING_COMPUTE_ONLY.
--max-seconds bounds the training loop cooperatively between GPU operations;
setup and optional CPU checkpoint verification are timed separately. A hard
process deadline must be imposed externally because CUDA calls are not preempted.
"""

import argparse
import gc
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


SCOPE = "SYNTHETIC_TRAINING_COMPUTE_ONLY"
UPSTREAM_COMMIT = "81eed5e8f68b6bed1789f682fe78cdd324495afc"
MODEL_HASHES = {
    "G": "2332611297b8d88c7436de8f17ef5f07a2119353e962cd93cda5806d59a1133d",
    "D": "bd7134e7793674c85474d5145d2d982e3c5d8124fc7bb6c20f710ed65808fa8a",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path,
                        help="New JSON report; existing files are never overwritten")
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--frames", type=int, default=300,
                        help="Whole encoder input at 100 frames/s; decoder always uses 40")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-seconds", type=float, default=120,
                        help="Cooperative training-loop deadline, excluding setup/checkpoint IO")
    parser.add_argument("--force-legacy-cuda", action="store_true",
                        help="Explicit process-local FP32 bypass if upstream rejects this GPU")
    parser.add_argument("--save-checkpoint", type=Path,
                        help="New directory for synthetic training state, CPU save/reload validation")
    args = parser.parse_args()
    if not 2 <= args.steps <= 100:
        parser.error("steps must be in [2,100] to exercise initialized AdamW state")
    if not 40 <= args.frames <= 900:
        parser.error("frames must be in [40,900]")
    if not 1 <= args.threads <= 32:
        parser.error("threads must be in [1,32]")
    if not math.isfinite(args.max_seconds) or args.max_seconds <= 0:
        parser.error("max-seconds must be positive and finite")
    for field in ("upstream", "output", "save_checkpoint"):
        value = getattr(args, field)
        if value is not None:
            setattr(args, field, value.resolve())
    return args


def tensor_summary(torch, model, device, check_finite=False):
    count = 0
    for name, value in list(model.named_parameters()) + list(model.named_buffers()):
        if value.device != device:
            raise RuntimeError(f"Unexpected tensor device for {name}: {value.device}")
        if value.is_floating_point() and value.dtype != torch.float32:
            raise RuntimeError(f"Unexpected tensor dtype for {name}: {value.dtype}")
        if check_finite and not bool(torch.isfinite(value).all().item()):
            raise RuntimeError(f"Nonfinite model tensor: {name}")
    for parameter in model.parameters():
        if not parameter.requires_grad:
            raise RuntimeError("A training parameter was unexpectedly frozen")
        count += parameter.numel()
    return {"parameter_count": count, "device": str(device), "floating_dtype": "torch.float32"}


def gradient_summary(torch, model, commons):
    tensors, elements = 0, 0
    for name, parameter in model.named_parameters():
        if parameter.grad is None:
            raise RuntimeError(f"Missing training gradient: {name}")
        if not bool(torch.isfinite(parameter.grad).all().item()):
            raise RuntimeError(f"Nonfinite training gradient: {name}")
        tensors += 1
        elements += parameter.grad.numel()
    norm = float(commons.clip_grad_value_(model.parameters(), None))
    if not math.isfinite(norm) or norm <= 0:
        raise RuntimeError(f"Invalid gradient norm: {norm}")
    return {"tensors": tensors, "elements": elements, "norm": norm, "all_finite": True}


def parameter_samples(model):
    # Small CPU copies prove each optimizer actually changes its model; they are
    # not an assertion that every individual parameter must change on every step.
    return {name: value.detach().flatten()[:64].cpu().clone()
            for name, value in list(model.named_parameters())[:8]}


def changed_samples(torch, before, model):
    after = parameter_samples(model)
    changed = [name for name in before if not torch.equal(before[name], after[name])]
    if not changed:
        raise RuntimeError("Optimizer step did not change any sampled model parameter")
    if not all(bool(torch.isfinite(value).all().item()) for value in after.values()):
        raise RuntimeError("Optimizer step produced nonfinite sampled parameters")
    return changed


def optimizer_summary(torch, optimizer, expected_step):
    count, elements = 0, 0
    for group in optimizer.param_groups:
        for parameter in group["params"]:
            state = optimizer.state.get(parameter)
            if not state or not {"step", "exp_avg", "exp_avg_sq"} <= state.keys():
                raise RuntimeError("Incomplete AdamW state")
            if float(state["step"].item()) != expected_step:
                raise RuntimeError("Unexpected AdamW step counter")
            for name in ("exp_avg", "exp_avg_sq"):
                value = state[name]
                if (value.shape != parameter.shape or value.device != parameter.device
                        or value.dtype != torch.float32):
                    raise RuntimeError(f"AdamW {name} has unexpected shape/device/dtype")
                if not bool(torch.isfinite(value).all().item()):
                    raise RuntimeError(f"Nonfinite AdamW {name}")
            count += 1
            elements += parameter.numel() * 2
    return {"parameter_states": count, "moment_elements": elements, "step": expected_step,
            "moment_device": "cuda:0", "moment_dtype": "torch.float32", "all_finite": True}


def cpu_tree(torch, value):
    if torch.is_tensor(value):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {key: cpu_tree(torch, item) for key, item in value.items()}
    if isinstance(value, list):
        return [cpu_tree(torch, item) for item in value]
    if isinstance(value, tuple):
        return tuple(cpu_tree(torch, item) for item in value)
    return value


def tree_digest(torch, value):
    digest = hashlib.sha256()

    def visit(item):
        if torch.is_tensor(item):
            if item.device.type != "cpu":
                raise RuntimeError("Checkpoint verification must occur on CPU")
            digest.update(str((str(item.dtype), list(item.shape))).encode())
            digest.update(item.contiguous().numpy().tobytes())
        elif isinstance(item, dict):
            digest.update(b"dict")
            for key in sorted(item, key=lambda entry: (type(entry).__name__, str(entry))):
                visit(key)
                visit(item[key])
        elif isinstance(item, (list, tuple)):
            digest.update(type(item).__name__.encode())
            for child in item:
                visit(child)
        else:
            digest.update(json.dumps(item, sort_keys=True, allow_nan=False).encode())
        digest.update(b"\0")

    visit(value)
    return digest.hexdigest()


def training(torch, args, config, models, report, update):
    from infer.module import commons
    from train.losses import discriminator_loss, feature_loss, generator_loss, kl_loss
    from train.mel_processing import spectrogram_torch, spec_to_mel_torch, mel_spectrogram_torch
    from torch.nn import functional as F

    data, train = config["data"], config["train"]
    device = torch.device("cuda:0")
    net_g, net_d = models
    net_g.to(device).train()
    net_d.to(device).train()
    report["models"] = {"G": tensor_summary(torch, net_g, device, True),
                        "D": tensor_summary(torch, net_d, device, True)}
    report["models"]["G"]["posterior_encoder_present"] = hasattr(net_g, "enc_q")
    report["models"]["D"]["discriminator_branches"] = len(net_d.discriminators)
    if not hasattr(net_g, "enc_q") or len(net_d.discriminators) != 9:
        raise RuntimeError("Incomplete official v2 training architecture")
    optim_g = torch.optim.AdamW(net_g.parameters(), train["learning_rate"],
                                betas=train["betas"], eps=train["eps"])
    optim_d = torch.optim.AdamW(net_d.parameters(), train["learning_rate"],
                                betas=train["betas"], eps=train["eps"])
    report["optimizer"] = {"name": "AdamW", "learning_rate": train["learning_rate"],
                           "betas": train["betas"], "eps": train["eps"],
                           "weight_decay": 0.01, "foreach": None, "fused": None}
    # A repeatable tensor workload, not a real HuBERT/F0 feature-extraction pipeline.
    sample_count = args.frames * data["hop_length"]
    clock = torch.arange(sample_count, device=device, dtype=torch.float32) / data["sampling_rate"]
    f0_hz = 160.0
    wave_full = (0.10 * torch.sin(2 * math.pi * f0_hz * clock)
                 + 0.035 * torch.sin(2 * math.pi * 2 * f0_hz * clock))
    wave_full = (wave_full * (0.8 + 0.2 * torch.sin(2 * math.pi * 2 * clock))).view(1, 1, -1)
    spec = spectrogram_torch(wave_full.squeeze(1), data["filter_length"],
                             data["sampling_rate"], data["hop_length"], data["win_length"])
    if spec.shape != (1, data["filter_length"] // 2 + 1, args.frames):
        raise RuntimeError(f"Unexpected synthetic spectrogram shape: {list(spec.shape)}")
    phone = torch.randn(1, args.frames, 768, device=device, dtype=torch.float32) * 0.1
    pitchf = torch.full((1, args.frames), f0_hz, device=device, dtype=torch.float32)
    mel_min, mel_max = 1127 * math.log(1 + 50 / 700), 1127 * math.log(1 + 1100 / 700)
    pitch_bin = round((1127 * math.log(1 + f0_hz / 700) - mel_min) * 254 / (mel_max - mel_min) + 1)
    pitch = torch.full((1, args.frames), pitch_bin, device=device, dtype=torch.long)
    lengths = torch.tensor([args.frames], device=device, dtype=torch.long)
    sid = torch.zeros(1, device=device, dtype=torch.long)
    report["synthetic_inputs"] = {
        "kind": "generated harmonic tones and seeded random HuBERT-shaped tensors",
        "actual_hubert_extraction": False, "actual_f0_extraction": False,
        "personal_audio_used": False, "batch_size": 1, "encoder_frames": args.frames,
        "encoder_seconds": sample_count / data["sampling_rate"],
        "decoder_segment_samples": train["segment_size"], "decoder_segment_seconds": 0.4,
        "phone_shape": list(phone.shape), "spec_shape": list(spec.shape),
        "wave_shape": list(wave_full.shape), "pitch_hz": f0_hz, "pitch_bin": pitch_bin,
    }
    segment_frames = train["segment_size"] // data["hop_length"]
    report["training_steps"] = []
    torch.cuda.synchronize(device)
    started = time.perf_counter()

    def deadline(stage):
        elapsed = time.perf_counter() - started
        report["training_elapsed_seconds"] = elapsed
        if elapsed >= args.max_seconds:
            raise TimeoutError(f"Training deadline reached before {stage}; completed {len(report['training_steps'])} steps")

    for index in range(args.steps):
        deadline("generator forward")
        update(f"step_{index + 1}_generator_forward")
        torch.cuda.synchronize(device)
        step_start = time.perf_counter()
        before_g, before_d = parameter_samples(net_g), parameter_samples(net_d)
        (y_hat, ids_slice, x_mask, z_mask,
         (z, z_p, m_p, logs_p, m_q, logs_q)) = net_g(phone, lengths, pitch, pitchf, spec, lengths, sid)
        mel = spec_to_mel_torch(spec, data["filter_length"], data["n_mel_channels"],
                                data["sampling_rate"], data["mel_fmin"], data["mel_fmax"])
        y_mel = commons.slice_segments(mel, ids_slice, segment_frames)
        y_hat_mel = mel_spectrogram_torch(
            y_hat.float().squeeze(1), data["filter_length"], data["n_mel_channels"],
            data["sampling_rate"], data["hop_length"], data["win_length"],
            data["mel_fmin"], data["mel_fmax"])
        wave = commons.slice_segments(wave_full, ids_slice * data["hop_length"], train["segment_size"])
        if y_hat.shape != wave.shape or y_mel.shape != y_hat_mel.shape:
            raise RuntimeError("Generated waveform or mel shape differs from its target")
        deadline("discriminator forward/backward")
        update(f"step_{index + 1}_discriminator_backward")
        y_d_hat_r, y_d_hat_g, _, _ = net_d(wave, y_hat.detach())
        loss_disc, losses_disc_r, losses_disc_g = discriminator_loss(y_d_hat_r, y_d_hat_g)
        if not bool(torch.isfinite(loss_disc).item()):
            raise RuntimeError("Nonfinite discriminator loss")
        optim_d.zero_grad()
        loss_disc.backward()
        gradients_d = gradient_summary(torch, net_d, commons)
        deadline("discriminator optimizer step")
        update(f"step_{index + 1}_discriminator_optimizer")
        optim_d.step()
        changed_d = changed_samples(torch, before_d, net_d)
        state_d = optimizer_summary(torch, optim_d, index + 1)
        deadline("generator loss/backward")
        update(f"step_{index + 1}_generator_backward")
        y_d_hat_r, y_d_hat_g, fmap_r, fmap_g = net_d(wave, y_hat)
        loss_mel = F.l1_loss(y_mel, y_hat_mel) * train["c_mel"]
        loss_kl = kl_loss(z_p, logs_q, m_p, logs_p, z_mask) * train["c_kl"]
        loss_fm = feature_loss(fmap_r, fmap_g)
        loss_gen, losses_gen = generator_loss(y_d_hat_g)
        loss_gen_all = loss_gen + loss_fm + loss_mel + loss_kl
        losses = {"discriminator": loss_disc, "generator_adversarial": loss_gen,
                  "feature_matching": loss_fm, "mel_weighted": loss_mel,
                  "kl_weighted": loss_kl, "generator_total": loss_gen_all}
        if not all(bool(torch.isfinite(value).item()) for value in losses.values()):
            raise RuntimeError("Nonfinite generator loss")
        optim_g.zero_grad()
        loss_gen_all.backward()
        gradients_g = gradient_summary(torch, net_g, commons)
        deadline("generator optimizer step")
        update(f"step_{index + 1}_generator_optimizer")
        optim_g.step()
        changed_g = changed_samples(torch, before_g, net_g)
        state_g = optimizer_summary(torch, optim_g, index + 1)
        torch.cuda.synchronize(device)
        elapsed = time.perf_counter() - step_start
        report["training_steps"].append({
            "step": index + 1, "seconds_including_validation": elapsed,
            "losses": {name: float(value.detach().item()) for name, value in losses.items()},
            "gradients": {"G": gradients_g, "D": gradients_d},
            "changed_parameter_samples": {"G": changed_g, "D": changed_d},
            "adamw_state": {"G": state_g, "D": state_d},
            "cuda_allocated_bytes": torch.cuda.memory_allocated(device),
            "cuda_reserved_bytes": torch.cuda.memory_reserved(device),
            "cuda_peak_allocated_bytes": torch.cuda.max_memory_allocated(device),
            "cuda_peak_reserved_bytes": torch.cuda.max_memory_reserved(device),
        })
        report["completed_steps"] = index + 1
        report["training_elapsed_seconds"] = time.perf_counter() - started
        update(f"step_{index + 1}_complete")
        deadline("next step or completed-run validation")

    tensor_summary(torch, net_g, device, True)
    tensor_summary(torch, net_d, device, True)
    report["all_final_parameters_finite"] = True
    report["training_loop_seconds_including_validation"] = time.perf_counter() - started
    samples = [step["seconds_including_validation"] for step in report["training_steps"]]
    report["step_timing"] = {"first_seconds": samples[0], "mean_seconds": statistics.mean(samples),
                             "subsequent_mean_seconds": statistics.mean(samples[1:]),
                             "max_seconds": max(samples), "includes_finite_checks_and_io": True}
    report["initialized_adamw_subsequent_step_verified"] = len(samples) >= 2
    update("training_complete_releasing_gpu")
    payloads = None
    if args.save_checkpoint:
        net_g.zero_grad(set_to_none=True)
        net_d.zero_grad(set_to_none=True)
        payloads = {}
        for name, model, optimizer in (("G", net_g, optim_g), ("D", net_d, optim_d)):
            payloads[name] = {"scope": SCOPE, "model": model.cpu().state_dict(),
                              "optimizer": cpu_tree(torch, optimizer.state_dict()),
                              "completed_steps": len(samples), "config": config}
    return payloads


def run(args, report, update):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["RVC_CUDA_GRAPH"] = "0"
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    report["upstream_commit"] = subprocess.check_output(
        ["git", "-C", str(args.upstream), "rev-parse", "HEAD"], text=True).strip()
    report["upstream_tracked_status"] = subprocess.check_output(
        ["git", "-C", str(args.upstream), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    if report["upstream_commit"] != UPSTREAM_COMMIT or report["upstream_tracked_status"]:
        raise RuntimeError("Expected pinned official upstream commit with clean tracked files")
    config_path = args.upstream / "configs/v2/32k.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    report["configuration"] = {"relative_path": "configs/v2/32k.json",
                               "sha256": sha256(config_path), "values": config}
    if config["train"]["segment_size"] != 12800 or config["data"]["hop_length"] != 320:
        raise RuntimeError("Unexpected official 32k segment/hop configuration")
    report["model_sources"] = {}
    for name, expected in MODEL_HASHES.items():
        path = args.upstream / f"assets/pretrained_v2/f0{name}32k.pth"
        actual = sha256(path)
        report["model_sources"][name] = {"filename": path.name, "sha256": actual}
        if actual != expected:
            raise RuntimeError(f"Unexpected official {name} checksum")
    if args.save_checkpoint:
        args.save_checkpoint.mkdir(exist_ok=False)
    update("verified_sources_importing_torch")
    sys.path.insert(0, str(args.upstream))
    import torch

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.set_default_dtype(torch.float32)
    torch.manual_seed(config["train"]["seed"])
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    report["torch"] = {"version": str(torch.__version__), "cuda_runtime": torch.version.cuda}
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; CPU fallback is forbidden")
    torch.cuda.set_device(0)
    report["gpu"] = {"name": torch.cuda.get_device_name(0),
                     "compute_capability": list(torch.cuda.get_device_capability(0)),
                     "total_bytes": torch.cuda.get_device_properties(0).total_memory,
                     "free_bytes_before_models": torch.cuda.mem_get_info(0)[0],
                     "compiled_architectures": torch.cuda.get_arch_list()}
    import configs.config as upstream_config

    try:
        default_dtype = upstream_config.get_training_dtype()
        report["upstream_training_policy"] = {"accepted": True, "dtype": str(default_dtype)}
    except RuntimeError as error:
        report["upstream_training_policy"] = {"accepted": False, "error": str(error)}
        if not args.force_legacy_cuda:
            raise RuntimeError("Official training policy rejects this GPU; explicit --force-legacy-cuda required") from error
    report["precision"] = {"actual": "torch.float32", "amp": False, "grad_scaler": False,
                           "legacy_policy_bypass_applied": not report["upstream_training_policy"]["accepted"],
                           "upstream_files_changed": False,
                           "note": "Direct official model calls use explicit CUDA FP32 in this process only"}
    from infer.module.models import SynthesizerTrnMs768NSFsid, MultiPeriodDiscriminatorV2

    update("loading_full_pretrained_models_on_cpu")
    data, train = config["data"], config["train"]
    net_g = SynthesizerTrnMs768NSFsid(data["filter_length"] // 2 + 1,
                                    train["segment_size"] // data["hop_length"],
                                    **config["model"], is_half=False, sr=data["sampling_rate"])
    net_d = MultiPeriodDiscriminatorV2(config["model"]["use_spectral_norm"])
    for name, model in (("G", net_g), ("D", net_d)):
        checkpoint = torch.load(args.upstream / f"assets/pretrained_v2/f0{name}32k.pth",
                                map_location="cpu", weights_only=True)
        model.load_state_dict(checkpoint["model"], strict=True)
        del checkpoint
        tensor_summary(torch, model, torch.device("cpu"), True)
    del model
    report["strict_pretrained_load"] = {"G": True, "D": True}
    report["setup_elapsed_seconds"] = time.perf_counter() - report.pop("_started")
    torch.cuda.reset_peak_memory_stats(0)
    update("moving_full_models_to_cuda")
    payloads = training(torch, args, config, (net_g, net_d), report, update)
    del net_g, net_d
    gc.collect()
    torch.cuda.empty_cache()
    report["gpu_released_before_checkpoint_io"] = {"allocated_bytes": torch.cuda.memory_allocated(0),
                                                  "reserved_bytes": torch.cuda.memory_reserved(0)}
    if payloads is not None:
        update("saving_and_reloading_synthetic_training_state_on_cpu")
        checkpoint_start = time.perf_counter()
        report["checkpoint_validation"] = {}
        for name in ("G", "D"):
            payload = payloads.pop(name)
            expected = tree_digest(torch, payload)
            path = args.save_checkpoint / f"{name}_synthetic_training_probe.pt"
            with path.open("xb") as stream:
                torch.save(payload, stream)
            del payload
            gc.collect()
            restored = torch.load(path, map_location="cpu", weights_only=True)
            actual = tree_digest(torch, restored)
            if actual != expected:
                raise RuntimeError(f"Saved {name} training checkpoint content did not roundtrip exactly")
            del restored
            report["checkpoint_validation"][name] = {
                "filename": str(path), "sha256": sha256(path),
                "contents_sha256": actual, "exact_cpu_tensor_roundtrip": True,
                "inference_voice_export": False,
            }
        report["checkpoint_elapsed_seconds"] = time.perf_counter() - checkpoint_start
    report["status"] = "passed"
    update("complete")


def main():
    args = arguments()
    started = time.perf_counter()
    report = {"schema": "rvc-synthetic-training-compute/1.0", "scope": SCOPE,
              "status": "running", "completed_steps": 0, "stage": "initializing",
              "script_sha256": sha256(Path(__file__).resolve()),
              "python": sys.version, "platform": platform.platform(),
              "requested": {"steps": args.steps, "frames": args.frames, "threads": args.threads,
                            "max_training_seconds": args.max_seconds,
                            "force_legacy_cuda": args.force_legacy_cuda,
                            "save_checkpoint": str(args.save_checkpoint) if args.save_checkpoint else None},
              "limitations": ["Synthetic data only; no personal voice training or quality evidence",
                              "No dataset preprocessing, actual HuBERT/F0 extraction or training-loader validation",
                              "No official trainer CLI, sustained convergence, phone integration or latency acceptance",
                              "Deadline checked between GPU operations; hard process limit must be external"],
              "_started": started}
    # Exclusive reservation happens before model imports and allocation. Every
    # stage replaces only this newly created report so interrupted work stays visible.
    with args.output.open("x", encoding="utf-8") as stream:
        def update(stage):
            report["stage"] = stage
            report["total_elapsed_seconds"] = time.perf_counter() - started
            torch = sys.modules.get("torch")
            if torch is not None and torch.cuda.is_initialized():
                try:
                    report["cuda_memory"] = {
                        "peak_allocated_bytes": torch.cuda.max_memory_allocated(0),
                        "peak_reserved_bytes": torch.cuda.max_memory_reserved(0),
                        "allocated_bytes": torch.cuda.memory_allocated(0),
                        "reserved_bytes": torch.cuda.memory_reserved(0),
                    }
                except Exception as error:
                    report["cuda_memory_query_error"] = str(error)
            serializable = {key: value for key, value in report.items() if not key.startswith("_")}
            stream.seek(0)
            json.dump(serializable, stream, indent=2, allow_nan=False)
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
