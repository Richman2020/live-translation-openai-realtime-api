"""Local JSONL stdio process; private voice stays in the pinned local runtime."""
import base64
import json
import os
import queue
import re
import sys
import threading
import time

MAX_TEXT_CHARS = 240
MAX_REQUEST_BYTES = 4096
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
TEXT_PATTERN = re.compile(r"[ -~\u00c0-\u024f\u2010-\u2015\u2018-\u201d\u2026]+\Z")


def validate_job(value):
    if not isinstance(value, dict) or set(value) != {"id", "text"}:
        raise ValueError("NANOVOICE_INVALID_REQUEST")
    identifier, text = value["id"], value["text"]
    if not isinstance(identifier, str) or not ID_PATTERN.fullmatch(identifier):
        raise ValueError("NANOVOICE_INVALID_REQUEST")
    if not isinstance(text, str):
        raise ValueError("NANOVOICE_INVALID_TEXT")
    text = text.strip()
    if (not 1 <= len(text) <= MAX_TEXT_CHARS or not TEXT_PATTERN.fullmatch(text)
            or any(char in text for char in "[]<>") or not any(char.isalnum() for char in text)):
        raise ValueError("NANOVOICE_INVALID_TEXT")
    return {"id": identifier, "text": text}


def main():
    startup_started = time.perf_counter()
    def stage(name):
        # Fixed internal stage names only; no text, ids, paths or exception detail.
        sys.stderr.write(json.dumps({"type": "nano_stage", "stage": name,
                                     "elapsedMs": round((time.perf_counter() - startup_started) * 1000, 3)}) + "\n")
        sys.stderr.flush()
    stage("main_entered")
    # Keep a duplicate of the original IPC pipe; native library stdout and Python
    # prints go to stderr. Only emit() writes protocol JSON on the saved pipe.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    stage("stdio_redirected")
    lock = threading.Lock()
    def emit(event):
        try:
            with lock:
                protocol.write(json.dumps(event, ensure_ascii=True, allow_nan=False) + "\n")
                protocol.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)

    jobs = queue.Queue(maxsize=1)
    def read_input():
        while True:
            line = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                # EOF also releases the GPU if the parent vanishes during an
                # inference. No files are being written by this process.
                os._exit(0)
            if len(line) > MAX_REQUEST_BYTES or not line.endswith(b"\n"):
                emit({"type": "fatal", "code": "NANOVOICE_INVALID_REQUEST"})
                os._exit(1)
            try:
                job = validate_job(json.loads(line))
                jobs.put_nowait(job)
            except (ValueError, UnicodeError, queue.Full):
                emit({"type": "fatal", "code": "NANOVOICE_INVALID_REQUEST"})
                os._exit(1)
    stage("runtime_import_started")
    from nano_voice_runtime import NanoRuntimeError, NanoVoiceRuntime
    stage("runtime_import_completed")
    started = time.perf_counter()
    try:
        stage("runtime_load_started")
        runtime = NanoVoiceRuntime(on_stage=stage)
        stage("runtime_load_completed")
        warmup_started = time.perf_counter()
        stage("warmup_started")
        runtime.synthesize("Hello, thank you for calling.")
        warmup_ms = (time.perf_counter() - warmup_started) * 1000
        stage("warmup_completed")
    except Exception as error:
        code = str(error) if isinstance(error, NanoRuntimeError) else "NANOVOICE_START_FAILED"
        emit({"type": "fatal", "code": code})
        return 1
    # On Windows a pending read of inherited IPC stdin can interfere with
    # native-library initialization. Node queues jobs until this ready event.
    # During loading, Node owns timeout/exit cleanup of the full process tree.
    threading.Thread(target=read_input, name="nano-stdin", daemon=True).start()
    stage("stdin_reader_started")
    emit({"type": "ready", "protocol": 1, "sampleRate": 24000, "channels": 1,
          "encoding": "pcm_s16le", "mode": "synthesis-cuda", "temperature": 0.75,
          "maxTextChars": MAX_TEXT_CHARS,
          "metrics": {"startupMs": (time.perf_counter() - started) * 1000, "warmupMs": warmup_ms}})
    while True:
        job = jobs.get()
        try:
            pcm, metrics = runtime.synthesize(job["text"])
            emit({"id": job["id"], "type": "audio", "sampleRate": 24000,
                  "pcm": base64.b64encode(pcm).decode("ascii"), "metrics": metrics})
        except Exception as error:
            code = str(error) if isinstance(error, NanoRuntimeError) else "NANOVOICE_SYNTHESIS_FAILED"
            emit({"id": job["id"], "type": "error", "code": code})
            # Fail closed after a GPU/runtime failure; do not reuse a possibly
            # poisoned CUDA context or silently substitute another voice.
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
