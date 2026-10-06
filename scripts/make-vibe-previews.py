"""Renders a short loop of each vibe's opening into public/sounds/vibes/, so a tap
on a vibe is heard at once instead of after the band has connected and started.

Each loop is a whole number of bars at the vibe's tempo plus a one-second tail;
src/audio/preview.ts crossfades that tail into the next pass, so the loop has no
seam. Renders with Lyria RealTime, the app's own layers and tempo for the vibe.

    GEMINI_API_KEY=... uv run --with google-genai --with numpy --with scipy \\
        scripts/make-vibe-previews.py [vibe ids]

Needs ffmpeg on the PATH. Re-run for a vibe after changing it in palette.json.
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from google import genai
from google.genai import types
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "sounds" / "vibes"
RATE = 48000
WARMUP = 4.0  # Lyria's first seconds are still finding the groove
TAIL = 1.0  # must match TAIL in src/audio/preview.ts
TARGET = 11.0  # roughly how long one pass of the loop should be
RMS_DB = -20.0

palette = json.loads((ROOT / "src" / "vision" / "palette.json").read_text())
prompt_of = {i["id"]: i["prompt"] for i in palette["instruments"]}
intro_mood = palette["moods"][0]["prompt"]


def loop_seconds(bpm: int) -> float:
    bar = 240 / bpm
    return max(1, round(TARGET / bar)) * bar


async def render(client: genai.Client, vibe: dict, seconds: float) -> np.ndarray:
    layers = [(vibe["ground"]["lyria"], 1.0), (intro_mood, palette["moodWeight"]["lyria"])]
    layers += [(prompt_of[i], w) for i, w in zip(vibe["start"], (0.6, 0.4))]
    audio = bytearray()
    async with client.aio.live.music.connect(model="models/lyria-realtime-exp") as session:

        async def receive():
            async for message in session.receive():
                for chunk in (message.server_content and message.server_content.audio_chunks) or []:
                    audio.extend(chunk.data)
                if len(audio) >= seconds * RATE * 4:
                    return

        task = asyncio.create_task(receive())
        await session.set_weighted_prompts(
            prompts=[types.WeightedPrompt(text=t, weight=w) for t, w in layers]
        )
        await session.set_music_generation_config(
            config=types.LiveMusicGenerationConfig(
                bpm=vibe["bpm"],
                scale=types.Scale.F_MAJOR_D_MINOR,
                density=0.2,
                brightness=0.6,
                guidance=3.0,
                mute_drums=not vibe["drums"],
            )
        )
        await session.play()
        await asyncio.wait_for(task, timeout=seconds * 4 + 30)
    return np.frombuffer(bytes(audio), dtype="<i2").reshape(-1, 2).astype(np.float32) / 32768


def encode(x: np.ndarray, path: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        wavfile.write(tmp.name, RATE, (x * 32767).astype(np.int16))
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-b:a", "112k", str(path)], check=True
        )


async def main() -> None:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("Set GEMINI_API_KEY (a key from aistudio.google.com/apikey).")
    client = genai.Client(api_key=key, http_options={"api_version": "v1alpha"})
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = set(sys.argv[1:])
    for vibe in palette["vibes"]:
        if vibe["id"] == "blank" or (wanted and vibe["id"] not in wanted):
            continue
        length = loop_seconds(vibe["bpm"])
        x = await render(client, vibe, WARMUP + length + TAIL + 0.5)
        start = int(WARMUP * RATE)
        loop = x[start : start + int((length + TAIL) * RATE)]
        loop *= 10 ** (RMS_DB / 20) / (np.sqrt(np.mean(loop**2)) + 1e-9)
        loop = np.tanh(loop * 1.1) / 1.1  # catch the odd peak
        encode(loop, OUT / f"{vibe['id']}.mp3")
        print(f"{vibe['id']}: {length:.2f}s loop ({round(length / (240 / vibe['bpm']))} bars at {vibe['bpm']} bpm)")


asyncio.run(main())
