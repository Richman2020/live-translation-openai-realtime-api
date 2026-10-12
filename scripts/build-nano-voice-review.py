"""Build a private offline listening folder from verified Nano and RVC reports.

Copies existing audio without synthesis, normalization, playback or networking.
Nano and RVC retain separate report schemas and timing definitions. This page
does not certify voice similarity, naturalness, translation or live-call latency.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
import math
from pathlib import Path
import re
import struct
import sys


REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROOT = (REPO / ".runtime").resolve()
DEFAULT_RUN = PRIVATE_ROOT / "own-voice/20260927-070927"
SHA_PATTERN = re.compile(r"[a-f0-9]{64}")
MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_AUDIO_BYTES = 12 * 1024 * 1024
FIXTURES = {
    "three-sentences": "Hello, thank you for calling. I finish work at five, so we can talk this evening. Please tell me what time is good for you.",
    "availability": "Could you tell me what time works best for you?",
    "negation-time": "I do not need coffee. The appointment is tomorrow at three, not today.",
}
MEANINGS = {
    "three-sentences": "你好，谢谢你来电。我五点下班，我们可以今晚聊。请告诉我什么时间方便。",
    "availability": "你能告诉我，什么时间对你最合适吗？",
    "negation-time": "我不需要咖啡。预约在明天三点，不是今天。",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def private_path(value, exists=True):
    path = Path(value).resolve(strict=exists)
    require(path != PRIVATE_ROOT and path.is_relative_to(PRIVATE_ROOT),
            "All input and output paths must remain under this project's private .runtime")
    return path


def escape(value):
    return html.escape(str(value), quote=True)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def duration(value, label):
    require(finite_number(value) and value >= 0, "Invalid " + label)
    return float(value)


def load_report(value):
    path = private_path(value)
    if path.is_dir():
        path = private_path(path / "report.private.json")
    require(path.is_file() and path.stat().st_size <= MAX_REPORT_BYTES, "Invalid or oversized report")
    raw = path.read_bytes()
    require(len(raw) <= MAX_REPORT_BYTES, "Report grew beyond the size limit")
    report = json.loads(raw.decode("utf-8-sig"))
    require(isinstance(report, dict), "Expected a JSON report object")
    return {"path": path, "raw": raw, "sha256": hashlib.sha256(raw).hexdigest(), "report": report}


def wav_metadata(raw):
    """Read mono PCM16/FLOAT32 WAV headers and data, without third-party imports."""
    require(44 <= len(raw) <= MAX_AUDIO_BYTES and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE",
            "Invalid WAV header or size")
    require(struct.unpack_from("<I", raw, 4)[0] + 8 == len(raw), "RIFF size mismatch")
    offset, fmt, samples = 12, None, None
    while offset + 8 <= len(raw):
        kind, size = struct.unpack_from("<4sI", raw, offset)
        start = offset + 8
        end = start + size
        require(end <= len(raw), "Truncated WAV chunk")
        if kind == b"fmt ":
            require(fmt is None and size >= 16, "Duplicate or invalid format chunk")
            fmt = struct.unpack_from("<HHIIHH", raw, start)
        elif kind == b"data":
            require(samples is None, "Duplicate audio data chunk")
            samples = raw[start:end]
        offset = end + (size % 2)
    require(offset == len(raw) and fmt is not None and samples is not None, "Incomplete WAV structure")
    encoding, channels, rate, byte_rate, alignment, bits = fmt
    require(channels == 1 and (encoding, bits) in ((1, 16), (3, 32)), "Expected mono PCM16 or FLOAT32 WAV")
    require(8000 <= rate <= 48000 and alignment == bits // 8 and byte_rate == rate * alignment,
            "Invalid WAV sampling format")
    require(len(samples) > 0 and len(samples) % alignment == 0, "Truncated or empty audio frames")
    frames = len(samples) // alignment
    require(0 < frames / rate <= 120, "Audio duration is out of bounds")
    scale = 32768 if encoding == 1 else 1
    peak, energy = 0.0, 0.0
    for (value,) in struct.iter_unpack("<h" if encoding == 1 else "<f", samples):
        value = value / scale
        require(math.isfinite(value), "Audio contains nonfinite samples")
        peak = max(peak, abs(value))
        energy += value * value
    require(peak > 0, "Audio is entirely silent")
    return {"frames": frames, "sample_rate": rate, "duration_seconds": frames / rate,
            "channels": channels, "subtype": "PCM_16" if encoding == 1 else "FLOAT",
            "peak": peak, "rms": math.sqrt(energy / frames)}


def asset(directory, filename, expected, destination):
    require(isinstance(filename, str) and Path(filename).name == filename and filename.lower().endswith(".wav"),
            "Invalid WAV manifest filename")
    path = private_path(directory / filename)
    require(path.parent == directory and path.is_file() and path.stat().st_size <= MAX_AUDIO_BYTES,
            "Audio escaped its report directory or is oversized")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    require(isinstance(expected, dict) and expected.get("sha256") == digest, "WAV hash mismatch: " + filename)
    metadata = wav_metadata(raw)
    require(expected.get("frames") == metadata["frames"] and expected.get("sample_rate") == metadata["sample_rate"],
            "WAV frame or sample-rate metadata mismatch: " + filename)
    seconds = expected.get("duration_seconds")
    require(finite_number(seconds) and abs(seconds - metadata["duration_seconds"]) <= 1 / metadata["sample_rate"],
            "WAV duration metadata mismatch: " + filename)
    if "channels" in expected:
        require(expected["channels"] == 1, "Expected mono manifest")
    if "subtype" in expected:
        require(expected["subtype"] == metadata["subtype"], "WAV subtype metadata mismatch")
    if "bytes" in expected:
        require(expected["bytes"] == len(raw), "WAV byte count metadata mismatch")
    return {"filename": destination, "source_filename": filename, "sha256": digest,
            "bytes": len(raw), "raw": raw, **metadata}


def validate_pair(native, phone):
    require(phone["sample_rate"] == 8000 and phone["subtype"] == "PCM_16", "Expected 8 kHz PCM16 phone roundtrip")
    require(abs(native["duration_seconds"] - phone["duration_seconds"]) <= 1 / 8000,
            "Native and phone audio durations differ")


def load_rvc(value, role):
    loaded = load_report(value)
    report = loaded["report"]
    require(report.get("schema") == "own-voice-offline-sample/1.0" and report.get("status") == "completed"
            and report.get("scope") == "LOCAL_FULL_FILE_SAMPLE_NOT_PHONE_OR_STREAMING_ACCEPTANCE",
            "Expected a completed RVC offline sample report")
    checkpoint = report.get("checkpoint", {})
    metadata = checkpoint.get("own_voice_metadata", {})
    require(checkpoint.get("role") == "OWN_VOICE_TRAINED_CANDIDATE"
            and metadata.get("role") == "own-voice-local-trained"
            and type(metadata.get("training_steps")) is int and metadata["training_steps"] > 0
            and metadata.get("quality_accepted") is False
            and SHA_PATTERN.fullmatch(str(checkpoint.get("sha256", ""))),
            "RVC base or accepted models cannot be mislabeled as unaccepted own-voice candidates")
    require(report.get("settings", {}).get("allow_base_control") is False, "Base control is not a personal voice")
    source = report.get("source", {})
    require(source.get("text") == FIXTURES["three-sentences"] and source.get("language") == "en-US"
            and SHA_PATTERN.fullmatch(str(source.get("sha256", ""))), "RVC source does not match the three-sentence fixture")
    measurement = report.get("measurement", {})
    require(measurement.get("ready_for_listening_only") is True, "RVC report is not ready for listening")
    retrieval = report.get("retrieval", {})
    require(retrieval.get("enabled") is (role == "candidate"), "RVC baseline/candidate retrieval role mismatch")
    outputs = report.get("outputs", {})
    prefix = "rvc-a" if role == "baseline" else "rvc-c"
    directory = loaded["path"].parent
    native = asset(directory, "converted-32k.wav", outputs.get("converted-32k.wav"), prefix + "-native.wav")
    phone = asset(directory, "converted-phone-8k.wav", outputs.get("converted-phone-8k.wav"), prefix + "-phone-8k.wav")
    require(native["sample_rate"] == 32000, "Expected existing RVC 32 kHz output")
    validate_pair(native, phone)
    timing = report.get("timings_seconds", {})
    model_load = sum(duration(timing.get(key), key) for key in ("decoder_load", "hubert_load", "rmvpe_load"))
    return {"id": prefix, "title": "旧版 A · 原基准" if role == "baseline" else "旧版 C · 调整候选",
            "description": "把电脑合成的英语声音转换成本人声线候选。", "engine": "RVC",
            "fixture_id": "three-sentences", "text": source["text"], "assets": [native, phone],
            "generation_seconds": duration(measurement.get("whole_file_compute_seconds"), "RVC compute time"),
            "generation_label": "整段变声用时", "model_load_seconds": model_load,
            "source_sha256": source["sha256"], "checkpoint_sha256": checkpoint["sha256"],
            "report": loaded, "warnings": []}


def load_nano(value):
    loaded = load_report(value)
    report = loaded["report"]
    require(report.get("schema") == "chatterbox-nano-offline-probe/1"
            and report.get("status") == "completed_for_listening"
            and report.get("scope") == "LOCAL_CPU_WHOLE_FILE_OWN_VOICE_LISTENING_EXPERIMENT",
            "Expected a completed Nano report; RVC or partial reports are not interchangeable")
    model = report.get("model", {})
    require(model.get("repository") == "ResembleAI/chatterbox-nano" and model.get("nano") is True
            and model.get("device") == "cpu", "Expected a local CPU Nano experiment")
    require(report.get("conditioning", {}).get("explicit_reference") is True
            and report.get("reference", {}).get("uploaded") is False
            and SHA_PATTERN.fullmatch(str(report.get("reference", {}).get("sha256", ""))),
            "Missing explicit private own-voice conditioning evidence")
    require(report.get("watermark", {}).get("official_generate_apply_watermark_retained") is True,
            "Missing official watermark preservation metadata")
    require(report.get("network", {}).get("blocked_attempts") == 0, "Nano run reported blocked network attempts")
    require(report.get("acceptance", {}).get("quality_accepted") is False, "Expected unaccepted Nano candidate")
    fixtures = report.get("fixtures")
    require(isinstance(fixtures, list) and len(fixtures) == 3, "Expected all three completed Nano fixtures")
    by_id = {entry.get("id"): entry for entry in fixtures if isinstance(entry, dict)}
    require(set(by_id) == set(FIXTURES), "Nano fixture IDs are incomplete or duplicated")
    groups = []
    for fixture_id, text in FIXTURES.items():
        entry = by_id[fixture_id]
        require(entry.get("status") == "generated_for_listening" and entry.get("text") == text
                and entry.get("streaming") is False and entry.get("quality_accepted") is False,
                "Invalid Nano fixture status or fixed text")
        files = entry.get("outputs", {}).get("files")
        require(isinstance(files, list), "Missing Nano output file list")
        names = [item.get("filename") for item in files if isinstance(item, dict)]
        require(len(names) == len(files) and len(set(names)) == len(names), "Duplicate or malformed Nano outputs")
        records = {item["filename"]: item for item in files}
        native_name, phone_name = fixture_id + "-native.wav", fixture_id + "-phone-8k.wav"
        prefix = "nano-" + fixture_id
        native = asset(loaded["path"].parent, native_name, records.get(native_name), prefix + "-native.wav")
        phone = asset(loaded["path"].parent, phone_name, records.get(phone_name), prefix + "-phone-8k.wav")
        validate_pair(native, phone)
        warnings = entry.get("warnings", [])
        require(isinstance(warnings, list) and all(isinstance(item, str) for item in warnings), "Invalid Nano warnings")
        groups.append({"id": prefix, "title": {
            "three-sentences": "新版 Nano · 连贯三句", "availability": "新版 Nano · 问句",
            "negation-time": "新版 Nano · 否定与时间"}[fixture_id],
            "description": "直接用文字和本人参考录音，在这台电脑上生成英语声音。",
            "engine": "Chatterbox Nano", "fixture_id": fixture_id, "text": text,
            "assets": [native, phone], "generation_seconds": duration(entry.get("generate_wall_seconds"), "Nano generation time"),
            "generation_label": "整段合成用时", "warnings": warnings, "report": loaded})
    return groups, {"model_load_seconds": duration(report.get("model_load_seconds"), "Nano load time"),
                    "conditioning_seconds": duration(report.get("conditioning_seconds"), "Nano conditioning time"),
                    "total_wall_seconds": duration(report.get("total_wall_seconds"), "Nano total time")}


def audio_card(group):
    players = []
    for index, item in enumerate(group["assets"]):
        label = "原生声音" if index == 0 else "电话编码后声音"
        players.append(f'<div class="player"><label>{label}</label><audio controls preload="none" '
                       f'aria-label="{escape(group["title"] + " · " + label)}" src="audio/{escape(item["filename"])}"></audio>'
                       f'<small>{item["duration_seconds"]:.2f} 秒</small></div>')
    warning = '<p class="warning">生成报告有检查提醒，请特别核对尾句是否完整、是否出现破音；这段声音尚未验收。</p>' if group["warnings"] else ""
    return (f'<article class="card"><h3>{escape(group["title"])}</h3><p>{escape(group["description"])}</p>'
            + "".join(players) + warning
            + f'<p class="timing">{escape(group["generation_label"])}：{group["generation_seconds"]:.2f} 秒 '
              '（整段计算，不是电话等待时间）</p></article>')


def build_html(groups, timings, created):
    shared = "".join(audio_card(group) for group in groups if group["fixture_id"] == "three-sentences")
    extra = []
    for fixture_id in ("availability", "negation-time"):
        group = next(group for group in groups if group["fixture_id"] == fixture_id)
        extra.append(f'<section><h2>{"再听一句问话" if fixture_id == "availability" else "核对否定和时间"}</h2>'
                     f'<p class="script" lang="en">{escape(FIXTURES[fixture_id])}</p>'
                     f'<p class="meaning">{escape(MEANINGS[fixture_id])}</p>{audio_card(group)}</section>')
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self' file:; base-uri 'none'; form-action 'none'; connect-src 'none'">
<title>本人声线 · 新旧版试听</title><style>
:root{{color-scheme:light;--ink:#1b293b;--muted:#576779;--line:#dce3eb;--accent:#245ac0}}
*{{box-sizing:border-box}}body{{margin:0;background:#f4f6f9;color:var(--ink);font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}}
main{{max-width:1120px;margin:auto;padding:48px 24px 64px}}h1{{font-size:34px;line-height:1.3;margin:10px 0 18px}}h2{{font-size:23px;margin:0 0 15px}}h3{{font-size:19px;margin:0 0 10px}}
p{{margin:8px 0 14px}}.eyebrow{{color:var(--accent);font-weight:700;font-size:14px;letter-spacing:.05em}}.intro{{max-width:850px;color:var(--muted)}}
.notice{{background:#e9f0fc;border-left:4px solid var(--accent);padding:16px 20px;margin:24px 0;border-radius:8px}}section{{margin-top:36px}}
.script{{background:#fff;border:1px solid var(--line);padding:18px 20px;border-radius:12px;font-size:18px;color:#263a54}}.meaning{{color:var(--muted)}}
.grid{{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}}.card{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;margin:16px 0}}
.card>p{{color:var(--muted);font-size:14px}}.player{{margin:20px 0}}.player label{{display:block;font-size:14px;font-weight:650;margin-bottom:8px}}audio{{width:100%}}small{{display:block;color:var(--muted);font-size:12px}}
.timing{{border-top:1px solid var(--line);padding-top:13px;font-size:12px!important}}.warning{{color:#8b4c0f!important;background:#fff4df;padding:12px;border-radius:8px}}
.checks{{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px}}.checks li{{margin:9px 0}}details{{margin-top:26px;color:var(--muted);font-size:14px}}summary{{cursor:pointer;font-weight:650}}
footer{{border-top:1px solid var(--line);margin-top:36px;padding-top:18px;font-size:13px;color:var(--muted)}}@media(max-width:850px){{.grid{{grid-template-columns:1fr}}main{{padding:28px 16px}}h1{{font-size:29px}}}}
</style></head><body><main>
<div class="eyebrow">本机私密试听 · 等你确认听感</div><h1>同一句话，哪一种更顺？</h1>
<p class="intro">先比较连贯三句里的停顿、语气和机械感，再听问句和否定句。每组先听“原生声音”，再听“电话编码后声音”。切换播放时，上一段会自动暂停。</p>
<div class="notice">这些是已经生成的整段音频，声音自然度、像不像你、内容是否完整都还待你试听确认。当前没有接入电话，也没有测得实时通话延迟。</div>
<section><h2>同样的连贯三句</h2><p class="script" lang="en">{escape(FIXTURES['three-sentences'])}</p>
<p class="meaning">{escape(MEANINGS['three-sentences'])}</p><div class="grid">{shared}</div></section>
{''.join(extra)}
<section class="checks"><h2>听完只需要判断这几件事</h2><ul>
<li>相比 A 和 C，Nano 的机械感是否减轻？语调和句间停顿是否更自然？</li>
<li>连续三句是否顺畅、尾句完整，声线是否接近你并保持一致？</li>
<li>是否清楚说出了“五点下班”“不需要咖啡”“明天三点，不是今天”？问句听起来是否像在询问？</li>
<li>电话编码后，清晰度和自然程度是否仍可接受？</li></ul></section>
<details><summary>关于生成用时和这次试听的范围</summary>
<p>Nano 模型加载：{timings['model_load_seconds']:.2f} 秒；本人参考准备：{timings['conditioning_seconds']:.2f} 秒。以上只做一次，不计入每段卡片的合成用时。Nano 本次程序总用时：{timings['total_wall_seconds']:.2f} 秒。</p>
<p>旧版处理现成的英语声音，新版直接从文字生成，运行设备也不同。卡片中的耗时仅说明各自本机运行负担，不能当成同条件速度排名；它不包括真实电话的输入、翻译和传输等待。</p>
<p>“电话编码后”仅指 8 kHz μ-law 编码再解码，没有经过真实电话线路。Nano 保留官方音频水印，原生文件未经此页面再次处理。音频与报告的哈希、帧数和时长在构建页面时已核对；这些检查不能代替真人听感判断。</p>
</details><footer>页面生成时间（UTC）：{escape(created)}。全部声音保存在此目录的 audio 文件夹，无需联网。请保留整个目录；本人音频及私密证据不应上传到公开仓库。</footer>
</main><script>document.querySelectorAll('audio').forEach(current=>current.addEventListener('play',()=>{{document.querySelectorAll('audio').forEach(other=>{{if(other!==current)other.pause();}});}}));</script></body></html>'''


def build(nano_report, baseline, candidate, output_dir):
    output = private_path(output_dir, exists=False)
    require(not output.exists(), "Output directory already exists; no overwrite allowed")
    old_a, old_c = load_rvc(baseline, "baseline"), load_rvc(candidate, "candidate")
    require(old_a["source_sha256"] == old_c["source_sha256"]
            and old_a["checkpoint_sha256"] == old_c["checkpoint_sha256"],
            "RVC A/C must use the same source and personal checkpoint")
    nano, timings = load_nano(nano_report)
    groups = [old_a, old_c, *nano]
    require(sum(item["bytes"] for group in groups for item in group["assets"]) < 100 * 1024 * 1024,
            "Listening folder exceeds the audio size budget")
    created = datetime.now(timezone.utc).isoformat()
    page = build_html(groups, timings, created)
    # Validate every input before creating this new output directory.
    output.mkdir(parents=True, exist_ok=False)
    (output / "audio").mkdir()
    (output / "evidence").mkdir()
    manifest = {"schema": "nano-rvc-private-listening-review/1", "created_at_utc": created,
                "status": "ready_for_listening_only", "quality_accepted": False,
                "scope": "LOCAL_COPIED_AUDIO_FULL_FILE_COMPARISON_NOT_LIVE_PHONE",
                "source_reports": [], "audio": [], "nano_timings_seconds": timings}
    for label, loaded in (("rvc-a", old_a["report"]), ("rvc-c", old_c["report"]), ("nano", nano[0]["report"])):
        filename = label + "-report.private.json"
        with (output / "evidence" / filename).open("xb") as destination:
            destination.write(loaded["raw"])
        manifest["source_reports"].append({"filename": "evidence/" + filename,
                                            "sha256": loaded["sha256"], "schema": loaded["report"]["schema"]})
    for group in groups:
        for item in group["assets"]:
            path = output / "audio" / item["filename"]
            with path.open("xb") as destination:
                destination.write(item["raw"])
            require(hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], "Copied audio hash mismatch")
            manifest["audio"].append({"group": group["id"], "engine": group["engine"],
                                       "fixture_id": group["fixture_id"],
                                       **{key: value for key, value in item.items() if key != "raw"}})
    (output / "index.html").write_text(page, encoding="utf-8")
    manifest["page_sha256"] = hashlib.sha256((output / "index.html").read_bytes()).hexdigest()
    (output / "review-manifest.private.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    return output / "index.html"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nano-report", required=True, type=Path)
    parser.add_argument("--rvc-baseline", type=Path, default=DEFAULT_RUN / "sample-0579-three-sentences-A")
    parser.add_argument("--rvc-candidate", type=Path, default=DEFAULT_RUN / "sample-0579-three-sentences-C")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        page = build(args.nano_report, args.rvc_baseline, args.rvc_candidate, args.output_dir)
        print(json.dumps({"status": "ready_for_listening_only", "page": str(page),
                          "audio_files": 10, "human_acceptance": "PENDING"}, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print("Review page not completed: " + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
