"""Build a private A/B listening page for two explicit Nano parameter reports.

Only copies verified existing audio. No synthesis, resampling, normalization,
upload or playback. Missing parameters and incomparable reports fail closed.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys


REPO = Path(__file__).resolve().parent.parent
VALIDATOR_PATH = REPO / "scripts/build-nano-voice-review.py"
spec = importlib.util.spec_from_file_location("nano_voice_review_validator", VALIDATOR_PATH)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
require = validator.require
escape = validator.escape
PARAMETER_KEYS = {
    "repetition_penalty", "min_p", "top_p", "audio_prompt_path", "exaggeration",
    "cfg_weight", "temperature", "top_k", "norm_loudness",
}
SHA40 = re.compile(r"[a-f0-9]{40}")
SHA64 = validator.SHA_PATTERN


def parameters(entry, expected_temperature):
    params = entry.get("generation_parameters")
    require(isinstance(params, dict) and set(params) == PARAMETER_KEYS,
            "Every fixture needs complete explicit generation_parameters; no legacy defaults are inferred")
    for key in PARAMETER_KEYS - {"audio_prompt_path", "norm_loudness", "top_k"}:
        require(validator.finite_number(params[key]), "Invalid numeric generation parameter: " + key)
    require(params["temperature"] == expected_temperature, "Unexpected comparison temperature")
    require(params["audio_prompt_path"] is None and params["norm_loudness"] is True,
            "Expected explicit prepared own-voice conditionals and unchanged loudness setting")
    require(type(params["top_k"]) is int and params["top_k"] > 0, "Invalid top_k")
    return params


def comparable_reports(baseline, candidate):
    """Require one parameter change and the same recorded input/model/runtime."""
    upstream = baseline.get("upstream", {})
    require(SHA40.fullmatch(str(upstream.get("commit", "")))
            and SHA64.fullmatch(str(upstream.get("tts_turbo_sha256", ""))),
            "Missing fixed upstream commit and source hash")
    require(upstream == candidate.get("upstream"), "Upstream source differs")
    model = baseline.get("model", {})
    require(SHA40.fullmatch(str(model.get("revision", ""))), "Missing fixed model revision")
    files = model.get("files")
    require(isinstance(files, dict) and len(files) >= 8, "Missing model file identities")
    for name, record in files.items():
        require(isinstance(name, str) and Path(name).name == name and isinstance(record, dict)
                and SHA64.fullmatch(str(record.get("sha256", "")))
                and type(record.get("bytes")) is int and record["bytes"] > 0,
                "Invalid model file identity")
    require(model == candidate.get("model"), "Model, device, weights or parameter counts differ")
    reference = baseline.get("reference", {})
    require(SHA64.fullmatch(str(reference.get("sha256", ""))), "Missing reference audio hash")
    require(reference == candidate.get("reference"), "Own-voice reference differs")
    require(baseline.get("conditioning") == candidate.get("conditioning")
            and isinstance(baseline.get("conditioning"), dict), "Reference conditioning differs")
    require(baseline.get("runtime") == candidate.get("runtime")
            and isinstance(baseline.get("runtime"), dict), "Python, Torch or CPU thread settings differ")
    require(baseline.get("watermark") == candidate.get("watermark"), "Watermark configuration differs")
    for report in (baseline, candidate):
        require(SHA64.fullmatch(str(report.get("script_sha256", ""))), "Missing probe source hash")
        network = report.get("network", {})
        require(network.get("downloads") is False and network.get("uploads") is False
                and network.get("python_socket_guard_active") is True,
                "Missing offline guard evidence")
    require(baseline["script_sha256"] == candidate["script_sha256"], "Probe implementations differ")
    baseline_entries = {entry["id"]: entry for entry in baseline["fixtures"]}
    candidate_entries = {entry["id"]: entry for entry in candidate["fixtures"]}
    comparisons = []
    baseline_params = candidate_params = None
    for fixture_id, text in validator.FIXTURES.items():
        left, right = baseline_entries[fixture_id], candidate_entries[fixture_id]
        require(left["text"] == right["text"] == text, "Fixture text differs")
        require(type(left.get("seed")) is int and 0 <= left["seed"] <= 2**32 - 1
                and type(right.get("seed")) is int and left["seed"] == right["seed"],
                "Fixture random seeds differ or are missing")
        a, b = parameters(left, 0.8), parameters(right, 0.75)
        require({key: value for key, value in a.items() if key != "temperature"}
                == {key: value for key, value in b.items() if key != "temperature"},
                "A parameter other than temperature changed")
        if baseline_params is not None:
            require(a == baseline_params and b == candidate_params,
                    "Generation parameters vary between fixtures")
        baseline_params, candidate_params = a, b
        comparisons.append({"fixture_id": fixture_id, "text": text, "seed": left["seed"],
                            "baseline_generation_parameters": a, "candidate_generation_parameters": b})
    return {"only_generation_parameter_changed": "temperature", "baseline_temperature": 0.8,
            "candidate_temperature": 0.75, "fixtures": comparisons,
            "same_probe_sha256": baseline["script_sha256"], "same_upstream": upstream,
            "same_model_revision": model["revision"], "same_reference_sha256": reference["sha256"],
            "boundary": "Recorded input, model and explicit parameters match; this does not establish perceptual improvement or deterministic output."}


def prepare_groups(groups, role):
    for group in groups:
        group["comparison_role"] = role
        group["id"] = role + "-" + group["fixture_id"]
        group["title"] = "A · 原版对照" if role == "baseline" else "B · 微调候选"
        for index, item in enumerate(group["assets"]):
            item["filename"] = group["id"] + ("-native.wav" if index == 0 else "-phone-8k.wav")
    return groups


def card(group):
    players = []
    for index, item in enumerate(group["assets"]):
        label = "原生声音" if index == 0 else "电话编码后声音"
        players.append(f'<div class="player"><label>{label}</label><audio controls preload="none" '
                       f'aria-label="{escape(group["title"] + " · " + label)}" '
                       f'src="audio/{escape(item["filename"])}"></audio>'
                       f'<small>{item["duration_seconds"]:.2f} 秒</small></div>')
    warning = ('<p class="warning">此段有生成检查提醒，请核对尾句完整性和破音；尚未验收。</p>'
               if group["warnings"] or any(item["peak"] >= 1 for item in group["assets"]) else "")
    return f'<article class="card"><h3>{escape(group["title"])}</h3>' + "".join(players) + warning + '</article>'


def section(groups, fixture_id, title):
    return (f'<section><h2>{escape(title)}</h2><p class="script" lang="en">'
            f'{escape(validator.FIXTURES[fixture_id])}</p>'
            f'<p class="meaning">{escape(validator.MEANINGS[fixture_id])}</p><div class="grid">'
            + "".join(card(group) for group in groups if group["fixture_id"] == fixture_id)
            + '</div></section>')


def build_html(groups, created):
    primary = section(groups, "three-sentences", "先听同一段三句话")
    extra = section(groups, "availability", "问句") + section(groups, "negation-time", "否定和时间")
    timings = "".join(f'<li>{escape(group["title"])} · {escape(group["fixture_id"])}：'
                      f'{group["generation_seconds"]:.2f} 秒</li>' for group in groups)
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src 'self' file:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Nano · 原版与微调候选</title><style>
:root{{color-scheme:light;--ink:#203044;--muted:#596879;--line:#dce4ee;--accent:#315fbd}}
*{{box-sizing:border-box}}body{{margin:0;background:#f4f7fb;color:var(--ink);font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}}
main{{max-width:1000px;margin:auto;padding:32px 24px 56px}}h1{{font-size:30px;line-height:1.3;margin:8px 0 12px}}h2{{font-size:21px;margin:0 0 12px}}h3{{font-size:19px;margin:0}}
p{{margin:8px 0 14px}}.eyebrow{{color:var(--accent);font-weight:700;font-size:14px}}.intro,.meaning,small{{color:var(--muted)}}
.notice{{background:#eaf0fb;border-left:4px solid var(--accent);padding:12px 17px;border-radius:8px;margin:20px 0}}
section{{margin:24px 0}}.script{{padding:15px 18px;background:#fff;border:1px solid var(--line);border-radius:10px;font-size:17px}}
.grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}.card{{padding:18px 20px;background:#fff;border:1px solid var(--line);border-radius:12px}}
.player{{margin-top:16px}}.player label{{display:block;font-weight:650;font-size:14px;margin-bottom:6px}}audio{{display:block;width:100%}}small{{display:block;font-size:12px}}
details{{border-top:1px solid var(--line);padding-top:16px;margin-top:22px}}summary{{cursor:pointer;font-weight:650}}.warning{{background:#fff1d9;padding:10px;font-size:13px;color:#865014}}
.checks{{margin:22px 0;padding:15px 18px;background:#fff;border:1px solid var(--line);border-radius:10px}}footer{{margin-top:30px;font-size:12px;color:var(--muted)}}
@media(max-width:680px){{main{{padding:24px 16px}}.grid{{grid-template-columns:1fr}}h1{{font-size:26px}}}}
</style></head><body><main><div class="eyebrow">本机私密试听 · 微调候选待确认</div>
<h1>原版和微调版，连读有区别吗？</h1>
<p class="intro">先交替听 A、B 的原生声音，再比较电话编码后的声音。切换播放时，上一段会自动暂停。</p>
<div class="notice">本次只微调一项生成参数。B 是否更容易听清、是否保留原来的自然感，需要你试听判断。</div>
{primary}
<div class="checks">请留意：连读和词尾是否更容易分辨？语气、节奏和你的声线有没有变差？三个句子有没有漏字或改意？</div>
<details><summary>再核对问句、否定和时间</summary>{extra}</details>
<details><summary>这次对照的范围与生成用时</summary>
<p>两组使用相同文字、参考录音、模型、程序、随机种子和 CPU 设置；仅将 temperature 从 0.80 调为 0.75。没有加停顿、变速、裁切或重新调整音量。复制到本页面的音频与生成原件哈希一致。</p>
<p>下面是整段音频的生成用时，不是电话延迟，也没有用于判断哪组音质更好。</p><ul>{timings}</ul>
<p>“电话编码后”仅指 8 kHz μ-law 编码再解码，未经过真实电话线路。两组保留官方生成流程的水印；此页面没有再次处理声音。所有文件均为待试听候选，当前没有更改电话主线路。</p>
</details><footer>生成时间（UTC）：{escape(created)}。音频保存在本目录 audio 文件夹；离线即可试听，请保留整个目录。</footer>
</main><script>document.querySelectorAll('audio').forEach(current=>current.addEventListener('play',()=>{{document.querySelectorAll('audio').forEach(other=>{{if(other!==current)other.pause();}});}}));</script></body></html>'''


def build(baseline_report, candidate_report, output_dir):
    output = validator.private_path(output_dir, exists=False)
    require(not output.exists(), "Output directory already exists; no overwrite allowed")
    baseline, _ = validator.load_nano(baseline_report)
    candidate, _ = validator.load_nano(candidate_report)
    left, right = baseline[0]["report"], candidate[0]["report"]
    require(left["path"] != right["path"], "Comparison requires two different completed reports")
    comparison = comparable_reports(left["report"], right["report"])
    groups = [*prepare_groups(baseline, "baseline"), *prepare_groups(candidate, "candidate")]
    require(sum(item["bytes"] for group in groups for item in group["assets"]) < 100 * 1024 * 1024,
            "Listening folder exceeds the audio size budget")
    created = datetime.now(timezone.utc).isoformat()
    page = build_html(groups, created)
    manifest = {"schema": "nano-clarity-private-listening-review/1", "created_at_utc": created,
                "status": "ready_for_listening_only", "quality_accepted": False,
                "scope": "LOCAL_UNMODIFIED_AUDIO_COMPARISON_NOT_LIVE_PHONE",
                "comparison": comparison, "source_reports": [], "audio": [],
                "builder_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "validator_sha256": hashlib.sha256(VALIDATOR_PATH.read_bytes()).hexdigest()}
    # All input/provenance checks happen before creating the private output.
    output.mkdir(parents=True, exist_ok=False)
    (output / "audio").mkdir()
    (output / "evidence").mkdir()
    for role, loaded in (("baseline", left), ("candidate", right)):
        filename = role + "-report.private.json"
        path = output / "evidence" / filename
        with path.open("xb") as destination:
            destination.write(loaded["raw"])
        require(hashlib.sha256(path.read_bytes()).hexdigest() == loaded["sha256"], "Copied report hash mismatch")
        manifest["source_reports"].append({"role": role, "filename": "evidence/" + filename,
                                            "sha256": loaded["sha256"], "schema": loaded["report"]["schema"]})
    for group in groups:
        for item in group["assets"]:
            path = output / "audio" / item["filename"]
            with path.open("xb") as destination:
                destination.write(item["raw"])
            require(hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"], "Copied audio hash mismatch")
            manifest["audio"].append({"role": group["comparison_role"], "fixture_id": group["fixture_id"],
                                       **{key: value for key, value in item.items() if key != "raw"}})
    require(len(manifest["audio"]) == 12, "Expected twelve A/B WAV files")
    with (output / "index.html").open("x", encoding="utf-8") as destination:
        destination.write(page)
    manifest["page_sha256"] = hashlib.sha256((output / "index.html").read_bytes()).hexdigest()
    with (output / "review-manifest.private.json").open("x", encoding="utf-8") as destination:
        json.dump(manifest, destination, ensure_ascii=False, indent=2, allow_nan=False)
        destination.write("\n")
    return output / "index.html"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-report", required=True, type=Path)
    parser.add_argument("--candidate-report", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        page = build(args.baseline_report, args.candidate_report, args.output_dir)
        print(json.dumps({"status": "ready_for_listening_only", "page": str(page),
                          "audio_files": 12, "human_acceptance": "PENDING"}, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        print("A/B review not completed: " + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
