"""Builds the iPad's drawing reader: SigLIP 2's image half as Core ML, at
ios/Skuzic/Vision/SiglipEyes.mlpackage (ios/Skuzic/Vision/Eyes.swift loads it).

Same model as the web build (google/siglip2-base-patch16-224), so both apps
read a drawing alike against the same palette vectors. Weights are 4-bit in
blocks of 16, the Core ML version of the web's q4 ONNX: about 59 MB, and on
the test drawings it agrees with full-precision PyTorch at cosine 0.977 and
picks the same mood every time. Plain 4-bit palettes scored 0.75. Needs
iPadOS 18; older systems fall back to asking Gemini.

    uv run --with torch --with transformers --with coremltools --with pillow \\
        scripts/make-siglip-coreml.py
"""

from pathlib import Path

import coremltools as ct
import numpy as np
import torch
from coremltools.optimize.coreml import OpLinearQuantizerConfig, OptimizationConfig, linear_quantize_weights
from transformers import SiglipVisionModel

MODEL = "google/siglip2-base-patch16-224"
OUT = Path(__file__).resolve().parent.parent / "ios" / "Skuzic" / "Vision" / "SiglipEyes.mlpackage"

vision = SiglipVisionModel.from_pretrained(MODEL, attn_implementation="eager").eval()


class Pool(torch.nn.Module):
    """SigLIP's attention pooling, written out. nn.MultiheadAttention traces into
    shape arithmetic Core ML can't convert; this is the same maths on the same
    weights, with fixed sizes for the same reason."""

    def __init__(self, head):
        super().__init__()
        a = head.attention
        self.heads, self.d = a.num_heads, a.embed_dim
        self.probe, self.layernorm, self.mlp, self.out = head.probe, head.layernorm, head.mlp, a.out_proj
        d, w, b = self.d, a.in_proj_weight, a.in_proj_bias
        self.q, self.k, self.v = (torch.nn.Linear(d, d) for _ in range(3))
        for i, lin in enumerate((self.q, self.k, self.v)):
            lin.weight.data = w[i * d : (i + 1) * d].clone()
            lin.bias.data = b[i * d : (i + 1) * d].clone()

    def forward(self, h, attention_mask=None):
        hd = self.d // self.heads
        q = self.q(self.probe).reshape(1, 1, self.heads, hd).transpose(1, 2)
        k = self.k(h).reshape(1, -1, self.heads, hd).transpose(1, 2)
        v = self.v(h).reshape(1, -1, self.heads, hd).transpose(1, 2)
        x = self.out((torch.softmax(q @ k.transpose(-1, -2) / hd**0.5, dim=-1) @ v).transpose(1, 2).reshape(1, 1, self.d))
        return (x + self.mlp(self.layernorm(x)))[:, 0]


class Eyes(torch.nn.Module):
    def __init__(self, v):
        super().__init__()
        self.v = v

    def forward(self, x):
        return torch.nn.functional.normalize(self.v(pixel_values=x).pooler_output, dim=-1)


with torch.no_grad():
    probe = torch.randn(1, 196, vision.config.hidden_size)
    original = vision.head(probe)
    vision.head = Pool(vision.head).eval()
    assert float((vision.head(probe) - original).abs().max()) < 1e-4, "pooling rewrite drifted"

eyes = Eyes(vision).eval()
traced = torch.jit.trace(eyes, torch.zeros(1, 3, 224, 224))
model = ct.convert(
    traced,
    # SigLIP's processor scales pixels to [-1, 1]; Core ML does it on the way in.
    inputs=[ct.ImageType(name="image", shape=(1, 3, 224, 224), scale=1 / 127.5, bias=[-1, -1, -1],
                         color_layout=ct.colorlayout.RGB)],
    outputs=[ct.TensorType(name="embedding")],
    minimum_deployment_target=ct.target.iOS18,
    compute_precision=ct.precision.FLOAT16,
    convert_to="mlprogram",
)
model = linear_quantize_weights(model, OptimizationConfig(global_config=OpLinearQuantizerConfig(
    mode="linear_symmetric", dtype="int4", granularity="per_block", block_size=16)))
model.author = "SigLIP 2 by Google, converted for skuzic"
model.license = "Apache-2.0"
model.short_description = "A drawing in, a unit-length SigLIP 2 image embedding out."

# Quick check against PyTorch on a plain test page.
page = np.full((224, 224, 3), 248, np.uint8)
page[60:164, 100:124] = 30
from PIL import Image  # noqa: E402

with torch.no_grad():
    ref = eyes(torch.from_numpy(page.astype(np.float32) / 127.5 - 1).permute(2, 0, 1)[None])[0].numpy()
got = np.array(model.predict({"image": Image.fromarray(page)})["embedding"]).reshape(-1)
cosine = float(got @ ref / np.linalg.norm(got))
print(f"cosine against PyTorch on a test page: {cosine:.3f}")
assert cosine > 0.9, "the converted model drifted too far"

model.save(str(OUT))
print("wrote", OUT)
