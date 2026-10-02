"""Verify completed public-voice benchmarks and build an offline listening page.

No synthesis, model loading, reference copying, network access or publication.
Output is a new private folder that can be reviewed before copying to public/.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
import math
from pathlib import Path
import re
import statistics
import struct

REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROOT = (REPO / ".runtime").resolve()
PUBLIC_WAV_SHA = "b6743e9195e5e3fd34fe9d1633ae93f7ffab787b249e45f6467d7d6f7a6ee6ad"
PUBLIC_STATE_SHA = "401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c"
MAX_BYTES = 256 * 1024 * 1024
SHA = re.compile(r"[a-f0-9]{64}")
SAFE_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}")
VOICE = {"preset": "Michael", "speaker": "VCTK p360", "gender": "male",
         "accent": "American, New Jersey", "recorded_age": 19, "mature_timbre_accepted": False,
         "license": "CC BY 4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
         "source_url": "https://huggingface.co/kyutai/tts-voices",
         "attribution": "CSTR VCTK Corpus 0.92 — Junichi Yamagishi, Christophe Veaux, Kirsten MacDonald; sample enhanced by Kyutai using ai-coustics"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_path(value, exists=True):
    path = Path(value).resolve(strict=exists)
    require(path != PRIVATE_ROOT and path.is_relative_to(PRIVATE_ROOT), "Path must remain under this project's .runtime")
    return path


def number(value, name):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0, "Invalid " + name)
    return float(value)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(path):
    require(path.is_file() and path.stat().st_size <= 8 * 1024 * 1024, "Missing or oversized JSON")
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8-sig")), digest(raw)


def wav_metadata(raw):
    require(44 <= len(raw) <= MAX_BYTES and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", "Invalid WAV")
    require(struct.unpack_from("<I", raw, 4)[0] + 8 == len(raw), "WAV RIFF size mismatch")
    offset, fmt, data_bytes, audio_data = 12, None, None, None
    while offset + 8 <= len(raw):
        kind, size = struct.unpack_from("<4sI", raw, offset)
        start, end = offset + 8, offset + 8 + size
        require(end <= len(raw), "Truncated WAV")
        if kind == b"fmt ":
            require(fmt is None and size >= 16, "Invalid WAV format chunk")
            fmt = struct.unpack_from("<HHIIHH", raw, start)
        if kind == b"data":
            require(data_bytes is None, "Duplicate WAV data chunk")
            data_bytes = size
            audio_data = memoryview(raw)[start:end]
        offset = end + size % 2
    require(offset == len(raw) and fmt is not None and data_bytes, "Incomplete WAV")
    encoding, channels, rate, byte_rate, alignment, bits = fmt
    require(channels == 1 and (encoding, bits) in ((1, 16), (3, 32)), "Expected mono PCM16 or FLOAT WAV")
    require(8000 <= rate <= 48000 and alignment == bits // 8 and byte_rate == rate * alignment, "Bad WAV sample format")
    require(data_bytes % alignment == 0, "WAV ends in a partial frame")
    frames = data_bytes // alignment
    scale = 32768 if encoding == 1 else 1
    energy = math.fsum(value * value for (value,) in struct.iter_unpack("<h" if encoding == 1 else "<f", audio_data))
    require(math.isfinite(energy) and energy > 0, "Silent or nonfinite audio")
    return {"frames": frames, "sample_rate": rate, "duration_seconds": frames / rate,
            "channels": 1, "subtype": "PCM_16" if encoding == 1 else "FLOAT", "rms": math.sqrt(energy / frames) / scale}


def verify_asset(directory, record):
    filename = record.get("filename", "")
    require(isinstance(filename, str) and SAFE_NAME.fullmatch(filename), "Unsafe output filename")
    require(SHA.fullmatch(str(record.get("sha256", ""))), "Missing output checksum")
    path = private_path(directory / filename)
    require(path.parent == directory and path.is_file(), "Output missing or escaped report directory")
    size = path.stat().st_size
    require(type(record.get("bytes")) is int and 0 < size <= MAX_BYTES and size == record["bytes"], "Output byte size mismatch: " + filename)
    raw = path.read_bytes()
    require(len(raw) == size and digest(raw) == record["sha256"], "Output checksum mismatch: " + filename)
    if filename.endswith(".wav"):
        actual = wav_metadata(raw)
        for key in ("frames", "sample_rate", "channels", "subtype"):
            require(record.get(key) == actual[key], "WAV metadata mismatch: " + key)
        require(abs(number(record.get("duration_seconds"), "WAV duration") - actual["duration_seconds"]) <= 1 / actual["sample_rate"],
                "WAV duration mismatch")
    else:
        require(filename.endswith(".ulaw") and record.get("encoding") == "G711_MULAW_RAW", "Unexpected output type")
        require(record.get("frames") == size and record.get("sample_rate") == 8000 and record.get("channels") == 1, "Invalid mu-law metadata")
        actual = {"frames": size, "sample_rate": 8000, "duration_seconds": size / 8000, "channels": 1}
        require(abs(number(record.get("duration_seconds"), "mu-law duration") - size / 8000) <= 1 / 8000, "mu-law duration mismatch")
    return {"path": path, "sha256": record["sha256"], "bytes": size, **actual}


def verify_outputs(directory, outputs):
    records = outputs.get("files", [])
    require(len(records) == 3, "Expected native WAV, phone WAV and raw mu-law")
    assets = {}
    for record in records:
        filename = record.get("filename", "")
        role = "native" if filename.endswith("-native.wav") else "phone" if filename.endswith("-phone-8k.wav") else "ulaw" if filename.endswith("-phone-8k.ulaw") else None
        require(role is not None and role not in assets, "Unknown or duplicate audio output")
        assets[role] = verify_asset(directory, record)
    require(set(assets) == {"native", "phone", "ulaw"}, "Missing audio format")
    require(assets["native"]["subtype"] == "FLOAT" and assets["phone"]["subtype"] == "PCM_16"
            and assets["phone"]["sample_rate"] == 8000, "Expected unchanged FLOAT native and phone PCM16")
    require(assets["phone"]["frames"] == assets["ulaw"]["frames"], "Phone WAV/mu-law frames differ")
    require(abs(assets["native"]["duration_seconds"] - assets["phone"]["duration_seconds"]) <= 1 / 8000, "Phone/native durations differ")
    return assets


def validate_run(run, passage, directory, sample_rate):
    require(run.get("status") == "generated_for_listening", "Incomplete synthesis run")
    require(isinstance(run.get("id"), str) and SAFE_NAME.fullmatch(run["id"]), "Unsafe run id")
    sentences = run.get("sentences", [])
    expected = passage["sentences"][:1] if run.get("warmup_excluded") is True else passage["sentences"]
    require([row.get("text") for row in sentences] == expected, "Sentence list differs from fixture")
    total = sum(number(row.get("generation_seconds"), "sentence generation time") for row in sentences)
    require(abs(number(run.get("sum_sentence_generation_seconds"), "sum generation time") - total) < 1e-6, "Sentence timing sum mismatch")
    require(number(run.get("passage_elapsed_seconds"), "passage elapsed") + 1e-6 >= total, "Elapsed less than synthesis sum")
    canonical = verify_outputs(directory, run.get("outputs", {}))
    replay = verify_outputs(directory, run.get("ideal_fifo_replay_outputs", {}))
    require(canonical["native"]["sample_rate"] == sample_rate, "Native sample rate changed")
    audio_seconds = canonical["native"]["duration_seconds"]
    require(abs(number(run.get("generation_rtf"), "RTF") - total / audio_seconds) < 1e-6, "RTF mismatch")
    timeline = run.get("timeline", {})
    for key in ("first_chunk_seconds", "first_voiced_data_available_seconds", "ideal_fifo_first_voiced_seconds", "buffer_starvation_seconds", "ideal_fifo_complete_seconds"):
        number(timeline.get(key), key)
    require(timeline["first_voiced_data_available_seconds"] >= timeline["first_chunk_seconds"], "Voiced data before first chunk")
    require(abs(timeline["ideal_fifo_complete_seconds"] - replay["native"]["duration_seconds"]) <= 2 / sample_rate,
            "Timing replay duration differs from schedule")
    chunks = run.get("chunks", [])
    require(bool(chunks) and sum(chunk.get("frames", 0) for chunk in chunks) == canonical["native"]["frames"], "Chunk frames do not match audio")
    previous = -1
    for chunk in chunks:
        available = number(chunk.get("available_at_seconds"), "chunk availability")
        require(available >= previous and type(chunk.get("frames")) is int and chunk["frames"] > 0, "Invalid chunk sequence")
        previous = available
    return {"run": run, "canonical": canonical, "replay": replay}


def load_benchmark(value, engine):
    path = private_path(value)
    if path.is_dir():
        path = private_path(path / "report.private.json")
    report, report_hash = read_json(path)
    require(report.get("schema") == "fixed-voice-long-form-benchmark/1" and report.get("status") == "completed_for_listening", "Benchmark not completed")
    require(report.get("engine") == engine, "Wrong benchmark engine")
    require(report.get("reference", {}).get("sha256") == PUBLIC_WAV_SHA, "Only the verified public Michael voice can be published")
    network = report.get("network", {})
    require(network.get("blocked_attempts") == 0 and network.get("python_socket_guard_active") is True, "Offline benchmark guard evidence missing")
    if engine == "pocket":
        condition = report.get("conditioning", {})
        require(condition.get("mode") == "PUBLIC_PRESET_WITHOUT_VOICE_CLONING"
                and condition.get("voice_state", {}).get("sha256") == PUBLIC_STATE_SHA
                and condition.get("reference_wav_used_for_conditioning") is False, "Pocket must use verified public Michael preset")
        require(report.get("generation_api") == "NATIVE_GENERATE_AUDIO_STREAM_WITH_EXPLICIT_SENTENCE_BOUNDARIES", "Pocket streaming API not established")
    else:
        require(report.get("generation_api") == "SENTENCE_PIPELINE_WHOLE_FILE_NOT_NATIVE_STREAMING", "Nano generation method mismatch")
        require(report.get("conditioning", {}).get("mode") == "PUBLIC_FIXED_VOICE_WAV_CONDITIONING", "Nano must use fixed public WAV")
    fixture_hash = report.get("fixtures_sha256", "")
    require(isinstance(fixture_hash, str) and SHA.fullmatch(fixture_hash), "Missing fixtures hash")
    passages = report.get("fixtures", {}).get("passages", [])
    require(len(passages) == 2 and {p.get("source_language") for p in passages} == {"en", "zh"}, "Need English and translated Chinese passages")
    ids = set()
    for passage in passages:
        require(isinstance(passage.get("id"), str) and SAFE_NAME.fullmatch(passage["id"]) and passage["id"] not in ids, "Invalid passage id")
        ids.add(passage["id"])
        require(isinstance(passage.get("sentences"), list) and len(passage["sentences"]) >= 6
                and all(isinstance(text, str) and text.strip() for text in passage["sentences"]), "Passage needs six sentences")
        meanings = passage.get("source_sentences") if passage["source_language"] == "zh" else passage.get("meanings_zh")
        require(isinstance(meanings, list) and len(meanings) == len(passage["sentences"]), "Chinese meanings/source missing")
    runs, unique, repeats = [], set(), {p["id"]: set() for p in passages}
    warmups = 0
    sample_rate = report.get("sample_rate")
    require(type(sample_rate) is int and 8000 <= sample_rate <= 48000, "Invalid model sample rate")
    for run in report.get("runs", []):
        require(run.get("id") not in unique, "Duplicate run id")
        unique.add(run.get("id"))
        passage = next((p for p in passages if p["id"] == run.get("passage_id")), None)
        require(passage is not None, "Unknown run passage")
        verified = validate_run(run, passage, path.parent, sample_rate)
        if run.get("warmup_excluded") is True:
            warmups += 1
        else:
            repeat = run.get("repeat")
            require(type(repeat) is int and repeat >= 1 and repeat not in repeats[passage["id"]], "Duplicate or invalid repeat")
            repeats[passage["id"]].add(repeat)
            runs.append(verified)
    require(warmups >= 1, "Excluded warmup missing")
    repeat_sets = list(repeats.values())
    require(repeat_sets[0] == repeat_sets[1] and len(repeat_sets[0]) >= 3
            and repeat_sets[0] == set(range(1, len(repeat_sets[0]) + 1)), "Need matching consecutive repeats, at least three per passage")
    return {"report": report, "sha256": report_hash, "runs": runs, "repeat_count": len(repeat_sets[0])}


def validate_public_assets(value):
    if value is None:
        return None
    path = private_path(value)
    manifest, manifest_hash = read_json(path)
    require(manifest.get("schema") == "public-fixed-voice-assets/1" and manifest.get("mode") == "PUBLIC_PRESET_WITHOUT_VOICE_CLONING", "Wrong public asset manifest")
    hashes = set()
    for record in manifest.get("files", []):
        relative = record.get("path", "")
        require(isinstance(relative, str) and not Path(relative).is_absolute(), "Public asset path must be relative")
        source = private_path(path.parent / relative)
        require(source.is_relative_to(path.parent) and source.is_file(), "Missing public asset or path escape")
        raw = source.read_bytes()
        require(len(raw) == record.get("bytes") and digest(raw) == record.get("sha256"), "Public asset checksum/size mismatch")
        hashes.add(record["sha256"])
    require(PUBLIC_WAV_SHA in hashes and PUBLIC_STATE_SHA in hashes, "Verified public reference and preset missing")
    return manifest_hash


def summaries(loaded, passage_id):
    rows = [v for v in loaded["runs"] if v["run"]["passage_id"] == passage_id]
    return {"trials": len(rows),
            "first_voiced_seconds_median": statistics.median(v["run"]["timeline"]["first_voiced_data_available_seconds"] for v in rows),
            "ideal_fifo_first_voiced_seconds_median": statistics.median(v["run"]["timeline"]["ideal_fifo_first_voiced_seconds"] for v in rows),
            "generation_rtf_median": statistics.median(v["run"]["generation_rtf"] for v in rows),
            "starvation_seconds_min": min(v["run"]["timeline"]["buffer_starvation_seconds"] for v in rows),
            "starvation_seconds_max": max(v["run"]["timeline"]["buffer_starvation_seconds"] for v in rows)}


def esc(value):
    return html.escape(str(value), quote=True)


def player(asset, label, key):
    return f'<div class="player"><label for="{esc(key)}">{esc(label)} <span>{asset["duration_seconds"]:.2f} 秒</span></label><audio id="{esc(key)}" controls preload="none" data-match-volume="{asset.get("playback_gain", 1):.8f}" aria-label="{esc(label)}" src="{esc(asset["filename"])}"></audio></div>'


def trial_markup(row, engine, include_replay=False):
    run = row["run"]
    key = engine + "-" + run["id"]
    if include_replay:
        return player(row["replay"]["phone"], f'第 {run["repeat"]} 次 · 等待过程模拟 · 电话音质', key + "-replay")
    return player(row["canonical"]["phone"], f'第 {run["repeat"]} 次 · 电话音质 8 kHz', key + "-phone") + player(row["canonical"]["native"], f'第 {run["repeat"]} 次 · 原始音质', key + "-native")


def engine_card(engine, rows, summary):
    name = "Nano" if engine == "nano" else "Pocket TTS"
    method = "同一份六句原稿 · 公开 Michael 声线"
    rows = sorted(rows, key=lambda row: row["run"]["repeat"])
    others = "".join('<div class="trial">' + trial_markup(row, engine) + '</div>' for row in rows[1:])
    replay = "".join(trial_markup(row, engine, True) for row in rows)
    return f'''<article class="engine {engine}"><div class="engine-title"><h3>{name}</h3><span>{len(rows)} 次实测</span></div><p class="method">{method}</p>
    {trial_markup(rows[0], engine)}<details><summary>展开其余 {len(rows)-1} 次：原始与电话音质</summary>{others}</details>
    <details><summary>查看合成耗时与等待统计</summary><dl class="metrics"><div><dt>首段有效声音数据可用 · 中位</dt><dd>{summary["first_voiced_seconds_median"]:.2f}<small> 秒</small></dd></div><div><dt>理想播放首次可听到声音 · 中位</dt><dd>{summary["ideal_fifo_first_voiced_seconds_median"]:.2f}<small> 秒</small></dd></div><div><dt>合成耗时 / 音频时长 · 中位</dt><dd>{summary["generation_rtf_median"]:.2f}<small> 倍</small></dd></div><div><dt>模拟播放中断 · 最少—最多</dt><dd>{summary["starvation_seconds_min"]:.2f}–{summary["starvation_seconds_max"]:.2f}<small> 秒</small></dd></div></dl></details>
    <details class="replay"><summary>等待过程模拟：包含开头等待与播放中断静音</summary><p>按实测音频块可用时刻，模拟“有声音就播放”的理想队列。开头可能有较长静音；此处不是实际电话录音，也没有网络、设备或翻译耗时。</p>{replay}</details></article>'''


CSS = """
:root{--navy:#152c49;--ink:#192c43;--muted:#5b6f89;--blue:#265cf5;--teal:#087c71;--line:#dce5f0;--canvas:#f3f6fa;--white:#fff;--body:'Segoe UI Variable Text','Segoe UI','Microsoft YaHei UI',sans-serif;--display:'Segoe UI Variable Display','Microsoft YaHei UI',sans-serif;--number:'Bahnschrift','Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.65 var(--body)}a{color:var(--blue)}button,input,textarea{font:inherit}button,summary{cursor:pointer}button:focus-visible,summary:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,audio:focus-visible{outline:3px solid #93b3fc;outline-offset:4px}h1,h2,h3,p{margin:0}h1,h2,h3{font-family:var(--display)}.topbar{background:var(--navy);color:#fff;padding:17px max(24px,calc((100vw - 1140px)/2));display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-size:16px;font-weight:650;letter-spacing:1px}.topbar small{display:block;color:#c2d0e1;font-size:11px;letter-spacing:0}button{min-height:42px;padding:8px 16px;border:1px solid #526b8a;border-radius:7px;background:#263f60;color:#fff}button:hover{background:#36597e}.wrap{max-width:1188px;margin:auto;padding:34px 24px 50px}.intro{max-width:880px}h1{font-size:34px;line-height:1.3;letter-spacing:-.7px}.intro>p{margin-top:14px;color:var(--muted)}.voice{display:inline-flex;gap:10px;flex-wrap:wrap;margin:20px 0 0;font-size:12px;color:#345675}.voice span{border:1px solid #d3e0ef;border-radius:5px;background:#fff;padding:4px 9px}.guide{margin:25px 0 30px;display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:18px 21px;border:1px solid #d4e2f5;border-radius:10px;background:#eaf1fc;font-size:13px;color:#38516e}.guide strong{display:block;color:var(--navy);margin-bottom:3px}.passage{margin-top:32px;background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden}.passage-heading{padding:25px 27px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:20px;align-items:start}.passage-heading h2{font-size:23px;line-height:1.4}.passage-heading p{font-size:13px;color:var(--muted);margin-top:6px}.sentence-count{font:13px var(--number);white-space:nowrap;background:#edf3fa;border-radius:6px;padding:7px 10px;color:#46637e}.comparison{display:grid;grid-template-columns:1fr 1fr}.engine{padding:25px 27px}.engine+.engine{border-left:1px solid var(--line)}.engine-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.engine-title h3{font-size:23px;color:var(--blue)}.pocket .engine-title h3{color:var(--teal)}.engine-title>span{font-size:11px;color:var(--muted)}.method{font-size:12px;color:var(--muted);margin:4px 0 20px}.player{margin:13px 0}.player label{display:flex;justify-content:space-between;gap:12px;font-size:13px;font-weight:600;margin-bottom:8px}.player label span{font:12px var(--number);color:var(--muted);white-space:nowrap}audio{display:block;width:100%;height:44px}details{margin-top:18px}summary{font-size:13px;font-weight:600;color:#385576;padding:10px 0;min-height:42px}details[open]>summary{margin-bottom:6px}.trial{border-top:1px solid var(--line);padding:6px 0 9px}.metrics{display:grid;gap:12px;margin:24px 0 0;padding:18px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.metrics>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.metrics dt{font-size:11px;color:var(--muted)}.metrics dd{margin:0;font:18px var(--number);white-space:nowrap}.metrics small{font:11px var(--body);color:var(--muted)}.replay{background:#f3f6fa;border-radius:7px;padding:0 12px}.replay p{font-size:12px;color:var(--muted);margin:0 0 16px}.script{padding:23px 27px 26px;border-top:1px solid var(--line);background:#fafcfe}.script h3{font-size:15px;margin-bottom:13px}.script ol{list-style:none;counter-reset:sentence;margin:0;padding:0;display:grid;gap:15px}.script li{counter-increment:sentence;position:relative;padding-left:36px}.script li:before{content:counter(sentence,decimal-leading-zero);position:absolute;left:0;top:2px;font:12px var(--number);color:#52759c;background:#e9f0f8;width:25px;height:23px;display:grid;place-items:center;border-radius:4px}.script .english{font-size:15px;line-height:1.65}.script .chinese{font-size:12px;color:var(--muted);margin-top:2px}.last-phrase{margin-top:17px;font-size:12px;color:#476485}.checks{padding:23px 27px;border-top:1px solid var(--line)}.checks h3{font-size:15px;margin-bottom:12px}.check-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 20px}.check-grid label{display:flex;gap:10px;align-items:flex-start;font-size:13px;cursor:pointer}.check-grid input{width:17px;height:17px;flex-shrink:0;margin-top:3px;accent-color:var(--blue)}.notes-label{display:block;font-size:12px;color:var(--muted);margin:18px 0 6px}textarea{width:100%;min-height:78px;resize:vertical;padding:11px;border:1px solid #cedbeb;border-radius:7px;background:#fbfdff;color:var(--ink);font-size:13px}.storage-note{font-size:11px;color:var(--muted);margin-top:6px}.footnote{margin-top:28px;font-size:12px;color:var(--muted);display:grid;gap:12px;max-width:1050px}.footnote strong{color:#415a75}.status{font-size:11px;color:#d3e1f1;margin-left:10px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){.topbar{padding:13px 18px}.brand{font-size:14px}.wrap{padding:25px 14px 35px}h1{font-size:28px}.guide{grid-template-columns:1fr;padding:16px}.comparison{grid-template-columns:1fr}.engine+.engine{border-left:0;border-top:1px solid var(--line)}.engine,.script,.checks{padding:20px}.passage-heading{padding:20px;gap:12px}.passage-heading h2{font-size:20px}.check-grid{grid-template-columns:1fr}.status{display:none}.metrics dt{font-size:12px}.voice{font-size:11px}.intro>p{font-size:14px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
"""


JS = """
const players=[...document.querySelectorAll('audio')];
const matchVolume=document.getElementById('match-volume');
const setVolume=player=>{player.volume=matchVolume.checked?Number(player.dataset.matchVolume):1};
players.forEach(setVolume);matchVolume.addEventListener('change',()=>players.forEach(setVolume));
players.forEach(player=>player.addEventListener('play',()=>{setVolume(player);players.forEach(other=>{if(other!==player)other.pause()});document.getElementById('play-status').textContent=player.getAttribute('aria-label')+' 正在播放'}));
players.forEach(player=>{player.addEventListener('pause',()=>{if(players.every(item=>item.paused))document.getElementById('play-status').textContent='全部已暂停'});player.addEventListener('ended',()=>{if(players.every(item=>item.paused))document.getElementById('play-status').textContent='本段已播放完毕'})});
document.getElementById('pause-all').addEventListener('click',()=>{players.forEach(player=>player.pause());document.getElementById('play-status').textContent='全部已暂停'});
const storageKey='fixed-voice-review-v1-'+document.body.dataset.fixture;
let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}')}catch(e){}
document.querySelectorAll('[data-feedback]').forEach(field=>{if(Object.hasOwn(saved,field.id)){if(field.type==='checkbox')field.checked=saved[field.id]===true;else if(typeof saved[field.id]==='string')field.value=saved[field.id]}
field.addEventListener('input',()=>{saved[field.id]=field.type==='checkbox'?field.checked:field.value;try{localStorage.setItem(storageKey,JSON.stringify(saved));document.querySelectorAll('.storage-note').forEach(n=>n.textContent='已保存到这个浏览器；不会发送到服务器。')}catch(e){document.querySelectorAll('.storage-note').forEach(n=>n.textContent='浏览器未允许保存；关闭页面前请自行保留反馈。')}})});
"""


def page_html(pair, manifest):
    report = pair["nano"]["report"]
    sections = []
    for passage in report["fixtures"]["passages"]:
        key = passage["id"]
        cards = ""
        for engine in ("nano", "pocket"):
            rows = [row for row in pair[engine]["runs"] if row["run"]["passage_id"] == key]
            cards += engine_card(engine, rows, manifest["summaries"][key][engine])
        meanings = passage["source_sentences"] if passage["source_language"] == "zh" else passage["meanings_zh"]
        script = "".join(f'<li><p class="english" lang="en">{esc(en)}</p><p class="chinese">{esc(zh)}</p></li>' for en, zh in zip(passage["sentences"], meanings))
        checks = ["每句话都清楚，没有明显吞字或粘连", "时间、数字和否定词都准确", "整段男声稳定，句与句衔接自然", "最后一句完整，没有提前结束", "电话音质仍然容易听懂", "我认可这段声音的自然度与成熟感"]
        check_html = "".join(f'<label><input data-feedback type="checkbox" id="{esc(key)}-check-{i}">{esc(text)}</label>' for i, text in enumerate(checks))
        note = "中文由助手译为固定英文稿；此处没有实时识别或翻译调用。" if passage["source_language"] == "zh" else "固定英文原稿；下方中文帮助逐句核对意思。"
        sections.append(f'''<section class="passage" aria-labelledby="{esc(key)}-title"><header class="passage-heading"><div><h2 id="{esc(key)}-title">{esc(passage.get("title_zh", key))}</h2><p>{note}</p></div><span class="sentence-count">{len(passage["sentences"])} 句连续试听</span></header>
        <div class="comparison">{cards}</div><div class="script"><h3>对照讲话内容</h3><ol>{script}</ol><p class="last-phrase">结尾请听到：<strong lang="en">{esc(passage.get("expected_final_words", passage["sentences"][-1]))}</strong></p></div>
        <div class="checks"><h3>听完后，逐项确认</h3><div class="check-grid">{check_html}</div><label class="notes-label" for="{esc(key)}-notes">哪一版更好？哪一句需要改进？</label><textarea data-feedback id="{esc(key)}-notes" placeholder="例如：Nano 第五句数字不够清楚；Pocket 整段更顺，但声线偏年轻。"></textarea><p class="storage-note">反馈只保存在这个浏览器；不会发送到服务器。</p></div></section>''')
    return f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>固定男声 · 长段试听对照</title><style>{CSS}</style></head>
    <body data-fixture="{esc(report["fixtures_sha256"][:16])}"><header class="topbar"><div class="brand">AI 电话 · 声音实验室<small>固定英文稿 / 六句连贯讲话 / 本机试听</small></div><div><span class="status" id="play-status" role="status" aria-live="polite">等待试听</span><button type="button" id="pause-all">全部暂停</button></div></header><main class="wrap">
    <div class="intro"><h1>一段话，听清楚，也听完整。</h1><p>先听电话音质，再对照原始声音。两组材料使用相同的英文句子与同名公开男声，比较 Nano 和 Pocket TTS 的长段清晰度、衔接与等待。</p><div class="voice"><span>Michael · 美国新泽西口音男声</span><span>VCTK p360 · 录制时 19 岁</span><span>成熟感仍待本人试听确认</span></div></div>
    <aside class="guide"><div><strong>默认：只比较听感</strong>下方播放器保留生成音频的原有停顿，将返回的音频直接连接；没有插入计算等待，也没有加速或删词。</div><div><strong>另看：计算等待是否打断讲话</strong>展开“等待过程模拟”才会听到开头等待与缓冲耗尽的静音。所有指标排除热身，来源于本机文本就绪后的合成。</div></aside>
    <div class="check-grid"><label><input id="match-volume" type="checkbox" checked>按相近音量试听 <small>只调播放器音量，不改音频文件</small></label></div>
    {''.join(sections)}<footer class="footnote"><details><summary>测试方法、速度指标与适用范围</summary><p><strong>如何读速度：</strong>“首段有效声音”是连续 20 毫秒、10 毫秒窗口 RMS ≥ 0.01 的能量判定；它不验证说了什么。耗时比小于 1，表示这些句子的合成总耗时小于音频时长；仍不能单独证明连续电话流畅。模拟中断不含开头等待。</p>
    <p><strong>首次可听与数据可用：</strong>生成的第一个音频块可能只有静音；数据里已有有效声音，也不表示播放已经越过前面的静音。“理想播放首次可听”包含这些原有静音，仍是理想队列的模拟时刻。</p><p><strong>音量对照：</strong>默认根据同一段、同一次、同种音质的完整音频 RMS，把较响的一版在浏览器里调低。只衰减，不放大；等待模拟沿用对应原始音频的音量比例，避免额外静音影响计算。RMS 只是近似能量匹配，不是 LUFS 或感知响度校准；取消勾选可听原始音量。</p>
    <p><strong>对照边界：</strong>Nano 使用公开 WAV 做声线条件，并逐句完整生成；Pocket 使用官方 Michael 预计算声线状态，并逐句原生流式输出。二者参考处理不同。原始 FLOAT 音频完整保留；电话版统一重采样至 8 kHz，并经过 μ-law 编码解码。这里没有真人电话、中文录音识别或实时翻译，也尚未验收音色、吞字或讲话完整性。</p></details>
    <p><strong>公开素材署名：</strong>{esc(VOICE["attribution"])}。参考素材许可 <a href="{VOICE["license_url"]}" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>；<a href="{VOICE["source_url"]}" target="_blank" rel="noopener noreferrer">Kyutai 公开声音来源</a>。试听文件为模型根据固定文字生成，电话版另经重采样与编码；未复制个人录音或模型文件。</p><p>文件完整性已核对。<a href="manifest.json">查看本页公开清单</a>；听感勾选只是本机笔记，不会自动改变电话默认声音。</p></footer></main><script>{JS}</script></body></html>'''


def build(nano_report, pocket_report, output_dir, assets_manifest=None):
    output_dir = private_path(output_dir, exists=False)
    require(not output_dir.exists(), "Output directory already exists; refuse overwrite")
    pair = {"nano": load_benchmark(nano_report, "nano"), "pocket": load_benchmark(pocket_report, "pocket")}
    left, right = pair["nano"]["report"], pair["pocket"]["report"]
    require(left["fixtures_sha256"] == right["fixtures_sha256"] and left["fixtures"] == right["fixtures"], "Benchmark fixtures differ")
    require(left["reference"]["sha256"] == right["reference"]["sha256"], "Public reference differs")
    require(pair["nano"]["repeat_count"] == pair["pocket"]["repeat_count"], "Benchmark repeat counts differ")
    asset_hash = validate_public_assets(assets_manifest)
    manifest = {"schema": "fixed-voice-review-public/1", "created_at_utc": datetime.now(timezone.utc).isoformat(),
                "scope": "LOCAL_TEXT_READY_TTS_LISTENING_NOT_LIVE_PHONE_ACCEPTANCE", "voice": VOICE,
                "source_report_sha256": {engine: loaded["sha256"] for engine, loaded in pair.items()},
                "public_assets_manifest_sha256": asset_hash, "public_reference_sha256": PUBLIC_WAV_SHA,
                "fixtures_sha256": left["fixtures_sha256"], "repeat_count": pair["nano"]["repeat_count"],
                "warmup_excluded": True, "volume_matching": "BROWSER_ATTENUATION_ONLY_CANONICAL_WHOLE_AUDIO_RMS_SAME_PASSAGE_REPEAT_FORMAT_NOT_LUFS",
                "summaries": {}, "files": []}
    for passage in left["fixtures"]["passages"]:
        manifest["summaries"][passage["id"]] = {engine: summaries(loaded, passage["id"]) for engine, loaded in pair.items()}
        for repeat in range(1, pair["nano"]["repeat_count"] + 1):
            rows = [next(row for row in pair[engine]["runs"] if row["run"]["passage_id"] == passage["id"]
                         and row["run"]["repeat"] == repeat) for engine in ("nano", "pocket")]
            for role in ("native", "phone"):
                minimum = min(row["canonical"][role]["rms"] for row in rows)
                for row in rows:
                    gain = minimum / row["canonical"][role]["rms"]
                    require(0 < gain <= 1, "Invalid listening attenuation")
                    row["canonical"][role]["playback_gain"] = gain
                    row["replay"][role]["playback_gain"] = gain
    output_dir.mkdir(parents=True, exist_ok=False)
    audio_dir = output_dir / "audio"
    audio_dir.mkdir()
    for engine, loaded in pair.items():
        for row in loaded["runs"]:
            for treatment in ("canonical", "replay"):
                for role, asset in row[treatment].items():
                    suffix = ".ulaw" if role == "ulaw" else ".wav"
                    filename = f'audio/{engine}-{row["run"]["id"]}-{treatment}-{role}{suffix}'
                    raw = asset["path"].read_bytes()
                    require(len(raw) == asset["bytes"] and digest(raw) == asset["sha256"], "Source changed after validation")
                    with (output_dir / filename).open("xb") as destination:
                        destination.write(raw)
                    asset["filename"] = filename
                    manifest["files"].append({"filename": filename, "sha256": asset["sha256"], "bytes": asset["bytes"],
                                              "duration_seconds": asset["duration_seconds"], "engine": engine,
                                              "rms": asset.get("rms"), "playback_gain": asset.get("playback_gain"),
                                              "passage_id": row["run"]["passage_id"], "repeat": row["run"]["repeat"],
                                              "treatment": treatment, "format": role})
    page = page_html(pair, manifest)
    require(str(PRIVATE_ROOT) not in page and ".runtime" not in page, "Private path leaked into HTML")
    (output_dir / "index.html").write_text(page, encoding="utf-8")
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nano-report", required=True)
    parser.add_argument("--pocket-report", required=True)
    parser.add_argument("--assets-manifest")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    manifest = build(args.nano_report, args.pocket_report, args.output_dir, args.assets_manifest)
    print(json.dumps({"status": "built_verified_listening_page", "audio_files": len(manifest["files"]),
                      "repeat_count": manifest["repeat_count"]}), flush=True)


if __name__ == "__main__":
    main()
