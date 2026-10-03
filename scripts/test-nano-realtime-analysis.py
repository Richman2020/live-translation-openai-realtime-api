"""Small offline integrity and queue-arithmetic tests; no models or user audio."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import tempfile
import unittest


REPO = Path(__file__).resolve().parent.parent
PRIVATE = (REPO / ".runtime").resolve()
spec = importlib.util.spec_from_file_location("nano_realtime_analysis_tests", REPO / "scripts/analyze-nano-realtime-probe.py")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


def float_wav(frames=8000, amplitude=.25, peak_timestamp=None, sample_rate=8000):
    data = struct.pack("<" + "f" * frames, *([amplitude, -amplitude] * (frames // 2)))
    fmt = struct.pack("<4sIHHIIHH", b"fmt ", 16, 3, 1, sample_rate, sample_rate * 4, 4, 32)
    fact = struct.pack("<4sII", b"fact", 4, frames)
    peak = b""
    if peak_timestamp is not None:
        payload = struct.pack("<IIfI", 1, peak_timestamp, abs(amplitude), 0)
        peak = struct.pack("<4sI", b"PEAK", len(payload)) + payload
    content = b"WAVE" + fmt + fact + peak + struct.pack("<4sI", b"data", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(content)) + content


def minimal_queue_sample(identifier, compute, duration):
    return {"sample_id": identifier, "phase": "warm_repeat",
            "measured_whole_file_return_seconds": compute, "audio_duration_seconds": duration}


class QueueTests(unittest.TestCase):
    def test_generator_and_player_are_separate_servers(self):
        samples = {str(i): minimal_queue_sample(str(i), .5, 2) for i in range(3)}
        plan = [{"sample_id": str(i), "text_ready_at_seconds": i} for i in range(3)]
        result = analysis.simulate_fifo(plan, samples)
        self.assertEqual([r["simulated_generation_start_at_seconds"] for r in result["rows"]], [0, 1, 2])
        self.assertEqual([r["ideal_playback_start_at_seconds"] for r in result["rows"]], [.5, 2.5, 4.5])
        self.assertEqual(result["ideal_final_tail_after_last_text_ready_seconds"], 4.5)
        self.assertEqual(result["ideal_final_extra_tail_vs_zero_compute_seconds"], .5)
        self.assertFalse(result["actual_paced_replay"])

    def test_slow_generator_accumulates_compute_queue(self):
        samples = {str(i): minimal_queue_sample(str(i), 2, 1) for i in range(3)}
        plan = [{"sample_id": str(i), "text_ready_at_seconds": i} for i in range(3)]
        result = analysis.simulate_fifo(plan, samples)
        self.assertEqual([r["simulated_generator_queue_wait_seconds"] for r in result["rows"]], [0, 1, 2])
        self.assertEqual([r["ideal_playback_queue_wait_seconds"] for r in result["rows"]], [0, 0, 0])
        self.assertEqual(result["ideal_final_extra_tail_vs_zero_compute_seconds"], 4)

    def test_arrival_times_are_not_silently_reordered(self):
        samples = {"a": minimal_queue_sample("a", 1, 1)}
        with self.assertRaisesRegex(ValueError, "FIFO order"):
            analysis.simulate_fifo([{"sample_id": "a", "text_ready_at_seconds": 2},
                                    {"sample_id": "a", "text_ready_at_seconds": 1}], samples)

    def test_reused_measurement_is_disclosed(self):
        sample = {"a": minimal_queue_sample("a", 1, 1)}
        result = analysis.simulate_fifo([{"sample_id": "a", "text_ready_at_seconds": 0},
                                         {"sample_id": "a", "text_ready_at_seconds": 2}], sample)
        self.assertEqual(result["unique_measured_samples_used"], 1)
        self.assertEqual(result["sample_reuse_counts"], {"a": 2})


class ReportTests(unittest.TestCase):
    def setUp(self):
        PRIVATE.mkdir(exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="nano-analysis-tests-", dir=PRIVATE)).resolve()
        self.assertTrue(self.directory.is_relative_to(PRIVATE))
        self.report_path = self.directory / "report.private.json"
        self.report = {"schema": "nano-realtime-probe/1", "status": "completed",
                       "resident_model": True, "generation_api": "OFFICIAL_WHOLE_FILE_GENERATE_NOT_STREAMING",
                       "network": {"blocked_attempts": 0, "downloads": False, "uploads": False,
                                   "python_socket_guard_active": True},
                       "replay_mode": analysis.REPLAY_MODE, "samples": [], "replay": [
                           {"sample_id": "repeat-a", "scenario": "whole", "text_ready_at_seconds": 0},
                           {"sample_id": "repeat-b", "scenario": "whole", "text_ready_at_seconds": 1}]}
        params = {"repetition_penalty": 1.2, "min_p": 0.0, "top_p": .95,
                  "audio_prompt_path": None, "exaggeration": 0.0, "cfg_weight": 0.0,
                  "temperature": .75, "top_k": 1000, "norm_loudness": True}
        raw = float_wav()
        for identifier, phase, compute in (("warm", "warmup", 999),
                                            ("repeat-a", "warm_repeat", .5),
                                            ("repeat-b", "warm_repeat", 1.5)):
            filename = identifier + ".wav"
            (self.directory / filename).write_bytes(raw)
            native = {"filename": filename, "sha256": hashlib.sha256(raw).hexdigest(),
                      "bytes": len(raw), "frames": 8000, "sample_rate": 8000,
                      "duration_seconds": 1.0, "channels": 1, "subtype": "FLOAT"}
            self.report["samples"].append({"id": identifier, "phase": phase, "group": "whole",
                "repeat": 0 if phase == "warmup" else (1 if identifier == "repeat-a" else 2),
                "fixture_id": "tiny-fixture", "text": "Synthetic test fixture only.", "seed": 17,
                "generation_parameters": copy.deepcopy(params), "generate_wall_seconds": compute,
                "native": native, "status": "completed", "t3_calls": [{
                    "wall_seconds": .1, "configured_generation_loop_limit": 1000,
                    "returned_token_count": 25, "returned_shape": [1, 25],
                    "returned_tokens_below_6561": 25, "near_or_at_generation_limit": False,
                    "definite_limit_without_terminal_eos": False}]})

    def tearDown(self):
        # Delete only this test's freshly created, resolved private directory.
        target = self.directory.resolve()
        self.assertTrue(target.is_relative_to(PRIVATE) and target.parent == PRIVATE)
        self.assertTrue(target.name.startswith("nano-analysis-tests-"))
        shutil.rmtree(target)

    def analyze(self):
        self.report_path.write_text(json.dumps(self.report), encoding="utf-8")
        return analysis.analyze(self.report_path)

    def replace_audio(self, sample_index, raw, **metadata):
        native = self.report["samples"][sample_index]["native"]
        (self.directory / native["filename"]).write_bytes(raw)
        native.update(sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw), **metadata)

    def test_peak_timestamp_changes_file_hash_not_waveform_identity(self):
        self.replace_audio(1, float_wav(peak_timestamp=1700000000))
        self.replace_audio(2, float_wav(peak_timestamp=1700000001))
        measured = self.analyze()["measured_whole_file_runs"]
        first, second = measured["samples"]
        self.assertNotEqual(first["native_sha256"], second["native_sha256"])
        self.assertEqual(first["native_pcm_data_sha256"], second["native_pcm_data_sha256"])
        self.assertEqual(measured["fixtures"][0]["unique_file_hashes"], 2)
        self.assertEqual(measured["fixtures"][0]["unique_waveform_hashes"], 1)

    def test_changed_pcm_samples_change_waveform_identity(self):
        self.replace_audio(1, float_wav(amplitude=.25, peak_timestamp=1700000000))
        self.replace_audio(2, float_wav(amplitude=.125, peak_timestamp=1700000000))
        measured = self.analyze()["measured_whole_file_runs"]
        self.assertEqual(measured["fixtures"][0]["unique_waveform_hashes"], 2)

    def test_same_sample_bytes_with_changed_rate_are_not_comparable(self):
        self.replace_audio(2, float_wav(sample_rate=16000), sample_rate=16000, duration_seconds=.5)
        with self.assertRaisesRegex(ValueError, "identical WAV sampling format"):
            self.analyze()

    def test_warmup_is_excluded_and_latency_labels_remain_separate(self):
        result = self.analyze()
        measured = result["measured_whole_file_runs"]
        self.assertEqual(measured["formal_sample_count"], 2)
        self.assertEqual(measured["warmup_count_excluded"], 1)
        self.assertEqual(measured["weighted_compute_rtf"], 1)
        self.assertEqual(measured["whole_file_return_seconds"]["median"], 1)
        self.assertIsNone(result["acceptance"]["streaming_first_audio_seconds"])
        self.assertIsNone(result["acceptance"]["measured_phone_latency_seconds"])
        self.assertEqual(result["acceptance"]["realtime_ready"], "NOT_ESTABLISHED")

    def test_failure_is_not_cherry_picked_out(self):
        self.report["samples"][-1]["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "Failed or incomplete"):
            self.analyze()

    def test_failed_top_level_is_rejected(self):
        self.report["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "Only completed"):
            self.analyze()

    def test_missing_audio_is_rejected(self):
        (self.directory / "repeat-b.wav").unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.analyze()

    def test_corrupt_audio_hash_is_rejected(self):
        self.report["samples"][-1]["native"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.analyze()

    def test_token_limit_cannot_hide_behind_false_flags(self):
        trace = self.report["samples"][-1]["t3_calls"][0]
        trace.update(returned_token_count=1000, returned_shape=[1, 1000], returned_tokens_below_6561=1000)
        with self.assertRaisesRegex(ValueError, "truncation"):
            self.analyze()

    def test_truncation_flag_is_rejected_even_with_short_output(self):
        self.report["samples"][-1]["t3_calls"][0]["near_or_at_generation_limit"] = True
        with self.assertRaisesRegex(ValueError, "truncation"):
            self.analyze()

    def test_changed_seed_is_not_a_fixed_repeat(self):
        self.report["samples"][-1]["seed"] = 18
        with self.assertRaisesRegex(ValueError, "identical text, seed"):
            self.analyze()

    def test_one_repeat_does_not_establish_fixture_distribution(self):
        self.report["samples"][-1]["fixture_id"] = "other"
        with self.assertRaisesRegex(ValueError, "at least two"):
            self.analyze()

    def test_nonfinite_compute_is_rejected(self):
        self.report["samples"][-1]["generate_wall_seconds"] = float("nan")
        with self.assertRaisesRegex(ValueError, "generation duration"):
            self.analyze()

    def test_native_path_escape_is_rejected(self):
        self.report["samples"][-1]["native"]["filename"] = "../elsewhere.wav"
        with self.assertRaisesRegex(ValueError, "filename"):
            self.analyze()

    def test_missing_explicit_parameters_is_rejected(self):
        self.report["samples"][-1].pop("generation_parameters")
        with self.assertRaisesRegex(ValueError, "explicit generation"):
            self.analyze()

    def test_warmup_cannot_be_used_as_formal_replay_measurement(self):
        self.report["replay"][0]["sample_id"] = "warm"
        with self.assertRaisesRegex(ValueError, "warm-repeat samples"):
            self.analyze()

    def test_scenarios_restart_at_zero_without_cross_contamination(self):
        for index, original in enumerate(self.report["samples"][1:], start=1):
            sample = copy.deepcopy(original)
            sample.update(id="phrase-" + str(index), group="phrase", fixture_id="phrase-fixture")
            self.report["samples"].append(sample)
            self.report["replay"].append({"sample_id": sample["id"], "scenario": "phrase",
                                           "text_ready_at_seconds": index - 1})
        result = self.analyze()["ideal_queue_simulations"]
        self.assertEqual([group["scenario"] for group in result], ["whole", "phrase"])
        self.assertEqual([group["rows"][0]["simulated_generation_start_at_seconds"] for group in result], [0, 0])
        self.assertEqual(result[0]["ideal_final_tail_after_last_text_ready_seconds"],
                         result[1]["ideal_final_tail_after_last_text_ready_seconds"])

    def test_cross_scenario_sample_reference_is_rejected(self):
        self.report["replay"][0]["scenario"] = "phrase"
        with self.assertRaisesRegex(ValueError, "does not match"):
            self.analyze()


if __name__ == "__main__":
    unittest.main(verbosity=2)
