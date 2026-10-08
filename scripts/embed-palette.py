"""Embeds the palette for the eyes (src/vision/eyes.ts and the iPad's Palette.swift).

A mood is something a drawing can show (a sun, a bike, squiggles) and the mood
it plays. Its vector starts as SigLIP 2's text embedding of its tags. Moods with
Quick, Draw! categories are then nudged toward what people's doodles of them
really look like: plus BETA times how far the mean of 100 such doodles sits from
the mean of every mood's doodles. That nudge averages out to zero over all
doodles, so moods with none keep an even footing. On 40 held-out doodles per
category, drawn as the crops the app reads, it took the right answer among 100
moods from 58% to 71% (74% to 87% in the top three), while simple hand-drawn
shapes for moods without doodles (a heart, a rocket) still won 88% of the time.

The browser runs only the image half of SigLIP 2; the text half is over 280 MB
even quantized, so this side is computed here once and committed. Re-run after
editing tags or doodles in src/vision/palette.json (the tests fail until you do):

    uv run --with torch --with transformers --with sentencepiece --with protobuf --with pillow \
        scripts/embed-palette.py

The first run downloads about 30 MB of Quick, Draw! strokes (CC BY 4.0) into
~/.cache/skuzic/quickdraw.
"""

import io
import json
import random
import urllib.parse
import urllib.request
from pathlib import Path

import torch
from PIL import Image, ImageDraw
from transformers import AutoImageProcessor, AutoModel, AutoTokenizer

# The checkpoint onnx-community/siglip2-base-patch16-224-ONNX was exported from,
# so these vectors share a space with the image half the browser loads.
MODEL = "google/siglip2-base-patch16-224"
TEMPLATES = ["a drawing of {}", "a sketch of {}", "a doodle of {}"]
VISION = Path(__file__).resolve().parent.parent / "src" / "vision"
CACHE = Path.home() / ".cache" / "skuzic" / "quickdraw"
BETA = 0.8
DOODLES = 100
# The app's paper and inks (src/ui/DrawCanvas.tsx), black the most used.
PAPER = (252, 251, 248)
INKS = ["#15130f"] * 4 + ["#7a7266", "#d1495b", "#e2711d", "#6a994e", "#1b998b", "#2d7dd2", "#3d348b", "#7c3aed", "#e26d9e", "#8b5a2b"]

device = "mps" if torch.backends.mps.is_available() else "cpu"
model = AutoModel.from_pretrained(MODEL).eval().to(device)
tokenizer = AutoTokenizer.from_pretrained(MODEL)
processor = AutoImageProcessor.from_pretrained(MODEL)


def norm(t: torch.Tensor) -> torch.Tensor:
    return torch.nn.functional.normalize(t, dim=-1)


def embed(texts: list[str]) -> torch.Tensor:
    # SigLIP was trained on text padded to 64 tokens; shorter padding shifts it.
    batch = tokenizer(texts, padding="max_length", max_length=64, return_tensors="pt").to(device)
    with torch.no_grad():
        out = model.get_text_features(**batch)
    return norm(getattr(out, "pooler_output", out)).cpu()


def text_mean(tags: list[str]) -> torch.Tensor:
    # Every tag in every phrasing, averaged: steadier than any single caption.
    return norm(embed([t.format(tag) for tag in tags for t in TEMPLATES]).mean(0))


def doodles(category: str) -> list:
    """The first recognized drawings of a Quick, Draw! category, downloaded once."""
    path = CACHE / f"{category}.json"
    if not path.exists():
        url = "https://storage.googleapis.com/quickdraw_dataset/full/simplified/" + urllib.parse.quote(category) + ".ndjson"
        request = urllib.request.Request(url, headers={"Range": "bytes=0-300000"})
        lines = urllib.request.urlopen(request, timeout=120).read().decode("utf-8", "replace").split("\n")[:-1]
        drawings = [d["drawing"] for d in map(json.loads, lines) if d.get("recognized")][:DOODLES]
        CACHE.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(drawings))
    return json.loads(path.read_text())


def crop_of(strokes: list, rng: random.Random) -> Image.Image:
    """A doodle as the app hands an object to the eyes: a 224 px square of
    paper around it, padded by a fifth, at a random size and pen width."""
    side = 448  # drawn at twice the size, then downsampled, for smooth edges
    image = Image.new("RGB", (side, side), PAPER)
    pen = ImageDraw.Draw(image)
    w = max(max(xs) for xs, _ in strokes) or 1
    h = max(max(ys) for _, ys in strokes) or 1
    css = rng.uniform(120, 800)  # the object's longer side on the page, in CSS px
    px = side / (css * 1.2 + 24)  # crop pixels per CSS px
    scale = css * px / max(w, h)
    left, top = (side - w * scale) / 2, (side - h * scale) / 2
    width = max(1, round(rng.uniform(3, 8) * px))
    color = rng.choice(INKS)
    for xs, ys in strokes:
        points = [(left + x * scale, top + y * scale) for x, y in zip(xs, ys)]
        if len(points) > 1:
            pen.line(points, fill=color, width=width, joint="curve")
        for x, y in (points[0], points[-1]):
            pen.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=color)
    buffer = io.BytesIO()
    image.resize((224, 224), Image.LANCZOS).save(buffer, "JPEG", quality=80)
    return Image.open(buffer).convert("RGB")


def doodle_mean(category: str, rng: random.Random) -> torch.Tensor:
    images = [crop_of(strokes, rng) for strokes in doodles(category)]
    with torch.no_grad():
        out = model.get_image_features(**processor(images=images, return_tensors="pt").to(device))
    return norm(norm(getattr(out, "pooler_output", out)).mean(0).cpu())


def mood_vectors(moods: list[dict]) -> dict:
    moods = [m for m in moods if m["tags"]]  # the intro is chosen without the model
    rng = random.Random(0)
    seen = {m["id"]: norm(torch.stack([doodle_mean(c, rng) for c in m["doodles"]]).mean(0)) for m in moods if m["doodles"]}
    center = norm(torch.stack(list(seen.values())).mean(0))
    out = {}
    for m in moods:
        # Not renormalised: an even footing for moods without doodles needs the
        # nudge to add to the text vector, not to tilt it.
        v = text_mean(m["tags"]) + BETA * (seen[m["id"]] - center) if m["id"] in seen else text_mean(m["tags"])
        out[m["id"]] = {"tags": m["tags"], "doodles": m["doodles"], "vector": [round(x, 4) for x in v.tolist()]}
    return out


def instrument_vectors(instruments: list[dict]) -> dict:
    means = torch.stack([text_mean(i["tags"]) for i in instruments])
    # Averaging "a drawing of ..." phrases leaves a shared "any drawing" part,
    # and whichever entry carries most of it wins every runner-up slot.
    # Subtracting the list's mean keeps only what sets each entry apart.
    means = norm(means - means.mean(0))
    return {i["id"]: {"tags": i["tags"], "vector": [round(x, 4) for x in m.tolist()]} for i, m in zip(instruments, means)}


if __name__ == "__main__":
    palette = json.loads((VISION / "palette.json").read_text())
    out = {
        "model": MODEL,
        "scale": round(model.logit_scale.exp().item(), 4),
        "moods": mood_vectors(palette["moods"]),
        "instruments": instrument_vectors(palette["instruments"]),
    }
    (VISION / "palette-vectors.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"wrote {len(out['moods'])} mood and {len(out['instruments'])} instrument vectors, logit scale {out['scale']}")
