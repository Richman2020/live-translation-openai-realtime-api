"""CPU contract tests for the private RVC pilot; no GPU or personal recordings."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
from scipy.io import wavfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("own_voice_trainer", ROOT / "scripts/train-own-voice-rvc.py")
trainer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trainer)


class PrivateTrainingContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trainer-contract-", dir=ROOT / ".runtime")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name).resolve()
        self.wave = self.path / "synthetic.wav"
        self.phone = self.path / "phone.npy"
        self.pitch = self.path / "pitch.npy"
        self.pitchf = self.path / "pitchf.npy"
        clock = np.arange(64000) / 32000
        wavfile.write(self.wave, 32000, (np.sin(clock * 160 * 2 * np.pi) * .1).astype(np.float32))
        np.save(self.phone, np.zeros((99, 768), dtype=np.float32))
        np.save(self.pitch, np.full(200, 80, dtype=np.int64))
        np.save(self.pitchf, np.full(200, 160, dtype=np.float32))
        self.filelist = self.path / "filelist.txt"
        self.filelist.write_text("|".join(map(str, (self.wave, self.phone, self.pitch, self.pitchf))) + "|0\n", encoding="utf-8")

    def validate(self):
        report = {}
        trainer.validate_filelist(self.filelist, report)
        return report

    def test_valid_real_loader_contract(self):
        report = self.validate()
        self.assertEqual(report["dataset"]["segments"][0]["effective_frames"], 198)
        self.assertFalse(report["dataset"]["semantics_or_intelligibility_verified"])

    def test_rejects_pcm16_that_official_loader_would_not_normalize(self):
        wavfile.write(self.wave, 32000, np.ones(64000, dtype=np.int16))
        with self.assertRaisesRegex(ValueError, "float32"):
            self.validate()

    def test_rejects_encoder_capacity_overflow(self):
        wavfile.write(self.wave, 32000, np.ones(118401, dtype=np.float32) * .1)
        with self.assertRaisesRegex(ValueError, "3.7"):
            self.validate()

    def test_rejects_nonfinite_features_and_misaligned_pitch(self):
        phone = np.zeros((99, 768), dtype=np.float32)
        phone[0, 0] = np.nan
        np.save(self.phone, phone)
        with self.assertRaisesRegex(ValueError, "HuBERT"):
            self.validate()
        np.save(self.phone, np.zeros((99, 768), dtype=np.float32))
        np.save(self.pitch, np.full(197, 80, dtype=np.int64))
        with self.assertRaisesRegex(ValueError, "pitch length"):
            self.validate()

    def test_rejects_nonprivate_assets_and_duplicate_segments(self):
        with self.assertRaisesRegex(ValueError, "below"):
            trainer.private_path(ROOT / "accidental-public-voice.wav")
        line = self.filelist.read_text(encoding="utf-8")
        self.filelist.write_text(line + line, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.validate()

    def test_actual_official_cpu_loader_and_collate(self):
        import torch

        torch.set_num_threads(1)
        os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
        upstream = ROOT / ".runtime/rvc-hardware-lab/upstream"
        sys.path.insert(0, str(upstream))
        config = json.loads((upstream / "configs/v2/32k.json").read_text())
        report = self.validate()
        dataset, collate = trainer.load_dataset(torch, SimpleNamespace(filelist=self.filelist), config, report)
        self.assertEqual(len(dataset), 1)
        self.assertEqual(report["official_loader_validation"]["max_frames"], 198)
        self.assertEqual(tuple(collate([dataset[0]])[4].shape), (1, 513, 198))
        self.assertFalse(torch.cuda.is_initialized())

    def test_resume_rejects_changed_dataset_or_checkpoint(self):
        report = self.validate()
        config = {"data": "fixture"}
        prior = {"schema": "own-voice-rvc-training/1", "status": "pilot_training_passed",
                 "scope": trainer.SCOPE, "completed_steps": 2,
                 "upstream_commit": trainer.probe.UPSTREAM_COMMIT,
                 "configuration": {"values": config}, "dataset": report["dataset"], "checkpoints": {}}
        for name in ("G", "D"):
            path = self.path / f"{name}_training.pt"
            path.write_bytes(b"test-only-checkpoint-content")
            prior["checkpoints"][name] = {"sha256": trainer.probe.sha256(path)}
        (self.path / "training-report.json").write_text(json.dumps(prior))
        args = SimpleNamespace(resume_dir=self.path)
        trainer.validate_resume(args, config, report)
        self.assertTrue(report["resume"]["same_dataset_bytes_verified"])
        (self.path / "G_training.pt").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            trainer.validate_resume(args, config, report)
        report["dataset"]["sha256"] = "changed"
        with self.assertRaisesRegex(ValueError, "dataset differs"):
            trainer.validate_resume(args, config, report)

    def test_rejects_stale_finite_spectrogram_cache(self):
        import torch

        os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
        upstream = ROOT / ".runtime/rvc-hardware-lab/upstream"
        sys.path.insert(0, str(upstream))
        config = json.loads((upstream / "configs/v2/32k.json").read_text())
        torch.save(torch.zeros(513, 200), self.wave.with_suffix(".spec.pt"))
        with self.assertRaisesRegex(RuntimeError, "cache differs"):
            trainer.load_dataset(torch, SimpleNamespace(filelist=self.filelist), config, self.validate())

    def test_rejects_valid_but_truncated_spectrogram_prefix(self):
        import torch

        os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
        upstream = ROOT / ".runtime/rvc-hardware-lab/upstream"
        sys.path.insert(0, str(upstream))
        config = json.loads((upstream / "configs/v2/32k.json").read_text())
        args = SimpleNamespace(filelist=self.filelist)
        trainer.load_dataset(torch, args, config, self.validate())
        cache = self.wave.with_suffix(".spec.pt")
        original = torch.load(cache, map_location="cpu", weights_only=True)
        torch.save(original[:, :100].clone(), cache)
        with self.assertRaisesRegex(RuntimeError, "expected real-input frame count"):
            trainer.load_dataset(torch, args, config, self.validate())

    def test_checkpoint_roundtrip_and_no_overwrite(self):
        import torch

        path = self.path / "test-state.pt"
        payload = {"model": {"x": torch.ones(2)}, "sampler": {"order": [0], "position": 1},
                   "rng": torch.get_rng_state(), "completed_steps": 2}
        result = trainer.save_roundtrip(torch, payload, path)
        self.assertTrue(result["exact_cpu_roundtrip"])
        with self.assertRaises(FileExistsError):
            trainer.save_roundtrip(torch, payload, path)


if __name__ == "__main__":
    unittest.main()
