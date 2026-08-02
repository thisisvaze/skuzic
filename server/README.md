# Magenta bridge

Magenta RealTime 2 ships no server component — it's a Python library plus an
MLX/C++ engine. `magenta_bridge.py` wraps it in a WebSocket that speaks the
same shape skuzic already uses for Lyria, so the browser can treat both
backends identically.

## Requirements

Apple Silicon. MRT2's real-time path is MLX-backed and Mac-only.

| Model | Params | Real-time on |
| --- | --- | --- |
| `mrt2_small` | 230M | any Apple Silicon Mac |
| `mrt2_base` | 2.4B | M3 Pro / M2 Max or better |

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip uv
.venv/bin/uv pip install --python .venv/bin/python 'magenta-rt[mlx]' websockets numpy
.venv/bin/mrt models init                    # shared resources, ~3.9 GB
.venv/bin/mrt models download mrt2_base      # exported model, ~2.6 GB
```

Pass the model name explicitly — bare `mrt models download` opens an
interactive picker that will hang a non-interactive shell.

In VS Code this is the **skuzic: setup magenta** task; it's idempotent.

### Two weight formats

MRT2 ships weights two ways, and they load through *different* classes:

| Fetched by | Format | Class | Bridge flag |
| --- | --- | --- | --- |
| `mrt models download` | exported `.mlxfn` | `MagentaRT2SystemMlxfn` | `--weights mlxfn` (default) |
| `mrt checkpoints download` | raw `.safetensors` | `MagentaRT2System` | `--weights checkpoint` |

The bridge defaults to `mlxfn` — it's what `mrt models download` gives you and
it's the optimized path. Using `MagentaRT2System` against a `models/` download
fails with a missing `checkpoints/mrt2_base.safetensors`, because it wants the
raw checkpoint instead.

## Run

```bash
python server/magenta_bridge.py --size mrt2_base
```

Then pick **Magenta RT2 (local)** in the skuzic top bar and hit start. The
Gemini API key is still required — the planner runs on Gemini regardless of
which model generates audio.

Useful flags:

- `--size mrt2_small` — lighter, lower quality, starts faster
- `--chunk-frames 10` — 400 ms per generation step instead of 1 s; lower
  latency, more overhead per step
- `--port 8765` — override, then set `VITE_MAGENTA_BRIDGE_URL` to match

## How prompt weighting works

Lyria takes weighted prompts directly. MRT2 conditions on a single MusicCoCa
style embedding, so the bridge does the blending itself: each track's prompt is
embedded once and cached, then the live set is combined as a weighted average
of those 768-dim vectors before being passed to `generate()`.

That's what makes a volume fader crossfade continuously rather than switch
between prompts — it's moving through embedding space, not picking a winner.
The C++ engine exposes the same idea natively as `reblend_musiccoca_tokens`.

## What MRT2 does not have

MRT2 has no tempo, key, density, or brightness conditioning. skuzic hides
those knobs when this backend is selected, and the planner is told not to emit
them. What does map across:

| skuzic | MRT2 |
| --- | --- |
| track prompts + volume | blended MusicCoCa style embedding |
| guidance | `cfg_musiccoca` (rescaled to −1…7) |
| no drums | `drums=0` conditioning channel |
| reset context | drops rolling state, restarts from silence |

MRT2 also has MIDI note conditioning (128-channel pianoroll) that skuzic
doesn't use — an obvious extension if you want drawn pitch material.

## Latency

Steering latency — fader move to audible change — is dominated by **buffered
audio, not compute**. The chain is:

```
mixer tick (≤100ms) → embed, queued behind in-flight generate (≤146ms)
  → next chunk boundary (200ms) → server lead (600-800ms)
  → browser lead-in (400ms)
```

### Chunk size is free

Throughput is flat across chunk sizes on an M5 Pro — per-call overhead is
negligible, so a small chunk costs nothing and cuts latency directly:

| frames | audio | generate | RTF |
| --- | --- | --- | --- |
| 25 | 1000 ms | 725 ms | 0.73 |
| 10 | 400 ms | 293 ms | 0.73 |
| 5 | 200 ms | 146 ms | 0.73 |
| 2 | 80 ms | 58 ms | 0.73 |
| 1 | 40 ms | 29 ms | 0.72 |

Hence the 5-frame (200 ms) default. There is no throughput reason to generate
in larger chunks.

### Tuning

- `DEFAULT_CHUNK_FRAMES` (5) — frames per `generate()`. Lower is lower latency.
- `MAX_LEAD_SECONDS` (0.6) — server-side buffer. The throttle checks *before*
  generating, so effective lead settles at `MAX_LEAD + one chunk` (~800 ms).
- `leadIn` in `src/audio/scheduler.ts` (0.4s) — browser-side buffer.

RTF 0.73 leaves 27% headroom to refill, so these are safe. Measured over 12s at
the defaults: median inter-chunk gap 200 ms against a 200 ms chunk — exactly
real-time — with 208 ms worst case, i.e. 8 ms of jitter. Push the buffers lower
if you want tighter response; raise them if you hear gaps under load.

### If you need more headroom

`mrt2_small` (230M vs 2.4B) is far faster and would allow a much smaller
buffer, at a quality cost. Fetch it with `mrt models download mrt2_small`, then
run with `--size mrt2_small`.

## Threading

All MRT2 calls run on a single dedicated thread (`ModelWorker`). This is not
optional: MLX's Metal streams are thread-affine, so running inference on a
different thread than the one that built the model fails with

```
There is no Stream(gpu, 1) in current thread.
```

That rules out the obvious `asyncio.to_thread(system.generate, ...)`, which
hands each call to an arbitrary pool thread. A one-worker executor pins loading
and every subsequent call to the same thread while leaving the event loop free
to read control frames.

One consequence: embedding a brand-new prompt queues behind any in-flight
generate, so a never-seen-before prompt can take up to one extra chunk to take
effect. Prompts already in the cache re-blend immediately.

## Verified

Measured on an M5 Pro with `mrt2_base` via `.mlxfn`:

| | |
| --- | --- |
| model load + warmup | 0.4 s |
| generation | 1.00 s audio in ~0.73 s (**0.73× real-time**) |
| style embed (uncached) | ~0.1 s |
| output | 48 kHz stereo, 192 000 bytes per 1 s chunk |

Streaming, mid-stream prompt changes, and weighted blending across two prompts
all confirmed end-to-end over the WebSocket.
