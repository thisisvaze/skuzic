"""WebSocket bridge exposing Magenta RealTime 2 with a Lyria-shaped interface.

MRT2 ships no server component, so skuzic talks to this instead. It wraps
`magenta_rt.mlx.system.MagentaRT2System` and speaks the small protocol that
`src/audio/magenta.ts` expects.

Protocol
--------
client -> server (JSON text frames)
    {"type": "prompts", "prompts": [{"text": str, "weight": float}, ...]}
    {"type": "config",  "guidance": float, "muteDrums": bool}
    {"type": "play"} | {"type": "pause"} | {"type": "stop"} | {"type": "reset"}

server -> client
    binary frames : raw interleaved int16 stereo PCM @ 48 kHz
    JSON frames   : {"type": "status", "state": ..., "detail": ...}
                    {"type": "error",  "detail": ...}

Run
---
    uv pip install "magenta-rt[mlx]" websockets numpy
    mrt models init
    python server/magenta_bridge.py --size mrt2_base
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import json
import logging
import random
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s")
log = logging.getLogger("magenta-bridge")

SAMPLE_RATE = 48000
FRAMES_PER_SECOND = 25  # MRT2 generates 40 ms frames.

# Frames per generate() call. Measured on an M5 Pro, RTF is flat at ~0.73
# whether you ask for 1 frame or 25 — per-call overhead is negligible, so a
# small chunk costs nothing in throughput and cuts the steering delay directly.
# 5 frames = 200 ms, matching MRT2's own control-latency target.
DEFAULT_CHUNK_FRAMES = 5

# How far ahead of the wall clock generation may run. A prompt change cannot be
# heard until already-generated audio drains, so this is the dominant term in
# steering latency. RTF 0.73 leaves 27% headroom to refill, so a short buffer is
# safe; raise it if you hear dropouts under load.
MAX_LEAD_SECONDS = 0.6

# Embedding shares the single MLX thread with generation, so an unbounded
# backlog starves audio outright. Rapid drawing can request hundreds of distinct
# prompts per minute; only a few can ever be current.
MAX_INFLIGHT_EMBEDS = 2


class ModelWorker:
    """Runs all MRT2 work on one dedicated thread.

    MLX's Metal streams are thread-affine — inference must happen on the thread
    that created the model, or it raises "There is no Stream(gpu, 1) in current
    thread." A single-worker executor pins loading and every subsequent call to
    the same thread while keeping the asyncio loop free to read control messages.

    Side effect: embedding queues behind an in-flight generate, so a brand-new
    prompt can take up to one chunk longer to take effect.
    """

    def __init__(self, size: str, weights: str):
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mrt")
        self._size = size
        self._weights = weights
        self._system: Any = None

    def _load(self) -> None:
        from magenta_rt.mlx import system as mrt_system

        cls = (
            mrt_system.MagentaRT2SystemMlxfn
            if self._weights == "mlxfn"
            else mrt_system.MagentaRT2System
        )
        log.info("loading %s (%s)…", self._size, self._weights)
        self._system = cls(size=self._size)
        log.info("model ready")

    async def _run(self, fn, /, *args, **kwargs):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._pool, lambda: fn(*args, **kwargs))

    async def start(self) -> None:
        await self._run(self._load)

    async def embed_style(self, text: str, seed: int) -> np.ndarray:
        # use_mapper pushes the text embedding into *audio* space via MusicCoCa's
        # generative mapper. Without it, distinct prompts stay bunched together
        # (measured mean pairwise cos-sim 0.46 vs 0.14 with it) and every prompt
        # maps to one fixed point, so repeated sessions sound identical.
        return await self._run(
            lambda: self._system.embed_style(text, use_mapper=True, seed=seed)
        )

    async def generate(self, **kwargs):
        return await self._run(lambda: self._system.generate(**kwargs))

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False)


class StyleCache:
    """embed_style() is expensive, so each prompt string is embedded once.

    Blending happens on the 768-dim MusicCoCa embeddings, which is what lets a
    volume slider crossfade continuously instead of switching between prompts.
    """

    def __init__(
        self,
        worker: ModelWorker,
        seed_base: int,
        on_ready: Callable[[], None] | None = None,
    ):
        self._worker = worker
        self._seed_base = seed_base
        self._on_ready = on_ready
        self._cache: dict[str, np.ndarray] = {}
        self._inflight: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._issued = 0

    def _request(self, text: str) -> None:
        """Queue an embed without blocking the caller.

        Embedding shares the one MLX thread with generation. Awaiting it inline
        meant a burst of new prompts (measured: 54 distinct prompts from under
        two seconds of drawing) could monopolise the worker and starve audio
        entirely. Fire-and-forget instead: the prompt simply doesn't contribute
        until its vector lands, a beat or two later.
        """
        if text in self._cache or text in self._inflight:
            return

        # Bound the backlog. Beyond this the prompt is almost certainly stale
        # before its vector would land; a later message re-requests it if it
        # still matters.
        if len(self._inflight) >= MAX_INFLIGHT_EMBEDS:
            return

        seed = self._seed_base + self._issued
        self._issued += 1
        self._inflight.add(text)
        log.info("embedding style: %r (seed %d)", text, seed)

        async def run() -> None:
            try:
                self._cache[text] = np.asarray(
                    await self._worker.embed_style(text, seed), dtype=np.float32
                )
                # Nothing else would recompute the mix, so a late-arriving
                # vector has to announce itself or it never takes effect.
                if self._on_ready is not None:
                    self._on_ready()
            except Exception:  # noqa: BLE001 - a failed embed must not kill the loop
                log.exception("embed failed for %r", text)
            finally:
                self._inflight.discard(text)

        task = asyncio.create_task(run())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def blend(self, prompts: list[dict[str, Any]]) -> np.ndarray | None:
        vectors, weights = [], []
        for prompt in prompts:
            text = (prompt.get("text") or "").strip()
            weight = float(prompt.get("weight") or 0.0)
            if not text or weight <= 0:
                continue
            cached = self._cache.get(text)
            if cached is None:
                self._request(text)
                continue  # contributes once its embedding arrives
            vectors.append(cached)
            weights.append(weight)

        if not vectors:
            return None

        w = np.asarray(weights, dtype=np.float32)
        w /= w.sum()
        blended = np.tensordot(w, np.stack(vectors), axes=1)

        # Averaging near-orthogonal vectors shortens the result (a 50/50 blend
        # measures 0.81x the input norm), which weakens conditioning and drifts
        # the output generic. Keep the direction, restore the magnitude.
        norm = float(np.linalg.norm(blended))
        if norm > 1e-6:
            target = float(np.dot(w, [np.linalg.norm(v) for v in vectors]))
            blended = blended * (target / norm)
        return blended


class Session:
    """One browser connection: owns the generation loop and MRT2 state."""

    def __init__(
        self, worker: ModelWorker, websocket: Any, frames_per_chunk: int, seed_base: int
    ):
        self.worker = worker
        self.websocket = websocket
        self.frames_per_chunk = frames_per_chunk
        self.styles = StyleCache(worker, seed_base, on_ready=self._restyle)
        self.last_prompts: list[dict[str, Any]] = []
        self._restyle_tasks: set[asyncio.Task] = set()

        self.style: np.ndarray | None = None
        self.state: Any = None
        self.playing = False
        self.guidance: float | None = None
        self.drums: int = -1  # -1 masked, 0 off, 1 on

        self._task: asyncio.Task | None = None

    async def apply_prompts(self) -> None:
        """Re-blend the current mix from whatever is cached right now."""
        blended = await self.styles.blend(self.last_prompts)
        if blended is not None:
            self.style = blended

    def _restyle(self) -> None:
        """An embed landed; fold it into the mix."""
        task = asyncio.create_task(self.apply_prompts())
        self._restyle_tasks.add(task)
        task.add_done_callback(self._restyle_tasks.discard)

    async def notify(self, state: str, detail: str | None = None) -> None:
        await self.websocket.send(
            json.dumps({"type": "status", "state": state, "detail": detail})
        )

    async def handle(self, message: dict[str, Any]) -> None:
        kind = message.get("type")

        if kind == "prompts":
            self.last_prompts = message.get("prompts") or []
            await self.apply_prompts()

        elif kind == "config":
            if (guidance := message.get("guidance")) is not None:
                # skuzic carries Lyria's 0..6 guidance range; MRT2's
                # cfg_musiccoca is defined over -1..7 with a 3.0 default.
                self.guidance = float(np.clip(float(guidance), -1.0, 7.0))
            if (mute := message.get("muteDrums")) is not None:
                self.drums = 0 if mute else -1

        elif kind == "play":
            self.playing = True
        elif kind == "pause":
            self.playing = False
        elif kind == "stop":
            self.playing = False
            self.state = None
        elif kind == "reset":
            # Drops the rolling audio context; the model restarts from silence
            # while keeping the current style blend.
            self.state = None

    async def run(self) -> None:
        """Generate continuously, throttled to stay near MAX_LEAD_SECONDS."""
        sent_seconds = 0.0
        started_at: float | None = None

        while True:
            if not self.playing or self.style is None:
                await asyncio.sleep(0.05)
                started_at = None
                sent_seconds = 0.0
                continue

            if started_at is None:
                started_at = time.monotonic()

            lead = sent_seconds - (time.monotonic() - started_at)
            if lead > MAX_LEAD_SECONDS:
                await asyncio.sleep(lead - MAX_LEAD_SECONDS)
                continue

            try:
                waveform, self.state = await self.worker.generate(
                    style=self.style,
                    drums=[self.drums],
                    cfg_musiccoca=self.guidance,
                    frames=self.frames_per_chunk,
                    state=self.state,
                )
            except Exception as exc:  # noqa: BLE001 - surface anything to the UI
                log.exception("generation failed")
                await self.websocket.send(json.dumps({"type": "error", "detail": str(exc)}))
                self.playing = False
                continue

            # Waveform guarantees 2-D (n_samples, n_channels); mono is widened
            # by its own setter. Only fan out or trim to the stereo the client
            # expects.
            samples = np.asarray(waveform.samples, dtype=np.float32)
            if samples.shape[1] == 1:
                samples = np.repeat(samples, 2, axis=1)
            elif samples.shape[1] > 2:
                samples = samples[:, :2]

            pcm = np.clip(samples, -1.0, 1.0)
            pcm = (pcm * 32767.0).astype("<i2")
            await self.websocket.send(pcm.tobytes())

            sent_seconds += samples.shape[0] / SAMPLE_RATE

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    async def aclose(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task


async def serve(
    worker: ModelWorker, host: str, port: int, frames_per_chunk: int, seed_base: int
) -> None:
    async def handler(websocket: Any) -> None:
        log.info("client connected")
        session = Session(worker, websocket, frames_per_chunk, seed_base)
        session.start()
        await session.notify("ready")

        try:
            async for raw in websocket:
                if isinstance(raw, bytes):
                    continue
                try:
                    await session.handle(json.loads(raw))
                except json.JSONDecodeError:
                    log.warning("ignoring non-JSON frame")
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await session.aclose()
            log.info("client disconnected")

    try:
        async with websockets.serve(handler, host, port, max_size=None):
            log.info("bridge listening on ws://%s:%d", host, port)
            await asyncio.Future()
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise
        log.error(
            "port %d is already in use — another bridge is probably running.\n"
            "  find it:  lsof -nP -iTCP:%d -sTCP:LISTEN\n"
            "  stop it:  kill $(lsof -nP -iTCP:%d -sTCP:LISTEN -t)\n"
            "  or use a different port:  --port %d",
            port,
            port,
            port,
            port + 1,
        )
        raise SystemExit(1) from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--size",
        default="mrt2_base",
        help="mrt2_base (2.4B, needs M3 Pro or better) or mrt2_small (230M).",
    )
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--chunk-frames",
        type=int,
        default=DEFAULT_CHUNK_FRAMES,
        help=(
            f"Frames per generate() call, 40ms each (default {DEFAULT_CHUNK_FRAMES} "
            "= 200ms). Throughput is flat across chunk sizes, so lower is "
            "strictly lower latency."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Base seed for style-mapper noise. Random per run unless pinned.",
    )
    parser.add_argument(
        "--weights",
        choices=("mlxfn", "checkpoint"),
        default="mlxfn",
        help=(
            "mlxfn: exported model from `mrt models download` (default, faster). "
            "checkpoint: raw safetensors from `mrt checkpoints download`."
        ),
    )
    args = parser.parse_args()

    worker = ModelWorker(args.size, args.weights)

    seed_base = args.seed if args.seed is not None else random.randrange(1_000_000)
    log.info("style seed base: %d", seed_base)

    async def run() -> None:
        # Load on the worker thread before accepting clients, so the model is
        # ready the moment a browser connects.
        await worker.start()
        await serve(worker, args.host, args.port, args.chunk_frames, seed_base)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        worker.shutdown()


if __name__ == "__main__":
    main()
