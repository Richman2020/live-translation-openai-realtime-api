"""Synthetic verification only: no models, networking or real voice inputs."""

import audioop
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import wave

import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fixed_voice_benchmark", REPO / "scripts/benchmark-fixed-voice.py")
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class TimelineTests(unittest.TestCase):
    def test_fifo_recurrence_retains_initial_wait_and_later_starvation(self):
        # Hand schedule: [0.5,1.5], [1.5,2.0], then a 1s underrun, [3,3.25].
        chunks = [{"frames": frames, "available_at_seconds": available}
                  for frames, available in ((1000, .5), (500, .8), (250, 3.0))]
        original = np.concatenate([np.full(1000, .1), np.full(500, .2), np.full(250, .3)]).astype(np.float32)
        report = benchmark.analyze_timeline(chunks, original, 1000)
        self.assertEqual(report["initial_wait_seconds"], .5)
        self.assertEqual(report["buffer_starvation_count"], 1)
        self.assertEqual(report["buffer_starvation_seconds"], 1)
        self.assertEqual(report["ideal_fifo_complete_seconds"], 3.25)
        replay = benchmark.render_fifo(chunks, original, 1000)
        self.assertEqual(len(replay), 3250)
        np.testing.assert_array_equal(replay[:500], 0)
        np.testing.assert_array_equal(replay[500:2000], original[:1500])
        np.testing.assert_array_equal(replay[2000:3000], 0)
        np.testing.assert_array_equal(replay[3000:], original[1500:])

    def test_voiced_confirmation_can_span_multiple_chunks(self):
        # Speech starts at audio t=.03; first 10ms voiced frame in chunk 1,
        # second frame arrives in chunk 2 at wall t=.4. FIFO speech at .33.
        waveform = np.concatenate([np.zeros(30), np.full(40, .1)]).astype(np.float32)
        chunks = [{"frames": n, "available_at_seconds": t} for n, t in ((20, .1), (20, .32), (30, .4))]
        report = benchmark.analyze_timeline(chunks, waveform, 1000)
        self.assertEqual(report["first_chunk_seconds"], .1)
        self.assertEqual(report["first_voiced_data_available_seconds"], .4)
        self.assertAlmostEqual(report["leading_silence_seconds"], .03)
        self.assertAlmostEqual(report["ideal_fifo_first_voiced_seconds"], .33)

    def test_silence_and_single_frame_click_do_not_become_confirmed_voice(self):
        self.assertIsNone(benchmark.energy_onset(np.zeros(100), 1000))
        signal = np.zeros(100)
        signal[40:50] = .5
        self.assertIsNone(benchmark.energy_onset(signal, 1000))

    def test_bad_timestamps_and_lost_samples_fail_closed(self):
        for chunks in ([{"frames": 10, "available_at_seconds": .2}, {"frames": 10, "available_at_seconds": .1}],
                       [{"frames": 19, "available_at_seconds": .1}],
                       [{"frames": 20, "available_at_seconds": float("nan")} ]):
            with self.assertRaises(ValueError):
                benchmark.analyze_timeline(chunks, np.ones(20), 1000)


class AudioExportTests(unittest.TestCase):
    def test_all_g711_codes_against_independent_stdlib_implementation(self):
        encode, decode, _ = benchmark.probe.codec_helpers()
        pcm = np.arange(-32768, 32768, dtype=np.int32).astype("<i2")
        self.assertEqual(encode(pcm).tobytes(), audioop.lin2ulaw(pcm.tobytes(), 2))
        codes = np.arange(256, dtype=np.uint8)
        self.assertEqual(decode(codes).astype("<i2").tobytes(), audioop.ulaw2lin(codes.tobytes(), 2))

    def test_saved_native_and_phone_files_hashes_codec_and_engine_parity(self):
        # Synthetic tone with >full-scale native samples verifies preservation
        # plus separate headroom conversion. Nothing is played or model-generated.
        frames = np.arange(24000)
        waveform = (1.1 * np.sin(2 * np.pi * 400 * frames / 24000)).astype(np.float32)
        private_root = (REPO / ".runtime").resolve()
        with tempfile.TemporaryDirectory(prefix="fixed-voice-test-", dir=private_root) as temporary:
            directory = Path(temporary).resolve()
            self.assertTrue(directory.is_relative_to(private_root))
            nano = benchmark.audio_exports(directory, "nano", waveform, 24000, "nano")
            pocket = benchmark.audio_exports(directory, "pocket", waveform, 24000, "pocket")
            self.assertEqual([r["sha256"] for r in nano["files"]], [r["sha256"] for r in pocket["files"]])
            for record in nano["files"]:
                contents = (directory / record["filename"]).read_bytes()
                self.assertEqual(record["sha256"], hashlib.sha256(contents).hexdigest())
                self.assertEqual(record["bytes"], len(contents))
            native, sample_rate = sf.read(directory / nano["files"][0]["filename"], dtype="float32")
            self.assertEqual(sample_rate, 24000)
            np.testing.assert_array_equal(native, waveform)
            ulaw = (directory / nano["files"][2]["filename"]).read_bytes()
            self.assertEqual(len(ulaw), 8000)
            with wave.open(str(directory / nano["files"][1]["filename"]), "rb") as source:
                self.assertEqual((source.getframerate(), source.getnchannels(), source.getsampwidth()), (8000, 1, 2))
                self.assertEqual(source.readframes(source.getnframes()), audioop.ulaw2lin(ulaw, 2))
            self.assertLess(nano["phone"]["gain"], 1)
            with self.assertRaises(FileExistsError):
                benchmark.audio_exports(directory, "nano", waveform, 24000, "nano")


if __name__ == "__main__":
    unittest.main()
