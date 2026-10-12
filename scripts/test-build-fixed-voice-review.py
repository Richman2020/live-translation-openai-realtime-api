"""Small synthetic fixtures verify publication validation; no models are loaded."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fixed_voice_review", REPO / "scripts/build-fixed-voice-review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def wav_bytes(frames, floating, amplitude=1):
    bits, encoding = (32, 3) if floating else (16, 1)
    data = struct.pack("<" + ("f" if floating else "h") * frames, *([(.125 if floating else 4096) * amplitude] * frames))
    fmt = struct.pack("<HHIIHH", encoding, 1, 8000, 8000 * bits // 8, bits // 8, bits)
    contents = b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(contents)) + contents


def outputs(directory, prefix, frames, amplitude=1):
    records = []
    for role, extension, raw in (("native", "wav", wav_bytes(frames, True, amplitude)),
                                 ("phone-8k", "wav", wav_bytes(frames, False, amplitude)),
                                 ("phone-8k", "ulaw", bytes([0xaf]) * frames)):
        filename = prefix + "-" + role + "." + extension
        (directory / filename).write_bytes(raw)
        record = {"filename": filename, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                  "frames": frames, "sample_rate": 8000, "channels": 1, "duration_seconds": frames / 8000}
        if extension == "wav":
            record["subtype"] = "FLOAT" if role == "native" else "PCM_16"
        else:
            record["encoding"] = "G711_MULAW_RAW"
        records.append(record)
    return {"files": records}


def fixture_reports(root):
    fixture_path = REPO / "fixtures/fixed-voice-long-form.v1.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8-sig"))
    result = {}
    for engine in ("nano", "pocket"):
        directory = root / engine
        directory.mkdir()
        amplitude = 1 if engine == "nano" else 2
        canonical = outputs(directory, "synthetic", 960, amplitude)
        replay = outputs(directory, "synthetic-replay", 1360, amplitude)
        report = {"schema": "fixed-voice-long-form-benchmark/1", "status": "completed_for_listening",
                  "engine": engine, "reference": {"sha256": review.PUBLIC_WAV_SHA},
                  "network": {"blocked_attempts": 0, "python_socket_guard_active": True},
                  "fixtures_sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(), "fixtures": fixtures,
                  "sample_rate": 8000, "runs": []}
        if engine == "nano":
            report["generation_api"] = "SENTENCE_PIPELINE_WHOLE_FILE_NOT_NATIVE_STREAMING"
            report["conditioning"] = {"mode": "PUBLIC_FIXED_VOICE_WAV_CONDITIONING"}
        else:
            report["generation_api"] = "NATIVE_GENERATE_AUDIO_STREAM_WITH_EXPLICIT_SENTENCE_BOUNDARIES"
            report["conditioning"] = {"mode": "PUBLIC_PRESET_WITHOUT_VOICE_CLONING",
                                      "voice_state": {"sha256": review.PUBLIC_STATE_SHA},
                                      "reference_wav_used_for_conditioning": False}
        for repeat in range(4):
            for passage in fixtures["passages"][:1] if repeat == 0 else fixtures["passages"]:
                sentences = passage["sentences"][:1] if repeat == 0 else passage["sentences"]
                total = len(sentences) * .01
                run = {"id": f"run-{repeat}-{passage['id']}", "passage_id": passage["id"], "repeat": repeat,
                       "warmup_excluded": repeat == 0, "status": "generated_for_listening",
                       "sentences": [{"text": text, "generation_seconds": .01} for text in sentences],
                       "sum_sentence_generation_seconds": total, "passage_elapsed_seconds": .12,
                       "generation_rtf": total / .12, "outputs": canonical, "ideal_fifo_replay_outputs": replay,
                       "timeline": {"first_chunk_seconds": .05, "first_voiced_data_available_seconds": .05,
                                    "ideal_fifo_first_voiced_seconds": .05,
                                    "buffer_starvation_seconds": 0, "ideal_fifo_complete_seconds": .17},
                       "chunks": [{"frames": 960 // len(sentences), "available_at_seconds": .05 + i * .01}
                                  for i in range(len(sentences))]}
                report["runs"].append(run)
        path = directory / "report.private.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        result[engine] = path
    return result


class ReviewValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fixed-review-test-", dir=review.PRIVATE_ROOT)
        self.root = Path(self.temporary.name).resolve()
        self.assertTrue(self.root.is_relative_to(review.PRIVATE_ROOT))
        self.paths = fixture_reports(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def test_valid_fixture_builds_relative_assets_without_private_paths_or_autoplay(self):
        output = self.root / "review"
        manifest = review.build(self.paths["nano"], self.paths["pocket"], output)
        self.assertEqual(len(manifest["files"]), 72)
        for record in manifest["files"]:
            raw = (output / record["filename"]).read_bytes()
            self.assertEqual(len(raw), record["bytes"])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), record["sha256"])
        page = (output / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("autoplay", page)
        self.assertNotIn(str(self.root), page)
        self.assertNotIn(str(self.root), (output / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(page.count('<audio '), 36)
        self.assertIn("固定英文稿", page)
        self.assertIn("录制时 19 岁", page)
        self.assertIn('id="match-volume" type="checkbox" checked', page)
        self.assertTrue(all(0 < row["playback_gain"] <= 1 for row in manifest["files"] if row["format"] != "ulaw"))
        for row in manifest["files"]:
            if row["format"] != "ulaw":
                self.assertEqual(row["playback_gain"], 1 if row["engine"] == "nano" else .5)
        with self.assertRaises(ValueError):
            review.build(self.paths["nano"], self.paths["pocket"], output)

    def test_missing_output_is_rejected_before_public_folder_creation(self):
        (self.paths["pocket"].parent / "synthetic-phone-8k.wav").unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            review.build(self.paths["nano"], self.paths["pocket"], self.root / "review")
        self.assertFalse((self.root / "review").exists())

    def test_same_size_tampering_is_rejected(self):
        path = self.paths["nano"].parent / "synthetic-native.wav"
        data = bytearray(path.read_bytes())
        data[-1] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            review.load_benchmark(self.paths["nano"], "nano")

    def test_personal_reference_or_insufficient_repeats_is_rejected(self):
        path = self.paths["nano"]
        original = json.loads(path.read_text(encoding="utf-8"))
        changed = copy.deepcopy(original)
        changed["reference"]["sha256"] = "0" * 64
        path.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "public Michael"):
            review.load_benchmark(path, "nano")
        changed = copy.deepcopy(original)
        changed["runs"] = [row for row in changed["runs"] if row["repeat"] < 3]
        path.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "at least three"):
            review.load_benchmark(path, "nano")


if __name__ == "__main__":
    unittest.main()
