"""CPU-only regression checks for private voice conversion and review contracts.

Run with the isolated Python 3.12 environment:
  .runtime/rvc-hardware-lab/venv/Scripts/python.exe tests/own-voice-sample.test.py

Uses synthetic temporary fixtures and Python's independent audioop G.711 oracle.
No models, CUDA, real recordings, training, audio playback, or network requests.
"""

import contextlib
import hashlib
from html.parser import HTMLParser
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import wave

import numpy as np

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import audioop  # Python 3.12 stdlib reference, independent of our codec.


REPO = Path(__file__).resolve().parent.parent


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, REPO / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sample = load_script("own_voice_sample_under_test", "convert-own-voice-sample.py")
review = load_script("own_voice_review_under_test", "build-own-voice-review.py")


class G711Tests(unittest.TestCase):
    def test_all_pcm16_codes_match_stdlib_reference(self):
        pcm = np.arange(-32768, 32768, dtype=np.int16)
        expected = np.frombuffer(audioop.lin2ulaw(pcm.astype("<i2").tobytes(), 2), dtype=np.uint8)
        actual = sample.pcm16_to_mulaw(pcm)
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.dtype, np.dtype("uint8"))

    def test_all_mulaw_codes_match_stdlib_reference(self):
        encoded = np.arange(256, dtype=np.uint8)
        expected = np.frombuffer(audioop.ulaw2lin(encoded.tobytes(), 2), dtype="<i2")
        actual = sample.mulaw_to_pcm16(encoded)
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.dtype, np.dtype("int16"))


class PitchTests(unittest.TestCase):
    def test_preserves_unvoiced_frames_while_shifting_voiced_pitch(self):
        raw = np.array([0, 100, 200, 0], dtype=np.float32)
        coarse, shifted, voiced = sample.pitch_inputs(raw, 12, "preserve-unvoiced")
        np.testing.assert_array_equal(shifted, [0, 200, 400, 0])
        np.testing.assert_array_equal(voiced, [False, True, True, False])
        np.testing.assert_array_equal(raw, [0, 100, 200, 0])
        self.assertEqual(coarse[0], 1)
        self.assertEqual(coarse[-1], 1)

    def test_explicit_interpolation_fills_gaps_but_keeps_original_voicing_mask(self):
        _, shifted, voiced = sample.pitch_inputs([0, 100, 0, 200, 0], 0, "interpolate")
        np.testing.assert_array_equal(shifted, [100, 100, 150, 200, 200])
        np.testing.assert_array_equal(voiced, [False, True, False, True, False])

    def test_completely_unvoiced_input_stays_unvoiced_in_both_modes(self):
        for mode in ("preserve-unvoiced", "interpolate"):
            with self.subTest(mode=mode):
                coarse, shifted, voiced = sample.pitch_inputs([0, 0, 0], -12, mode)
                np.testing.assert_array_equal(coarse, [1, 1, 1])
                np.testing.assert_array_equal(shifted, [0, 0, 0])
                self.assertFalse(voiced.any())

    def test_rejects_nonfinite_negative_or_multidimensional_f0(self):
        for raw in ([np.nan], [np.inf], [-1], [[100, 200]]):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                sample.pitch_inputs(raw, 0, "preserve-unvoiced")

    def test_coarse_pitch_saturates_to_valid_embedding_range(self):
        coarse, _, _ = sample.pitch_inputs([0, 1, 50, 1100, 5000], 0, "preserve-unvoiced")
        self.assertTrue(((coarse >= 1) & (coarse <= 255)).all())
        self.assertEqual(coarse[0], 1)
        self.assertEqual(coarse[-1], 255)


class RetrievalProtectionTests(unittest.TestCase):
    def test_zero_rate_preserves_baseline_and_zero_protect_preserves_consonants(self):
        import torch
        original = torch.full((1, 3, 768), 2.0)
        reference = torch.full_like(original, 10.0)
        voiced = torch.tensor([True, False, True])
        baseline = sample.blend_retrieved_features(original, reference, voiced, 0, .33)
        self.assertIs(baseline, original)
        protected = sample.blend_retrieved_features(original, reference, voiced, .5, 0)
        torch.testing.assert_close(protected[:, 1], original[:, 1], rtol=0, atol=0)
        torch.testing.assert_close(protected[:, 0], torch.full((1, 768), 6.0))
        unprotected = sample.blend_retrieved_features(original, reference, voiced, .5, .5)
        torch.testing.assert_close(unprotected, torch.full_like(original, 6.0))
        torch.testing.assert_close(original, torch.full_like(original, 2.0))

    def test_rejects_invalid_mask_shape_or_nonfinite_features(self):
        import torch
        original = torch.zeros((1, 3, 768))
        voiced = torch.tensor([True, False, True])
        for reference, mask in ((original[:, :2], voiced),
                                (original, voiced.float()),
                                (torch.full_like(original, float("nan")), voiced)):
            with self.assertRaises(ValueError):
                sample.blend_retrieved_features(original, reference, mask, .35, .33)


class PrivateFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="own-voice-sample-test-", dir=sample.PRIVATE_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def cli(self, semitones):
        return ["convert-own-voice-sample.py", "--upstream", str(self.directory / "upstream"),
                "--checkpoint", str(self.directory / "model.pth"),
                "--input", str(self.directory / "en-example.wav"),
                "--source-manifest", str(self.directory / "source.json"),
                "--out-dir", str(self.directory / "new-output"), "--semitones", str(semitones)]

    def test_cli_rejects_nonfinite_or_out_of_bounds_pitch(self):
        for semitones in ("nan", "inf", "-inf", "12.01", "-12.01"):
            with self.subTest(semitones=semitones), patch.object(sys, "argv", self.cli(semitones)):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    sample.arguments()
                self.assertEqual(raised.exception.code, 2)

    def test_cli_accepts_pitch_bounds_and_zero(self):
        for semitones in (-12, 0, 12):
            with self.subTest(semitones=semitones), patch.object(sys, "argv", self.cli(semitones)):
                args = sample.arguments()
                self.assertEqual(args.semitones, semitones)
                self.assertEqual(args.f0_mode, "preserve-unvoiced")
                self.assertEqual(args.device, "cpu")
                self.assertEqual(args.retrieval_rate, 0)
                self.assertIsNone(args.retrieval_feature_report)

    def test_retrieval_requires_paired_private_report_and_bounded_rate(self):
        report = str(self.directory / "feature-report.json")
        invalid = [["--retrieval-rate", ".35"], ["--retrieval-feature-report", report],
                   ["--retrieval-rate", "nan"], ["--retrieval-rate", "1.1"],
                   ["--unvoiced-protect", "-.01"], ["--unvoiced-protect", "nan"]]
        for extra in invalid:
            with self.subTest(extra=extra), patch.object(sys, "argv", self.cli(0) + extra):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    sample.arguments()
        with patch.object(sys, "argv", self.cli(0) + ["--retrieval-feature-report", report,
                                                     "--retrieval-rate", ".35"]):
            self.assertEqual(sample.arguments().retrieval_feature_report, Path(report))

    def source_fixture(self):
        path = self.directory / "en-example.wav"
        self.write_wave(path, 32000)
        data = {"version": "own-voice-synthetic-source/1",
                "source": "Installed Microsoft Zira Desktop offline SAPI",
                "upload": False, "personalVoice": False, "sampleRate": 32000,
                "sentences": [{"filename": path.name, "text": "I finish work at five.",
                               "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}]}
        manifest = self.directory / "source.json"
        manifest.write_text(json.dumps(data), encoding="utf-8")
        return path, manifest, data

    @staticmethod
    def write_wave(path, rate, amplitude=1000):
        # Fixed synthetic tone, never a copied real voice.
        count = rate // 10
        pcm = np.rint(amplitude * np.sin(2 * np.pi * 250 * np.arange(count) / rate)).astype("<i2")
        with wave.open(str(path), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(rate)
            stream.writeframes(pcm.tobytes())
        return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "sample_rate": rate, "frames": count, "duration_seconds": count / rate}

    def test_source_manifest_binds_synthetic_waveform_hash(self):
        path, manifest, _ = self.source_fixture()
        result = sample.synthetic_source(path, manifest)
        self.assertEqual(result["kind"], "HASH_BOUND_WINDOWS_SAPI_SYNTHETIC")
        self.assertEqual(result["text"], "I finish work at five.")
        self.assertEqual(result["manifest_sha256"], hashlib.sha256(manifest.read_bytes()).hexdigest())

    def test_source_manifest_rejects_changed_waveform(self):
        path, manifest, _ = self.source_fixture()
        self.write_wave(path, 32000, amplitude=1200)
        with self.assertRaisesRegex(ValueError, "changed since"):
            sample.synthetic_source(path, manifest)

    def test_source_manifest_rejects_personal_voice_or_uploaded_provenance(self):
        path, manifest, data = self.source_fixture()
        for field in ("personalVoice", "upload"):
            with self.subTest(field=field):
                invalid = dict(data)
                invalid[field] = True
                manifest.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "non-personal offline"):
                    sample.synthetic_source(path, manifest)

    def test_source_manifest_rejects_duplicate_matching_entries(self):
        path, manifest, data = self.source_fixture()
        data["sentences"] *= 2
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Exactly one"):
            sample.synthetic_source(path, manifest)

    def candidate_fixture(self):
        report = {"schema": "own-voice-offline-sample/1.0", "status": "completed",
                  "scope": "LOCAL_FULL_FILE_SAMPLE_NOT_PHONE_OR_STREAMING_ACCEPTANCE",
                  "checkpoint": {"role": "OWN_VOICE_TRAINED_CANDIDATE", "sha256": "a" * 64,
                                 "own_voice_metadata": {"role": "own-voice-local-trained",
                                                        "training_steps": 40, "quality_accepted": False}},
                  "source": {"kind": "HASH_BOUND_WINDOWS_SAPI_SYNTHETIC", "language": "en-US",
                             "text": 'Could you repeat <img src=x onerror="bad()"> & "five"?'},
                  "features": {"semitones": 0, "f0_mode": "preserve-unvoiced"},
                  "measurement": {"ready_for_listening_only": True}, "outputs": {}}
        for name, rate in (("source-original.wav", 32000), ("converted-32k.wav", 32000),
                           ("converted-phone-8k.wav", 8000)):
            report["outputs"][name] = self.write_wave(self.directory / name, rate)
        self.save_report(report)
        return report

    def save_report(self, report):
        (self.directory / "report.private.json").write_text(json.dumps(report), encoding="utf-8")

    def test_review_rejects_base_control_and_partial_metadata_disguise(self):
        for role, own_role in (("UNPERSONALIZED_BASE_CONTROL_NOT_A_CLONE", "own-voice-local-trained"),
                               ("OWN_VOICE_TRAINED_CANDIDATE", "official-unpersonalized-base")):
            with self.subTest(role=role, own_role=own_role):
                report = self.candidate_fixture()
                report["checkpoint"]["role"] = role
                report["checkpoint"]["own_voice_metadata"]["role"] = own_role
                self.save_report(report)
                with self.assertRaisesRegex(ValueError, "base controls"):
                    review.load_candidate(self.directory)

    def test_review_requires_positive_actual_step_count_and_unaccepted_quality(self):
        for steps, accepted in ((0, False), (-1, False), (True, False), (40, True)):
            with self.subTest(steps=steps, accepted=accepted):
                report = self.candidate_fixture()
                report["checkpoint"]["own_voice_metadata"].update(training_steps=steps, quality_accepted=accepted)
                self.save_report(report)
                with self.assertRaisesRegex(ValueError, "positive training steps"):
                    review.load_candidate(self.directory)

    def test_review_rejects_changed_audio_after_report(self):
        self.candidate_fixture()
        self.write_wave(self.directory / "converted-32k.wav", 32000, amplitude=1200)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            review.load_candidate(self.directory)

    def test_review_escapes_source_text_and_names_and_has_no_autoplay(self):
        report = self.candidate_fixture()
        candidate = review.load_candidate(self.directory)
        candidate["name"] = '<script>alert("fixture")</script>'
        page = review.build_page([candidate])

        class ParsedPage(HTMLParser):
            def __init__(self):
                super().__init__()
                self.tags, self.text, self.audio = [], [], []

            def handle_starttag(self, tag, attributes):
                self.tags.append(tag)
                if tag == "audio":
                    self.audio.append(dict(attributes))

            def handle_data(self, data):
                self.text.append(data)

        parsed = ParsedPage()
        parsed.feed(page)
        self.assertNotIn("script", parsed.tags)
        self.assertNotIn("img", parsed.tags)
        self.assertIn(report["source"]["text"], "".join(parsed.text))
        self.assertIn(candidate["name"], "".join(parsed.text))
        self.assertEqual(len(parsed.audio), 3)
        for element in parsed.audio:
            self.assertNotIn("autoplay", element)
            self.assertEqual(element.get("preload"), "none")
            self.assertTrue(element["src"].startswith("data:audio/wav;base64,"))
        self.assertIn("connect-src 'none'", page)


if __name__ == "__main__":
    unittest.main(verbosity=2)
