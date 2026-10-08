"""Build a self-contained private listening page for completed own-voice candidates.

All WAV data is embedded, hash checked and kept local. No playback, network,
model execution, microphone access or acceptance decision is performed.
"""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import html
import io
import json
import math
from pathlib import Path
import re
import struct
import sys
import wave


REPO = Path(__file__).resolve().parent.parent
PRIVATE_ROOT = (REPO / ".runtime").resolve()
MAX_HTML_BYTES = 20 * 1024 * 1024
HEX_SHA = re.compile(r"[a-f0-9]{64}")
FILES = (("source-original.wav", "01 · 合成英语原声", "对照原句是否完整，声音来自电脑的英语合成器。"),
         ("converted-32k.wav", "02 · 本人声线候选", "用你的录音训练后生成，先听是否像你、发音是否清楚。"),
         ("converted-phone-8k.wav", "03 · 电话编码后候选", "同一声音经 8 kHz μ-law 编码再解码；尚未经过真实电话线路。"))
SOURCE_MEANINGS = {
    "Could you repeat that number, please?": "请再重复一下那个数字，好吗？",
    "I finish work at five.": "我五点下班。",
    "I do not need coffee. The appointment is tomorrow at three.": "我不需要咖啡。预约在明天三点。",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def escape(value):
    return html.escape(str(value), quote=True)


def private_path(value, exists=True):
    path = Path(value).resolve(strict=exists)
    require(path.is_relative_to(PRIVATE_ROOT) and path != PRIVATE_ROOT,
            "inputs and output must remain below this repository's private .runtime")
    return path


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def wav_asset(path, expected=None, maximum_seconds=15):
    require(path.suffix.lower() == ".wav" and path.is_file(), "expected a local WAV file")
    require(44 <= path.stat().st_size <= 6 * 1024 * 1024, "WAV file size is out of bounds")
    raw = path.read_bytes()
    require(raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
            and struct.unpack_from("<I", raw, 4)[0] + 8 == len(raw), "invalid RIFF size/header")
    digest = hashlib.sha256(raw).hexdigest()
    with wave.open(io.BytesIO(raw), "rb") as source:
        require(source.getnchannels() == 1 and source.getsampwidth() == 2
                and source.getcomptype() == "NONE", "review audio must be uncompressed mono PCM16")
        rate, frames = source.getframerate(), source.getnframes()
        require(8000 <= rate <= 48000 and 0 < frames / rate <= maximum_seconds,
                "WAV duration/sample rate is out of bounds")
        require(len(source.readframes(frames + 1)) == frames * 2, "WAV data is truncated")
    if expected is not None:
        require(isinstance(expected, dict) and expected.get("sha256") == digest,
                f"output checksum mismatch: {path.name}")
        require(expected.get("sample_rate") == rate and expected.get("frames") == frames,
                f"output format metadata mismatch: {path.name}")
        seconds = expected.get("duration_seconds")
        require(finite_number(seconds) and abs(seconds - frames / rate) <= 1 / rate,
                f"output duration metadata mismatch: {path.name}")
    return {"uri": "data:audio/wav;base64," + base64.b64encode(raw).decode("ascii"),
            "sha256": digest, "seconds": frames / rate, "rate": rate, "raw_bytes": len(raw)}


def load_candidate(value):
    directory = private_path(value)
    require(directory.is_dir(), "each run must be a directory")
    report_path = private_path(directory / "report.private.json")
    require(report_path.parent == directory and report_path.stat().st_size <= 1024 * 1024,
            "report is oversized or outside its run")
    report_bytes = report_path.read_bytes()
    require(len(report_bytes) <= 1024 * 1024, "report grew beyond the size limit")
    report = json.loads(report_bytes.decode("utf-8-sig"))
    require(isinstance(report, dict) and report.get("schema") == "own-voice-offline-sample/1.0"
            and report.get("status") == "completed"
            and report.get("scope") == "LOCAL_FULL_FILE_SAMPLE_NOT_PHONE_OR_STREAMING_ACCEPTANCE",
            "only successfully completed offline sample reports may be reviewed")
    checkpoint = report.get("checkpoint", {})
    require(isinstance(checkpoint, dict), "invalid checkpoint metadata")
    metadata = checkpoint.get("own_voice_metadata", {})
    require(isinstance(metadata, dict), "invalid own-voice metadata")
    require(checkpoint.get("role") == "OWN_VOICE_TRAINED_CANDIDATE"
            and metadata.get("role") == "own-voice-local-trained",
            "unpersonalized base controls cannot be presented as own-voice candidates")
    steps = metadata.get("training_steps")
    require(type(steps) is int and steps > 0 and metadata.get("quality_accepted") is False,
            "expected an unaccepted model with actual positive training steps")
    require(isinstance(checkpoint.get("sha256"), str) and HEX_SHA.fullmatch(checkpoint["sha256"]),
            "missing checkpoint hash")
    source = report.get("source", {})
    require(isinstance(source, dict), "invalid synthetic source metadata")
    require(source.get("kind") in ("HASH_BOUND_WINDOWS_SAPI_SYNTHETIC", "DECLARED_WINDOWS_SAPI_SYNTHETIC")
            and source.get("language") == "en-US" and isinstance(source.get("text"), str)
            and 0 < len(source["text"].strip()) <= 2500, "missing declared synthetic English source text")
    features = report.get("features", {})
    require(isinstance(features, dict), "invalid feature settings")
    semitones = features.get("semitones")
    require(finite_number(semitones) and -12 <= semitones <= 12
            and features.get("f0_mode") in ("preserve-unvoiced", "interpolate"),
            "invalid pitch comparison settings")
    measurement = report.get("measurement", {})
    require(isinstance(measurement, dict) and measurement.get("ready_for_listening_only") is True,
            "sample is not marked ready for listening")
    assets = []
    outputs = report.get("outputs", {})
    require(isinstance(outputs, dict), "missing output manifest")
    for filename, title, description in FILES:
        path = private_path(directory / filename)
        require(path.parent == directory, "audio escaped its run directory")
        expected = outputs.get(filename)
        require(isinstance(expected, dict), f"missing output manifest entry: {filename}")
        asset = wav_asset(path, expected)
        if filename == "converted-32k.wav":
            require(asset["rate"] == 32000, "candidate output must be 32 kHz")
        if filename == "converted-phone-8k.wav":
            require(asset["rate"] == 8000, "telephone-codec output must be 8 kHz")
        assets.append({**asset, "title": title, "description": description})
    require(max(item["seconds"] for item in assets) - min(item["seconds"] for item in assets) <= 1 / 8000,
            "comparison audio durations differ")
    return {"name": directory.name, "text": source["text"], "steps": steps,
            "semitones": semitones, "f0_mode": features["f0_mode"], "assets": assets,
            "checkpoint_sha256": checkpoint["sha256"],
            "report_sha256": hashlib.sha256(report_bytes).hexdigest()}


def audio_card(asset, label):
    return (f'<div class="audio-card"><h3>{escape(asset["title"])}</h3>'
            f'<p>{escape(asset["description"])}</p><audio controls preload="none" '
            f'aria-label="{escape(label)}" src="{asset["uri"]}"></audio>'
            f'<span class="duration">{asset["seconds"]:.2f} 秒 · {asset["rate"] // 1000} kHz</span></div>')


def build_page(candidates, reference=None):
    cards = []
    if reference:
        asset = {**reference, "title": "你的原始录音 · 保留参考",
                 "description": "先听这段，记住自己的自然声线，再比较下面的英语候选。原文件未修改。"}
        cards.append('<section class="reference">' + audio_card(asset, "本人原声参考") + '</section>')
    for index, candidate in enumerate(candidates, 1):
        audios = "".join(audio_card(asset, f"第 {index} 组 · {asset['title']}") for asset in candidate["assets"])
        meaning = SOURCE_MEANINGS.get(candidate["text"])
        meaning_hint = f'<p>固定测试句的意思：{escape(meaning)}</p>' if meaning else ""
        details = (f'<details><summary>查看本组实验参数</summary><dl>'
                   f'<dt>本机训练累计更新</dt><dd>{candidate["steps"]} 步</dd>'
                   f'<dt>音高调整</dt><dd>{candidate["semitones"]:+g} 半音</dd>'
                   f'<dt>无声段音高处理</dt><dd>{escape(candidate["f0_mode"])}</dd>'
                   f'<dt>本组名称</dt><dd>{escape(candidate["name"])}</dd>'
                   f'<dt>模型 SHA256</dt><dd class="hash">{escape(candidate["checkpoint_sha256"])}</dd>'
                   f'<dt>生成报告 SHA256</dt><dd class="hash">{escape(candidate["report_sha256"])}</dd>'
                   '</dl><p>以上是实验记录。训练步数、声音文件成功生成及编码通过，不代表声线相似度或电话表现已经通过。</p></details>')
        cards.append(f'<section class="candidate"><div class="section-top"><span class="eyebrow">对照 {index:02d}</span>'
                     f'<span class="badge">待你试听</span></div><h2>同一句话，比较三段声音</h2>'
                     f'<blockquote lang="en">{escape(candidate["text"])}</blockquote>'
                     f'{meaning_hint}<div class="audio-grid">{audios}</div>{details}</section>')
    created = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'">
<title>本人声线 · 本地试听对照</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#18322c;background:#f3f5f0;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:44px 24px 60px}.eyebrow{font-size:12px;letter-spacing:.12em;color:#477465;font-weight:700}h1{font-size:clamp(28px,4vw,42px);letter-spacing:-.04em;line-height:1.2;margin:16px 0}h2{font-size:23px;margin:16px 0}h3{font-size:16px;margin:0 0 10px}p{line-height:1.7;color:#52645e}header>p{max-width:780px;margin:14px 0 26px}.intro-note{background:#e4ede6;border:1px solid #c9dccd;border-radius:14px;padding:18px 22px;line-height:1.8}.criteria{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0 30px}.criterion{background:#fff;border:1px solid #e0e6dc;border-radius:14px;padding:18px}.criterion strong{display:block;margin-bottom:8px}.criterion p{margin:0;font-size:14px}.candidate,.reference{background:white;border:1px solid #d8e1d7;border-radius:20px;padding:26px;margin:22px 0;box-shadow:0 8px 28px #14382805}.reference{max-width:580px;background:#fafdF9}.section-top{display:flex;align-items:center;justify-content:space-between}.badge{border-radius:20px;padding:5px 12px;background:#fff1d4;color:#7f590e;font-size:12px;font-weight:650}blockquote{margin:18px 0 24px;padding:20px 22px;border-left:3px solid #729a80;background:#f5f8f3;font-size:19px;line-height:1.65;color:#21362d;overflow-wrap:anywhere}.audio-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.audio-card{min-width:0}.audio-grid .audio-card{padding:18px;background:#f7f8f5;border:1px solid #e4e9df;border-radius:14px}.audio-card p{font-size:13px;min-height:44px;margin:0 0 15px}audio{display:block;width:100%;height:42px}.duration{display:block;margin-top:10px;font-size:12px;color:#748078}details{margin-top:24px;border-top:1px solid #e3e8df;padding-top:16px;color:#68776e;font-size:13px}summary{cursor:pointer;color:#406250}dl{display:grid;grid-template-columns:160px 1fr;gap:9px 15px;margin-top:20px}dt{color:#728177}dd{margin:0;overflow-wrap:anywhere}.hash{font-family:ui-monospace,monospace;font-size:11px}footer{font-size:12px;color:#738177;line-height:1.8;margin-top:28px}@media(max-width:800px){.audio-grid,.criteria{grid-template-columns:1fr}.audio-card p{min-height:auto}main{padding:28px 16px}.candidate,.reference{padding:20px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}}
</style></head><body><main>
<header><span class="eyebrow">本机声音实验 / 试听对照</span><h1>先听像不像你，再听是否清楚。</h1>
<p>这些是用你的录音训练后生成的英语声线候选。下面同时保留合成英语原声和电话编码后的版本，供你逐段比较。尚未认定克隆成功，也没有接入电话主线路。</p></header>
<div class="intro-note"><strong>试听顺序：</strong>先听本人原声参考（如有），再在每组内按 01 → 02 → 03 播放。每次只播放一段，保持相同耳机和音量。这里的英语原文已固定，本页不测试翻译准确度。</div>
<div class="criteria"><div class="criterion"><strong>1. 声线像不像自己</strong><p>比较整体声线和音色，留意是否仍像原来的合成声音，是否忽男忽女。</p></div><div class="criterion"><strong>2. 句子是否清楚完整</strong><p>对照英文原句，听数字、否定词及句尾有没有变糊、漏掉或拉长。</p></div><div class="criterion"><strong>3. 有没有异常声音</strong><p>留意金属音、抖动、杂音和突变，再比较电话编码后是否更明显。</p></div></div>
''' + "".join(cards) + f'''<footer>生成时间：{created}。声音已内嵌在这份本地文件中，无外部资源、自动播放、麦克风采集或上传。<br>所有候选均为“待人工试听”；本页不保存评分，也不代表真实电话延迟、识别或翻译验收。</footer></main></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", required=True, nargs="+", type=Path,
                        help="Completed own-voice inference directories with report.private.json")
    parser.add_argument("--output", required=True, type=Path, help="New private standalone HTML; never overwrite")
    parser.add_argument("--reference", type=Path, help="Optional explicitly selected raw own-voice reference WAV, at most 30s")
    args = parser.parse_args()
    try:
        require(1 <= len(args.runs) <= 12, "expected 1..12 candidate runs")
        output = private_path(args.output, exists=False)
        require(output.suffix.lower() == ".html" and output.parent.is_dir() and not output.exists(),
                "output must be a new HTML file in an existing private directory")
        candidates, seen, embedded_bytes = [], set(), 0
        for directory in args.runs:
            resolved = private_path(directory)
            require(resolved not in seen, "duplicate candidate directory")
            seen.add(resolved)
            candidate = load_candidate(resolved)
            embedded_bytes += sum(len(asset["uri"]) for asset in candidate["assets"])
            require(embedded_bytes < MAX_HTML_BYTES, "embedded audio exceeds the 20 MiB page limit")
            candidates.append(candidate)
        reference = None
        if args.reference:
            path = private_path(args.reference)
            require(path.parent.name == "raw" and path.name.startswith("own-voice-"),
                    "reference must be an explicit raw own-voice recording")
            reference = wav_asset(path, maximum_seconds=30)
        page = build_page(candidates, reference)
        encoded = page.encode("utf-8")
        require(len(encoded) <= MAX_HTML_BYTES, "HTML exceeds the 20 MiB standalone page limit")
        with output.open("xb") as destination:
            destination.write(encoded)
        print(json.dumps({"status": "created", "html": str(output), "bytes": len(encoded),
                          "candidate_count": len(candidates), "reference_included": reference is not None,
                          "quality_acceptance": "NOT_ASSESSED", "external_requests": 0}, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, wave.Error, EOFError) as error:
        print(f"Review page was not created: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
