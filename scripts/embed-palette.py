"""Embeds the palette's mood and instrument tags with SigLIP 2's text half, for
src/vision/eyes.ts.

The browser runs only the image half of SigLIP 2; the text half is over 280 MB
even quantized, so this side is computed here once and committed. Re-run after
editing tags in src/vision/palette.json (the tests fail until you do):

    uv run --with torch --with transformers --with sentencepiece --with protobuf \
        scripts/embed-palette.py
"""

import json
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

# The checkpoint onnx-community/siglip2-base-patch16-224-ONNX was exported from,
# so these vectors share a space with the image half the browser loads.
MODEL = "google/siglip2-base-patch16-224"
TEMPLATES = ["a drawing of {}", "a sketch of {}", "a doodle of {}"]
VISION = Path(__file__).resolve().parent.parent / "src" / "vision"

model = AutoModel.from_pretrained(MODEL).eval()
tokenizer = AutoTokenizer.from_pretrained(MODEL)


def embed(texts: list[str]) -> torch.Tensor:
    # SigLIP was trained on text padded to 64 tokens; shorter padding shifts it.
    batch = tokenizer(texts, padding="max_length", max_length=64, return_tensors="pt")
    with torch.no_grad():
        out = model.get_text_features(**batch)
    out = getattr(out, "pooler_output", out)
    return torch.nn.functional.normalize(out, dim=-1)


def vectors(entries: list[dict], center: bool = False) -> dict:
    entries = [e for e in entries if e["tags"]]  # the intro is chosen without the model
    # Every tag in every phrasing, averaged: steadier than any single caption.
    means = torch.stack([
        torch.nn.functional.normalize(embed([t.format(tag) for tag in e["tags"] for t in TEMPLATES]).mean(0), dim=0)
        for e in entries
    ])
    if center:
        # Averaging "a drawing of ..." phrases leaves a shared "any drawing" part,
        # and whichever entry carries most of it wins every runner-up slot.
        # Subtracting the list's mean keeps only what sets each entry apart.
        means = torch.nn.functional.normalize(means - means.mean(0), dim=1)
    return {e["id"]: {"tags": e["tags"], "vector": [round(v, 5) for v in m.tolist()]} for e, m in zip(entries, means)}


palette = json.loads((VISION / "palette.json").read_text())
out = {
    "model": MODEL,
    "scale": round(model.logit_scale.exp().item(), 4),
    "moods": vectors(palette["moods"]),
    "instruments": vectors(palette["instruments"], center=True),
}
(VISION / "palette-vectors.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"wrote {len(out['moods'])} mood and {len(out['instruments'])} instrument vectors, logit scale {out['scale']}")
