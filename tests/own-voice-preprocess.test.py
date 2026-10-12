"""Synthetic tests for bounded splitting, source isolation and lossless WAV storage."""

import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from scipy.io import wavfile


REPO = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("prepare_voice", REPO / "scripts/prepare-own-voice-rvc.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PreprocessTests(unittest.TestCase):
    def test_capacity_and_complete_tail_coverage(self):
        for frames in (1, 15999, 16000, 118399, 118400, 118401, 128000, 236800, 640000):
            ranges = MODULE.split_ranges(frames)
            self.assertEqual(ranges[0][0], 0)
            self.assertEqual(ranges[-1][1], frames)
            self.assertTrue(all(0 < end - start <= 118400 for start, end in ranges))
            for previous, current in zip(ranges, ranges[1:]):
                self.assertEqual(previous[1] - current[0], MODULE.OVERLAP)
        with self.assertRaises(ValueError):
            MODULE.split_ranges(0)

    def test_normalization_matches_upstream_formula(self):
        original = np.array([-.8, .2, .6, 0], dtype=np.float64)
        expected = (original / .8 * .675 + .25 * original).astype(np.float32)
        np.testing.assert_array_equal(MODULE.normalized(original), expected)

    def test_zero_nonfinite_and_high_peaks_rejected(self):
        for samples in ([0., 0.], [float("nan"), .1], [float("inf"), .1], [2.6, .1], [1.4, .1]):
            with self.assertRaises(ValueError):
                MODULE.normalized(np.array(samples))

    def test_float_wave_roundtrip_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory(dir=REPO / ".runtime") as directory:
            target = Path(directory) / "test.wav"
            values = np.array([-.875, .325, .0123], dtype=np.float32)
            first = MODULE.write_wav_new(target, 32000, values)
            with self.assertRaises(FileExistsError):
                MODULE.write_wav_new(target, 32000, values * 0)
            self.assertEqual(MODULE.sha256(target), first)

    def test_output_bounds_and_raw_separation(self):
        with tempfile.TemporaryDirectory(dir=REPO / ".runtime") as directory:
            root = Path(directory)
            raw = root / "raw"
            raw.mkdir()
            for target in (raw, raw / "prepared", root, REPO / "escaped-prepared"):
                with self.assertRaises(ValueError):
                    MODULE.checked_paths(raw, target, REPO / ".runtime")
            self.assertEqual(MODULE.checked_paths(raw, root / "valid", REPO / ".runtime")[1], root / "valid")

    def test_real_slicer_synthetic_manifest_heldout_isolation_and_immutability(self):
        with tempfile.TemporaryDirectory(dir=REPO / ".runtime") as directory:
            root, rate = Path(directory), 48000
            raw, output = root / "raw", root / "prepared"
            raw.mkdir()
            clips = []
            before = {}
            for clip_id, seconds in ((1, 1), (2, 4.01), (11, 1)):
                length = round(rate * seconds)
                pcm = (np.sin(np.arange(length) / rate * 2 * np.pi * (100 + clip_id * 20)) * 12000).astype(np.int16)
                filename = f"own-voice-synthetic-{clip_id}.wav"
                wavfile.write(raw / filename, rate, pcm)
                before[filename] = MODULE.sha256(raw / filename)
                values = pcm.astype(np.float64) / 32768
                clips.append({"id": clip_id, "trial": clip_id == 1, "filename": filename,
                              "format": "PCM16LE", "channels": 1, "sampleRate": rate,
                              "frames": length, "durationSeconds": length / rate,
                              "rms": float(np.sqrt(np.mean(values ** 2))), "peak": float(np.abs(values).max()),
                              "clippingSampleCount": 0})
            manifest = raw / "manifest.json"
            manifest.write_text(json.dumps({"version": "own-voice-recordings/1", "clips": clips}), encoding="utf-8")
            args = argparse.Namespace(source_dir=raw, output_dir=output, manifest=manifest, holdout_id=11,
                                      upstream=REPO / ".runtime/rvc-hardware-lab/upstream")
            result = MODULE.prepare(args)
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["summary"]["trainingSourceCount"], 1)
            self.assertEqual(result["summary"]["heldoutSourceCount"], 2)
            self.assertEqual({entry["sourceClipId"] for entry in result["segments"]}, {2})
            self.assertEqual(result["summary"]["segmentCount"], 2)
            self.assertTrue(all(s["frames32k"] <= 118400 for s in result["segments"]))
            self.assertTrue(all(s["frames16k"] == (s["frames32k"] + 1) // 2 for s in result["segments"]))
            for filename, expected in before.items():
                self.assertEqual(MODULE.sha256(raw / filename), expected)
            with self.assertRaises(ValueError):
                MODULE.prepare(args)


if __name__ == "__main__":
    unittest.main(verbosity=2)
