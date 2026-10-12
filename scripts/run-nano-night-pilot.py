"""Resume the private Nano experiment; no purchases, cloud voice upload or calls.

Run in the lab's isolated Python environment. Downloads are prepared separately;
this coordinator waits for verified public prerequisites, installs dependencies,
then invokes the network-blocked whole-file probe and private review builder.
"""
import hashlib
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone

REPO = Path(__file__).resolve().parent.parent
LAB = REPO / ".runtime/chatterbox-nano-lab"
PYTHON = LAB / "venv/Scripts/python.exe"
WHEELS = {
    "torch-2.6.0+cpu-cp312-cp312-win_amd64.whl": "4027d982eb2781c93825ab9527f17fbbb12dbabf422298e4b954be60016f87d8",
    "torchaudio-2.6.0+cpu-cp312-cp312-win_amd64.whl": "75266c25d394bb5d70f83a38b1b4d858c074a767c18f7ff87443bdf193c1b236",
}
DEPENDENCIES = [
    "numpy==1.26.4", "librosa==0.11.0", "s3tokenizer==0.3.0",
    "transformers==5.2.0", "diffusers==0.29.0", "conformer==0.3.2",
    "safetensors==0.5.3", "pyloudnorm", "omegaconf", "einops", "onnx",
    "soundfile", "pydub", "PyYAML", "psutil",
]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def save(state):
    state["updated_at_utc"] = stamp()
    target = LAB / "night-pilot-status.json"
    tmp = target.with_suffix(".json.part")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(target)


def wait_until(state, stage, condition, seconds=10800):
    state.update(stage=stage, stage_started_at_utc=stamp())
    save(state)
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() >= deadline:
            raise TimeoutError("Timed out: " + stage)
        time.sleep(20)


def command(state, stage, args, timeout=3600):
    state.update(stage=stage, stage_started_at_utc=stamp())
    save(state)
    log = LAB / (state["run_id"] + "-" + stage + ".log")
    started = time.monotonic()
    record = {"stage": stage, "log": log.name}
    with log.open("xb") as stream:
        process = subprocess.Popen([str(PYTHON), *map(str, args)], cwd=REPO,
                                   stdout=stream, stderr=subprocess.STDOUT)
        record["pid"] = process.pid
        try:
            record["returncode"] = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            record["timed_out"] = True
            # Kill this exact command and its descendants, including pip build
            # workers, before releasing the coordinator lock on Windows.
            cleanup = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                     stdout=stream, stderr=subprocess.STDOUT, timeout=30)
            record["tree_cleanup_returncode"] = cleanup.returncode
            record["returncode"] = process.wait(timeout=30)
    record["wall_seconds"] = time.monotonic() - started
    state.setdefault("commands", []).append(record)
    save(state)
    if record.get("timed_out"):
        raise TimeoutError(stage + " exceeded its limit; see private log " + log.name)
    if record["returncode"]:
        raise RuntimeError(stage + " failed; see private log " + log.name)


def main():
    if os.name != "nt" or Path(sys.prefix).resolve() != (LAB / "venv").resolve():
        raise RuntimeError("Use this Windows lab's isolated Python environment")
    import msvcrt
    lock = (LAB / "night-pilot.lock").open("a+b")
    if lock.seek(0, 2) == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = LAB / ("probe-" + run_id)
    review = LAB / ("review-" + run_id)
    state = {"schema": "nano-night-pilot/1", "status": "running", "run_id": run_id,
             "pid": os.getpid(), "started_at_utc": stamp(), "probe_directory": str(output),
             "review_directory": str(review), "human_listening": "PENDING",
             "phone_integration": "NOT_CHANGED", "audio_uploads": False}
    # Temporary thread-scoped sleep prevention; no power-plan setting changes.
    execution_state = ctypes.windll.kernel32.SetThreadExecutionState
    execution_state.argtypes = [ctypes.c_uint]
    execution_state.restype = ctypes.c_uint
    state["temporary_system_sleep_prevention"] = bool(execution_state(0x80000001))
    save(state)
    try:
        wheel_paths = [LAB / "wheels" / name for name in WHEELS]
        perth = LAB / "perth-archive"
        def resources_ready():
            result_path = LAB / "cpu-perth-download-result.json"
            if result_path.is_file():
                result = json.loads(result_path.read_text(encoding="utf-8-sig"))
                if result.get("wheels") != "verified" or result.get("perth") != "verified":
                    raise RuntimeError("Public resource preparation failed; inspect download result")
            return (all(path.is_file() for path in wheel_paths)
                    and (perth / "pyproject.toml").is_file() and result_path.is_file())
        wait_until(state, "wait_public_install_resources", resources_ready)
        resources = json.loads((LAB / "cpu-perth-download-result.json").read_text(encoding="utf-8-sig"))
        if resources.get("wheels") != "verified" or resources.get("perth") != "verified":
            raise ValueError("Public resource verification did not pass")
        state["resource_result"] = resources
        for path in wheel_paths:
            if digest(path) != WHEELS[path.name]:
                raise ValueError("Public wheel checksum mismatch: " + path.name)
        # The source download task verifies every archive file against fixed Git
        # blob identities. Do not use an unverified archive after a failed task.
        manifest_path = LAB / "perth-source-manifest.json"
        if not manifest_path.is_file():
            raise ValueError("Missing fixed-commit Perth source verification")
        source_manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        if (source_manifest.get("repo") != "resemble-ai/Perth" or
                source_manifest.get("commit") != "ff1c8ac55a976971245cdd53c18d6131ca00d993"):
            raise ValueError("Unexpected Perth source revision")
        if not source_manifest.get("files"):
            raise ValueError("Empty Perth verification manifest")
        for item in source_manifest["files"]:
            path = (perth / item["path"]).resolve()
            if not path.is_relative_to(perth.resolve()) or not path.is_file():
                raise ValueError("Invalid Perth source path")
            if path.stat().st_size != item["size"] or digest(path) != item["sha256"]:
                raise ValueError("Perth local source changed after verification")
        state["perth_manifest_sha256"] = digest(manifest_path)
        save(state)
        command(state, "install_runtime", ["-m", "pip", "install", *wheel_paths,
            *DEPENDENCIES, perth, "--find-links", LAB / "wheels", "--index-url",
            "https://pypi.org/simple", "--timeout", "20", "--retries", "3",
            "--disable-pip-version-check"], timeout=5400)
        command(state, "install_chatterbox", ["-m", "pip", "install", "--no-deps", "-e",
            LAB / "upstream", "--disable-pip-version-check"], timeout=900)
        command(state, "import_check", ["-c", "import torch,torchaudio,perth; from chatterbox.tts_turbo import ChatterboxTurboTTS; assert torch.__version__=='2.6.0+cpu'; assert torchaudio.__version__=='2.6.0+cpu'; assert perth.PerthImplicitWatermarker is not None; print('CPU runtime imports passed')"], timeout=180)
        command(state, "freeze", ["-m", "pip", "freeze"], timeout=120)
        model_manifest = json.loads((LAB / "model-manifest.json").read_text(encoding="utf-8-sig"))
        wait_until(state, "wait_public_model_files", lambda: all(
            (LAB / "model" / item["path"]).is_file() for item in model_manifest["files"]))
        command(state, "generate_samples", [REPO / "scripts/probe-chatterbox-nano.py",
            "--model-dir", LAB / "model", "--reference", LAB / "reference-10s.wav",
            "--output-dir", output, "--upstream-dir", LAB / "upstream", "--threads", "4"], timeout=1200)
        report = json.loads((output / "report.private.json").read_text(encoding="utf-8"))
        if report["status"] != "completed_for_listening":
            raise RuntimeError("Probe has not completed for listening")
        command(state, "build_review", [REPO / "scripts/build-nano-voice-review.py",
            "--nano-report", output / "report.private.json", "--output-dir", review], timeout=180)
        state.update(status="completed_for_listening", stage="complete",
                     completed_at_utc=stamp())
        save(state)
    except (Exception, KeyboardInterrupt) as error:
        state.update(status="failed", error={"type": type(error).__name__, "message": str(error)})
        save(state)
        return 1
    finally:
        execution_state(0x80000000)
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
