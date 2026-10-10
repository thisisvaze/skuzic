"""Embeds the perception probes (src/perception/probes.json) for SigLIP 2.

A probe is one visual quality with two poles, each said a few ways ("a pale
drawing made of faint, light marks" against "a dark drawing made of black,
inky marks"). Every pole's phrasings are embedded with SigLIP 2's text half and
averaged; the probe keeps only the difference of the two poles, so scoring an
image is one dot product, and no probe competes with another for a slot.

The browser runs only the image half; the text half is over 280 MB, so this is
computed here once and committed. Re-run after editing probes.json:

    uv run --with torch --with transformers --with sentencepiece --with protobuf \
        scripts/embed-probes.py
"""

import json
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

# The checkpoint onnx-community/siglip2-base-patch16-224-ONNX was exported from.
MODEL = "google/siglip2-base-patch16-224"
HERE = Path(__file__).resolve().parent.parent / "src" / "perception"

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModel.from_pretrained(MODEL).eval().to(device)
tokenizer = AutoTokenizer.from_pretrained(MODEL)


def norm(t: torch.Tensor) -> torch.Tensor:
    return torch.nn.functional.normalize(t, dim=-1)


def pole(phrases: list[str]) -> torch.Tensor:
    # SigLIP was trained on text padded to 64 tokens; shorter padding shifts it.
    batch = tokenizer(phrases, padding="max_length", max_length=64, return_tensors="pt").to(device)
    with torch.no_grad():
        out = model.get_text_features(**batch)
    return norm(norm(getattr(out, "pooler_output", out)).mean(0)).cpu()


if __name__ == "__main__":
    probes = json.loads((HERE / "probes.json").read_text())["probes"]
    phrases = {p["id"]: [p["pos"], p["neg"]] for p in probes}
    vectors = {p["id"]: [round(x, 5) for x in (pole(p["pos"]) - pole(p["neg"])).tolist()] for p in probes}
    out = HERE / "probe-vectors.json"
    old = json.loads(out.read_text()) if out.exists() else {}
    # Calibration comes from the lab's evaluation of the app's own model; keep
    # it for probes whose words didn't change.
    keep = {k: v for k, v in old.get("calibration", {}).items() if old.get("phrases", {}).get(k) == phrases.get(k)}
    out.write_text(json.dumps({"model": MODEL, "phrases": phrases, "vectors": vectors, "calibration": keep}, separators=(",", ":")) + "\n")
    print(f"wrote {len(vectors)} probes")
