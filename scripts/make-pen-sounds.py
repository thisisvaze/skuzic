"""Builds the pen's sound kit in public/sounds/ (src/audio/touch.ts plays it).

Piano: eight soft (velocity layer 1) Kawai grand samples from the Versilian
Community Sample Library, CC0: https://github.com/sgossner/VCSL. Roots sit at
most a semitone from every note the pen plays, so nothing is stretched far
enough to sound pitched-up.

The paper texture under each stroke is synthesized in the engine itself.

    uv run --with numpy --with scipy --with certifi scripts/make-pen-sounds.py

Needs ffmpeg on the PATH.
"""

import io
import ssl
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from scipy.io import wavfile

try:
    import certifi

    # python.org builds on macOS ship without root certificates.
    TLS = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    TLS = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sounds"
SR = 44100

VCSL = "https://raw.githubusercontent.com/sgossner/VCSL/master/Chordophones/Zithers/Grand%20Piano,%20Kawai/Sustains/"
PIANO = {66: "F#4", 68: "G#4", 72: "C5", 75: "D#5", 78: "F#5", 81: "A5", 84: "C6", 87: "D#6"}

def to_mono_float(raw: bytes) -> np.ndarray:
    sr, x = wavfile.read(io.BytesIO(raw))
    x = x.astype(np.float32) / (np.iinfo(x.dtype).max if x.dtype.kind == "i" else 1.0)
    if x.ndim == 2:
        x = x.mean(axis=1)
    assert sr == SR, f"expected {SR} Hz, got {sr}"
    return x


def encode(x: np.ndarray, path: Path, bitrate: str = "96k") -> None:
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        wavfile.write(tmp.name, SR, (np.clip(x, -1, 1) * 32767).astype(np.int16))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-ac", "1", "-b:a", bitrate, str(path)],
            check=True,
        )


def cents_off(x: np.ndarray, midi: int) -> float:
    """Pitch check from partials 2 to 4. A soft piano's fundamental is weak enough
    that the strongest bin near it is often noise; the upper partials are not."""
    seg = x[int(0.1 * SR): int(1.1 * SR)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 19))
    freqs = np.fft.rfftfreq(1 << 19, 1 / SR)
    want = 440 * 2 ** ((midi - 69) / 12)
    found = []
    for n in (2, 3, 4):
        band = (freqs > n * want * 0.97) & (freqs < n * want * 1.03)
        found.append(freqs[band][np.argmax(spec[band])] / n)
    return 1200 * np.log2(np.median(found) / want)


def piano() -> None:
    notes = {}
    for midi, name in PIANO.items():
        url = VCSL + urllib.parse.quote(f"GPiano_sus_{name}_v1_rr1_Player.wav")
        x = to_mono_float(urllib.request.urlopen(url, timeout=60, context=TLS).read())
        # Start a hair before the hammer, keep three seconds, let it fade naturally.
        start = max(0, int(np.argmax(np.abs(x) > 0.01 * np.abs(x).max())) - int(0.002 * SR))
        x = x[start: start + 3 * SR]
        fade = min(len(x) // 3, int(0.9 * SR))
        x[-fade:] *= np.cos(np.linspace(0, np.pi / 2, fade)) ** 2
        # Equal loudness over the first half second, so every root feels the same touch.
        notes[midi] = x / np.sqrt(np.mean(x[: SR // 2] ** 2))
    # One gain for the whole set: as loud as possible with the hottest attack at -1 dBFS.
    gain = 10 ** (-1 / 20) / max(np.abs(x).max() for x in notes.values())
    for midi, x in notes.items():
        encode(x * gain, OUT / f"piano-{midi}.mp3")
        print(f"piano-{midi}.mp3  {PIANO[midi]}  {len(x) / SR:.2f}s  pitch {cents_off(x, midi):+.0f} cents  peak {20 * np.log10(np.abs(x * gain).max()):.1f} dBFS")
    print(f"rms over the first half second: {20 * np.log10(gain):.1f} dBFS")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    piano()
