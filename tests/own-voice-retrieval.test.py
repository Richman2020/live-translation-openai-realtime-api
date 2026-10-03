"""CPU-only synthetic-fixture checks; no personal recordings, models or network."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import own_voice_retrieval as retrieval


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="retrieval-test-", dir=REPO / ".runtime")
        self.directory = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.report_path = self.directory / "feature-report.json"
        self.filelist = self.directory / "train-filelist.txt"
        self.values = np.zeros((16, 768), dtype=np.float32)
        self.values[:, 0] = np.arange(1, 17)
        self.paths = [self.directory / "a.npy", self.directory / "b.npy"]
        self.models = {"hubert": "a" * 64, "rmvpe": "b" * 64}
        self.report = {"version": "own-voice-rvc-features/1", "status": "complete",
                       "hubertAudioNormalization": False,
                       "upstreamCommit": "upstream", "modelSha256": self.models,
                       "completedSegments": 2, "segments": []}
        self.rows = []
        for i, feature in enumerate(self.paths):
            np.save(feature, self.values[i * 8:(i + 1) * 8], allow_pickle=False)
            row = [str(self.directory / f"{i}.wav"), str(feature),
                   str(self.directory / f"{i}.f0.npy"), str(self.directory / f"{i}.f0f.npy"), "0"]
            self.rows.append(row)
            self.report["segments"].append({"key": str(i), "wav32k": row[0], "feature": row[1],
                "pitch": row[2], "pitchf": row[3], "featureShape": [8, 768],
                "sha256_feature": hashlib.sha256(feature.read_bytes()).hexdigest()})
        self.save()

    def save(self):
        self.filelist.write_text("\n".join("|".join(row) for row in self.rows) + "\n", encoding="utf-8")
        self.expected_hash = hashlib.sha256(self.filelist.read_bytes()).hexdigest()
        self.report["filelistSha256"] = self.expected_hash
        self.report_path.write_text(json.dumps(self.report), encoding="utf-8")

    def bank(self, **kwargs):
        return retrieval.VoiceFeatureBank(self.report_path, self.expected_hash, "upstream", self.models, **kwargs)

    def test_exact_eight_neighbors_use_official_inverse_score_squared(self):
        bank = self.bank()
        query = np.zeros((1, 768), dtype=np.float32)
        result = bank.retrieve(query)
        weights = 1 / np.arange(1, 9, dtype=np.float64) ** 4
        expected = (np.arange(1, 9) * weights).sum() / weights.sum()
        self.assertAlmostEqual(float(result[0, 0]), expected, places=6)
        np.testing.assert_array_equal(result[0, 1:], np.zeros(767))
        self.assertEqual(result.dtype, np.float32)
        self.assertEqual(bank.metadata["vectors"], 16)
        json.dumps(bank.metadata)

    def test_zero_distance_is_finite_and_exact(self):
        bank = self.bank()
        actual = bank.retrieve(self.values[:1])
        np.testing.assert_array_equal(actual, self.values[:1])

    def test_duplicate_zero_neighbors_and_multiple_query_chunks(self):
        data = np.tile(self.values[:1], (8, 1))
        np.save(self.paths[0], data)
        self.report["segments"][0]["sha256_feature"] = hashlib.sha256(self.paths[0].read_bytes()).hexdigest()
        self.save()
        query = np.tile(self.values[:1], (260, 1))
        np.testing.assert_array_equal(self.bank().retrieve(query), query)

    def test_feature_bytes_changed_since_report_rejected(self):
        self.paths[0].write_bytes(self.paths[0].read_bytes() + b"tampered")
        with self.assertRaisesRegex(ValueError, "hash"):
            self.bank()

    def test_invalid_array_dtype_dimensions_nonfinite_and_object_rejected(self):
        for value in (np.zeros((8, 768), dtype=np.float64), np.zeros((8, 767), dtype=np.float32),
                      np.full((8, 768), np.nan, dtype=np.float32), np.array([{}], dtype=object)):
            with self.subTest(dtype=value.dtype, shape=value.shape):
                np.save(self.paths[0], value)
                self.report["segments"][0]["sha256_feature"] = hashlib.sha256(self.paths[0].read_bytes()).hexdigest()
                self.save()
                with self.assertRaises(ValueError):
                    self.bank()

    def test_declared_shape_mismatch_rejected(self):
        self.report["segments"][0]["featureShape"] = [9, 768]
        self.save()
        with self.assertRaisesRegex(ValueError, "shape"):
            self.bank()

    def test_filelist_byte_hash_and_report_hash_binding_rejected(self):
        self.filelist.write_bytes(self.filelist.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "hash"):
            self.bank()
        self.save()
        self.expected_hash = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash"):
            self.bank()

    def test_filelist_order_and_duplicate_features_rejected(self):
        self.rows.reverse()
        self.save()
        with self.assertRaisesRegex(ValueError, "order/path"):
            self.bank()
        self.rows.reverse()
        self.rows[1] = self.rows[0].copy()
        self.report["segments"][1] = dict(self.report["segments"][0], key="different")
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate feature"):
            self.bank()

    def test_path_escape_and_extra_holdout_rejected(self):
        self.rows[0][1] = str(REPO / "outside-runtime.npy")
        self.report["segments"][0]["feature"] = self.rows[0][1]
        self.save()
        with self.assertRaisesRegex(ValueError, "runtime"):
            self.bank()
        self.rows.pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "counts"):
            self.bank()

    def test_report_and_query_bounds(self):
        with patch.object(retrieval, "MAX_FRAMES", 15):
            with self.assertRaisesRegex(ValueError, "frame limit"):
                self.bank()
        bank = self.bank()
        for value in (np.zeros((1, 768), dtype=np.float64), np.zeros((1, 767), dtype=np.float32),
                      np.full((1, 768), np.inf, dtype=np.float32)):
            with self.assertRaises(ValueError):
                bank.retrieve(value)
        self.assertEqual(bank.retrieve(np.empty((0, 768), dtype=np.float32)).shape, (0, 768))

    def test_report_upstream_models_and_status_binding(self):
        for name, value in (("upstreamCommit", "wrong"), ("modelSha256", {}),
                            ("status", "failed"), ("version", "wrong"),
                            ("hubertAudioNormalization", True)):
            original = self.report[name]
            self.report[name] = value
            self.save()
            with self.assertRaisesRegex(ValueError, "binding mismatch"):
                self.bank()
            self.report[name] = original

    def test_threads_restored_and_invalid_counts_rejected(self):
        old = retrieval.faiss.omp_get_max_threads()
        bank = self.bank(threads=1)
        bank.retrieve(self.values[:1])
        self.assertEqual(retrieval.faiss.omp_get_max_threads(), old)
        for count in (0, 9, True, 1.5):
            with self.assertRaises(ValueError):
                self.bank(threads=count)


if __name__ == "__main__":
    unittest.main()
