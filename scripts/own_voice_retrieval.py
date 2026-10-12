"""Hash-bound, CPU-only training-feature retrieval for private offline RVC trials.

No training, models, microphone, network, or audio I/O. Exact neighbors follow the
pinned RVC inverse-squared-score weighting; this is not a live latency guarantee.
"""

from contextlib import contextmanager
import hashlib
import io
import json
from pathlib import Path

import numpy as np
import faiss


PRIVATE_ROOT = (Path(__file__).resolve().parent.parent / ".runtime").resolve()
MAX_FRAMES = 200_000
DIMENSION = 768
NEIGHBORS = 8


def _private_path(value):
    path = Path(value).resolve()
    if path == PRIVATE_ROOT or not path.is_relative_to(PRIVATE_ROOT):
        raise ValueError("Feature artifacts must stay inside this project's .runtime")
    return path


def _hash(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def _cpu_threads(threads):
    old = faiss.omp_get_max_threads()
    faiss.omp_set_num_threads(threads)
    try:
        yield
    finally:
        faiss.omp_set_num_threads(old)


def _validate_features(array, *, allow_empty=False):
    if (not isinstance(array, np.ndarray) or array.dtype != np.dtype("float32")
            or array.ndim != 2 or array.shape[1] != DIMENSION
            or array.shape[0] > MAX_FRAMES or (not allow_empty and not array.shape[0])
            or not np.isfinite(array).all()):
        raise ValueError("Features must be finite float32 Nx768 within the frame limit")
    return np.ascontiguousarray(array)


class VoiceFeatureBank:
    def __init__(self, feature_report: Path, expected_dataset_sha256: str,
                 expected_upstream_commit: str, expected_model_hashes: dict,
                 threads: int = 4):
        if type(threads) is not int or not 1 <= threads <= 8:
            raise ValueError("CPU threads must be an integer between 1 and 8")
        self.threads = threads
        report_path = _private_path(feature_report)
        report_bytes = report_path.read_bytes()
        report = json.loads(report_bytes.decode("utf-8-sig"))
        if (not isinstance(report, dict)
                or report.get("version") != "own-voice-rvc-features/1"
                or report.get("status") != "complete"
                or report.get("hubertAudioNormalization") is not False
                or report.get("upstreamCommit") != expected_upstream_commit
                or not expected_model_hashes
                or report.get("modelSha256") != expected_model_hashes):
            raise ValueError("Feature report version, status, upstream or model binding mismatch")
        filelist = _private_path(report_path.parent / "train-filelist.txt")
        filelist_bytes = filelist.read_bytes()
        filelist_sha = _hash(filelist_bytes)
        if (filelist_sha != expected_dataset_sha256
                or filelist_sha != report.get("filelistSha256")):
            raise ValueError("Training filelist hash mismatch")
        rows = [line.split("|") for line in filelist_bytes.decode("utf-8-sig").splitlines()]
        segments = report.get("segments")
        if (not isinstance(segments, list) or not segments or len(segments) != len(rows)
                or report.get("completedSegments") != len(segments)):
            raise ValueError("Report and training filelist segment counts differ")
        arrays, seen_paths, seen_keys, bindings = [], set(), set(), []
        total_frames = 0
        for segment, row in zip(segments, rows):
            if (not isinstance(segment, dict) or len(row) != 5 or row[4] != "0"
                    or not isinstance(segment.get("key"), str) or not segment["key"]
                    or segment["key"] in seen_keys):
                raise ValueError("Invalid or duplicate segment or five-column training row")
            seen_keys.add(segment["key"])
            paths = [_private_path(value) for value in row[:4]]
            expected_paths = [_private_path(segment[name])
                              for name in ("wav32k", "feature", "pitch", "pitchf")]
            if paths != expected_paths or paths[1] in seen_paths:
                raise ValueError("Training row order/path mismatch or duplicate feature")
            seen_paths.add(paths[1])
            shape = segment.get("featureShape")
            if (not isinstance(shape, list) or len(shape) != 2
                    or any(type(value) is not int for value in shape)
                    or shape[1] != DIMENSION or not 0 < shape[0] <= MAX_FRAMES):
                raise ValueError("Invalid declared feature shape")
            total_frames += shape[0]
            if total_frames > MAX_FRAMES:
                raise ValueError("Training feature bank exceeds the frame limit")
            # Hash and decode identical bytes, with a cap before reading or allocating.
            byte_limit = shape[0] * DIMENSION * 4 + 65536
            with paths[1].open("rb") as source:
                feature_bytes = source.read(byte_limit + 1)
            if len(feature_bytes) > byte_limit:
                raise ValueError("Feature file exceeds its declared size bound")
            digest = _hash(feature_bytes)
            if digest != segment.get("sha256_feature"):
                raise ValueError("Feature byte hash mismatch")
            array = np.load(io.BytesIO(feature_bytes), allow_pickle=False)
            array = _validate_features(array)
            if list(array.shape) != shape:
                raise ValueError("Loaded feature shape differs from its report")
            arrays.append(array)
            bindings.append({"key": segment["key"], "sha256": digest, "shape": shape})
        if total_frames < NEIGHBORS:
            raise ValueError("Feature bank needs at least eight training frames")
        self._vectors = np.concatenate(arrays)
        self._index = faiss.IndexFlatL2(DIMENSION)
        with _cpu_threads(threads):
            self._index.add(self._vectors)
        self.metadata = {
            "version": "own-voice-feature-bank/1",
            "feature_report_sha256": _hash(report_bytes),
            "dataset_sha256": filelist_sha,
            "upstream_commit": expected_upstream_commit,
            "model_hashes": dict(expected_model_hashes),
            "files": len(arrays), "vectors": total_frames, "dimension": DIMENSION,
            "index_type": "faiss.IndexFlatL2 exact CPU", "neighbor_count": NEIGHBORS,
            "weighting": "(1 / squared_L2_score)^2; exact-zero neighbors share all weight",
            "feature_bindings_sha256": _hash(json.dumps(bindings, sort_keys=True).encode("utf-8")),
            "byte_hash_binding": "Every loaded feature checked against the report; ordered training filelist checked against checkpoint dataset hash",
            "cpu_threads": threads, "max_frames": MAX_FRAMES,
            "limit": "Private offline full-file experiment; no holdout retrieval, audio-quality acceptance or live latency claim",
        }

    def retrieve(self, features_np):
        features = _validate_features(features_np, allow_empty=True)
        output = np.empty_like(features)
        with _cpu_threads(self.threads):
            for start in range(0, len(features), 256):
                distances, indices = self._index.search(features[start:start + 256], NEIGHBORS)
                if (not np.isfinite(distances).all() or (indices < 0).any()
                        or (indices >= len(self._vectors)).any()):
                    raise ValueError("Invalid or overflowed nearest-neighbor results")
                distances = np.maximum(distances.astype(np.float64), 0)
                zeros = distances == 0
                exact_rows = zeros.any(axis=1)
                weights = np.zeros_like(distances)
                weights[exact_rows] = zeros[exact_rows] / zeros[exact_rows].sum(axis=1, keepdims=True)
                remaining = distances[~exact_rows]
                # Scaling by the row minimum is algebraically identical and avoids
                # overflow for very small positive distances in the official rule.
                weights[~exact_rows] = np.square(remaining.min(axis=1, keepdims=True) / remaining)
                weights[~exact_rows] /= weights[~exact_rows].sum(axis=1, keepdims=True)
                result = np.sum(self._vectors[indices].astype(np.float64)
                                * weights[:, :, None], axis=1).astype(np.float32)
                if not np.isfinite(result).all():
                    raise ValueError("Non-finite retrieved features")
                output[start:start + len(result)] = result
        return output
