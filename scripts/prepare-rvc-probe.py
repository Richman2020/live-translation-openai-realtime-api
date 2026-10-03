"""Convert the verified official RVC v2 32k base model for an offline compute probe.

No network access, training, personal voice, or telephone integration.
Based on the inference checkpoint layout in upstream train/process_ckpt.py.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys

SOURCE_SHA256 = "2332611297b8d88c7436de8f17ef5f07a2119353e962cd93cda5806d59a1133d"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = args.upstream / "assets/pretrained_v2/f0G32k.pth"
    with source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != SOURCE_SHA256:
            raise ValueError("Source is not the verified official v2 32k base model")
    import torch

    config = json.loads((args.upstream / "configs/v2/32k.json").read_text())
    data, model = config["data"], config["model"]
    checkpoint = torch.load(source, map_location="cpu", weights_only=True)
    weights = checkpoint["model"]
    config_list = [
        data["filter_length"] // 2 + 1, 32,
        model["inter_channels"], model["hidden_channels"], model["filter_channels"],
        model["n_heads"], model["n_layers"], model["kernel_size"], model["p_dropout"],
        model["resblock"], model["resblock_kernel_sizes"], model["resblock_dilation_sizes"],
        model["upsample_rates"], model["upsample_initial_channel"],
        model["upsample_kernel_sizes"], model["spk_embed_dim"], model["gin_channels"],
        data["sampling_rate"],
    ]
    result = {
        "weight": {key: value.float() for key, value in weights.items() if "enc_q" not in key},
        "config": config_list, "f0": 1, "version": "v2", "sr": "32k",
        "probe_metadata": {"role": "official-unpersonalized-base", "source_sha256": SOURCE_SHA256},
        "info": "Compute probe only; not a trained personal voice or a quality sample",
    }
    # Upstream inference loads non-strictly; fail here if any architecture key is missing.
    sys.path.insert(0, str(args.upstream.resolve()))
    from infer.module.models import SynthesizerTrnMs768NSFsid

    result["config"][-3] = result["weight"]["emb_g.weight"].shape[0]
    validation_model = SynthesizerTrnMs768NSFsid(*result["config"], is_half=False)
    del validation_model.enc_q
    validation_model.load_state_dict(result["weight"], strict=True)
    del validation_model
    with args.output.open("xb") as stream:
        torch.save(result, stream)
    print(json.dumps({"status": "prepared", "source_sha256": SOURCE_SHA256,
                      "sample_rate": data["sampling_rate"], "parameters": len(result["weight"])}))


if __name__ == "__main__":
    main()
