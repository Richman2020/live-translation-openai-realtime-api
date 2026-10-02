"""Fetch only pinned public Pocket preset assets; verify official LFS/Git hashes.

No Hugging Face login, gated files, user audio, or telephone API calls. Existing
verified assets are reused and partial public downloads can be resumed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request

REPO = Path(__file__).resolve().parent.parent
LAB = REPO / ".runtime/pocket-tts-lab"
BASE = "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/"
ASSETS = [
    ("model/model.safetensors", BASE + "e7205b6ee50e654a5ea19f0e9df2b0813b05e921/languages/english/model.safetensors", 219029196, "916ccd2686e9311cb40054893a3c4284393d658825ffc714a276f3e9b152344f", None),
    ("model/michael.safetensors", BASE + "4e1e0a3e611c51c0b4ed8174fc10f32a54644303/languages/english/embeddings/michael.safetensors", 7276344, "401711f60394aa6085627f7050c1b3f97b31aa7138784811bc6c6ec7d7eaad0c", None),
    ("model/tokenizer.json", BASE + "00eac05ed3d16bdc3f6b5d598874019c34a89214/languages/english/tokenizer.json", 245020, None, "fe3e7fe6185e4a3bc218fa8f5ed993ecb098201c"),
    ("sources/michael-p360.wav", "https://huggingface.co/kyutai/tts-voices/resolve/a0de156151266cf8eb27ac8f27312f7aff2ef7b8/vctk/p360_023_enhanced.wav", 751140, "b6743e9195e5e3fd34fe9d1633ae93f7ffab787b249e45f6467d7d6f7a6ee6ad", None),
]


def verify(path, size, sha, git_blob):
    if path.stat().st_size != size:
        raise ValueError(f"Size mismatch: {path.name}")
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if sha and actual != sha:
        raise ValueError(f"LFS SHA256 mismatch: {path.name}")
    if git_blob:
        digest = hashlib.sha1(f"blob {size}\0".encode() + path.read_bytes()).hexdigest()
        if digest != git_blob:
            raise ValueError(f"Git blob hash mismatch: {path.name}")
    return actual


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proxy")
    args = parser.parse_args()
    proxies = {"https": args.proxy, "http": args.proxy} if args.proxy else None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    manifest = {"schema": "public-fixed-voice-assets/1", "mode": "PUBLIC_PRESET_WITHOUT_VOICE_CLONING", "files": [], "voice": {"preset": "michael", "speaker": "VCTK p360", "gender": "male", "accent": "American, New Jersey", "recorded_age": 19, "mature_timbre_accepted": False, "license": "CC BY 4.0", "attribution": "CSTR VCTK Corpus 0.92, Yamagishi, Veaux, MacDonald; sample enhanced by Kyutai using ai-coustics", "license_url": "https://creativecommons.org/licenses/by/4.0/", "source_url": "https://huggingface.co/kyutai/tts-voices", "note": "Nano uses the public WAV; Pocket uses its official precomputed Michael preset, not an identical reference-encoding implementation."}}
    LAB.mkdir(parents=True, exist_ok=True)
    for name, url, size, sha, git_blob in ASSETS:
        target = LAB / name
        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_suffix(target.suffix + ".part")
        if not target.exists():
            for attempt in range(3):
                try:
                    offset = part.stat().st_size if part.exists() else 0
                    if offset == size:
                        verify(part, size, sha, git_blob)
                        part.replace(target)
                        break
                    if offset > size:
                        raise ValueError("Partial download exceeds expected asset size")
                    headers = {"User-Agent": "AIPhone-Public-Preset-Pilot/1"}
                    if offset:
                        headers["Range"] = f"bytes={offset}-"
                    request = urllib.request.Request(url, headers=headers)
                    print(json.dumps({"asset": name, "stage": "download", "resume_bytes": offset}), flush=True)
                    with opener.open(request, timeout=60) as response:
                        if offset and response.status != 206:
                            raise ValueError("Server did not honor partial-download range")
                        if offset and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                            raise ValueError("Invalid partial-download Content-Range")
                        with part.open("ab" if offset else "wb") as dest:
                            while chunk := response.read(1024 * 1024):
                                dest.write(chunk)
                                if dest.tell() > size:
                                    raise ValueError("Response larger than expected public file")
                    verify(part, size, sha, git_blob)
                    part.replace(target)
                    break
                except Exception as error:
                    print(json.dumps({"asset": name, "attempt": attempt + 1, "error": str(error)}), flush=True)
                    if attempt == 2:
                        raise
                    time.sleep(2)
        actual = verify(target, size, sha, git_blob)
        manifest["files"].append({"path": name, "url": url, "bytes": size, "sha256": actual, "official_lfs_sha256": sha, "official_git_blob_sha1": git_blob})
        print(json.dumps({"asset": name, "stage": "verified", "bytes": size}), flush=True)
    manifest_path = LAB / "public-assets.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"stage": "all_public_assets_verified"}), flush=True)


if __name__ == "__main__":
    main()
