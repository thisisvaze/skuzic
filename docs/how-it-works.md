# How skuzic works

You draw. Every stroke rings in key straight away, from a small sound engine
in the browser. When you lift the pen, SigLIP 2 reads the page, also in the
browser, and composes a mix from a hand-written **palette** of moods and
instruments. Tap **Reimagine**,
or tell the band something, and a Gemini planner reads the page instead and
writes its own **actions** (`ADD_TRACK`, `SET_VOLUME`, `MODIFY_TRACK`, …).
Either way a pure reducer applies the actions to state, and the state is
continuously synced to
[Lyria RealTime](https://ai.google.dev/gemini-api/docs/realtime-music-generation),
which streams music that changes under your hands. No restarts, no clip
stitching.

```
pen-up ──▶ SigLIP 2 (in the browser) ──▶ mix ────┐
                                                  ├──▶ Action[] ──▶ reducer ──▶ SkuzicState
Reimagine / typed event ──▶ planner (Gemini) ─────┘                                  │
                                                                     weighted prompts + config
                                                                                      ▼
                                                                    Lyria RealTime (WebSocket)
                                                                                      │
                                                                          48kHz PCM chunks
                                                                                      ▼
                                                                   Web Audio gapless scheduler

pen ──▶ touch engine (Web Audio, local, in key) ──▶ speakers, within milliseconds
```

## Reading the drawing

`src/vision/eyes.ts` runs on pen-up, undo, redo and clear. Only the image half
of SigLIP 2 runs in the browser (`onnx-community/siglip2-base-patch16-224-ONNX`,
63 MB, cached after the first visit); the text half is over 280 MB, so
`scripts/embed-palette.py` embeds the palette's tags once and commits the
vectors. Edit `src/vision/palette.json`, then re-run the script; the tests fail
until you do.

The mix is a few short layers, each with its own weight, which is how Lyria is
meant to be steered:

| Layer | Example | Lyria | Magenta |
| --- | --- | --- | --- |
| style, all session | "dreamy lo-fi hip hop" ("lo-fi hip hop" on Magenta) | 1.0 | 1.0 |
| a mood for each thing drawn | "gentle and bittersweet" | 0.45, shared | 0.8, shared |
| lead instrument, from the page | "soft felt piano melody" | 0.6 | 0.6 |
| second instrument | "warm Rhodes chords" | 0.4 | 0.4 |

The palette offers 100 things a drawing can show (`moods` in `palette.json`),
from a sun, rain or a bike to squiggles, each with its own mood. SigLIP doesn't
read the page whole: read whole, the biggest thing drowns out the rest, and a
sun or a bike drawn into a landscape never registered. Strokes in the same ink
that come within a tenth of the page's diagonal of each other make one figure,
and each figure is read from its own crop, once per change, so a stroke usually
costs one read. The music then mixes the page's things, each figure weighted by
the square root of its size: up to three play at once, sharing the mood's
weight, the biggest first ("mountains, trees and bicycle"). A thing joins at
12% of the page, or by beating the weakest of three by 5 points, and stays
until it falls under 8%, so the music settles as the drawing grows: a bike
drawn into a finished landscape joins the music rather than taking it over.
Every object starts as one stroke, and one stroke reads as squiggles, so the
figure being drawn has no say until it reads clearly as a thing or has three
strokes. Marks (squiggles, dots, spirals, writing) count half, and only from a
figure they lead, so a lone horizon line can't outweigh what the page shows.
The instruments are ranked against all the figures together. An empty page, or
first marks nothing on the page can be placed yet, play the vibe's opening:
"soft and unhurried" over its first instrument. How much ink is down and how
warm its colours are (`src/vision/ink.ts`) nudge density and brightness on
every reading, so the music grows as the page fills. A Gemini arrangement
survives until the drawing reads as something new.

Gemini follows along (Settings, on by default). SigLIP names things but in stock
words: it can't see colour, line or story, so violet water and blue water got
the same "flowing and serene". Every 3.5 seconds at most, and only while the page
keeps changing, the selected Gemini model looks at the page and rewrites the
words of every layer but Style for this drawing, with density and brightness
(`refine` in `src/llm/planner.ts`, its own short instruction and a reply shape
that requires a line per layer: under the arranger's instruction Gemini only
ever moved the knobs). It can't add, remove or clear layers, touch the style,
or change tempo or key (`keepRefinement`), so SigLIP keeps deciding what is on
the page. Its words and knob settings carry over when SigLIP adds or drops a
thing, and the ink stops nudging knobs Gemini has set. Measured on calm blue
waves against dense violet spirals: 3.5 Flash Lite answered in about a second
with "tranquil, rhythmic and cool" against "hypnotic, steady and rhythmic",
density 0.40 against 0.65; 3.8 Flash took about 3.5 seconds and was returning
503s at the time. Lyria then takes its usual few seconds to be heard.

Each thing's vector is SigLIP's text embedding of its tags, nudged toward 100
real Quick, Draw! doodles of it where that dataset has some
(`scripts/embed-palette.py`). On 40 held-out doodles per category, drawn as the
crops the app reads, the right thing came first 71% of the time among the 100
(87% in the top three), against 58% (74%) from the tags alone. Read the old
way, as whole pages against the nine moods this replaced, the same kinds of
doodles came out right 37% of the time, and nine misses in ten landed on
"energy" (now squiggles).

The artist can start from a **vibe** (`vibes` in `palette.json`, picked on the
blank page or in the mixer). A vibe sets the style layer for each engine, the
instruments it opens with, the only instruments a drawing may bring in, and its
tempo and drums. So a string quartet never grows a kalimba, and solo piano has
no instruments at all, only its style and the mood.

On a blank page, tapping a vibe plays a short loop of it at once
(`public/sounds/vibes/`, rendered by `scripts/make-vibe-previews.py`) and lays
its channels out in the mixer. The band itself starts on the first mark, in the
vibe's tempo, and the loop bows out as soon as the band is audible. "Just draw"
fades back to silence. With a drawing already on the page, picking a vibe
switches the band straight away. Wiping the page fades the band out over three
seconds rather than cutting it, and the next mark brings it back.

This shape won a listening test: four drawings, seven prompt styles, both
engines, scored with Audiobox Aesthetics plus an in-key measure. One sentence
per track with the genre in every prompt (the old scenes) scored lowest and
made every drawing sound alike. Bare one-line prompts let the genre drift
between drawings and once collapsed on Magenta. Short layers scored best on
both, and enjoyment went from 7.0 to 7.3 on Lyria and from 6.3 to 7.5 on
Magenta. The two engines want different balances, so `palette.json` holds one
per engine and switching engines re-weights the mix.

The q4 export is deliberate: every half-precision export (fp16, q4f16) drifts
to about 0.6 cosine against PyTorch on this model, while q4 holds 0.97. Measured
at 21 to 30 ms a read on WebGPU and 0.7 s on WASM, and it put 12 of 12 test
drawings (four saved sketches, eight simple doodles) in the right mood.

On iPad the same image model runs on the device through Core ML, and
`ios/Skuzic/Vision/` is a port of `eyes.ts`. `scripts/make-siglip-coreml.py`
converts it with 4-bit weights in blocks of 16: about 59 MB, 0.977 cosine
against PyTorch, and the same mood on all 12 test drawings. The app links the
web's palette files rather than copying them, so the two can't drift apart. The
4-bit model needs iOS 18; on iOS 17, lifting the pen asks Gemini instead. The
model isn't checked in, so run the script once before building; without it the
app asks Gemini too.

## The pen's own sound

`src/audio/touch.ts` gives every mark a sound before any model is involved, in
its own AudioContext so it plays while the bed is paused or still connecting.

- **Paper.** A quiet, unpitched friction texture under every stroke, felt more
  than heard. Its grain speeds up with the pen; a thick nib sounds like a marker
  and the eraser like rubber.
- **Clearing the page** is a soft swish.

On the web, notes answer brush strokes on both the landing page and `/app`, in
soft, spaced phrases in F major / D minor pentatonic. Each brush has its own
voice, synthesized in the engine, and neither is an instrument the bed plays:

- **Pencil plucks**: a soft wooden note, gone in about half a second. Sharp
  corners pluck too, so zigzags play and smooth lines stay quiet, and every
  touchdown ticks.
- **Watercolor swells**: a two-note chord with no attack that rises with paint
  flow (speed and pressure), walks the scale as the brush moves up or down,
  and fades for a couple of seconds after the brush lifts.

Settings → Brush sounds switches back to the earlier piano
(`public/sounds/piano-*.mp3`, prefetched at startup) to compare. Rapid hatching
and erasing stay textural, and long drawing sessions gradually leave more space
between phrases. Scene-change chimes remain removed; the iPad pen still plays
paper texture only.

`LEVEL` is the one knob for balancing it against the bed by ear. The iPad
plays the same pen (`ios/Skuzic/Audio/TouchEngine.swift`, on AVAudioEngine),
driven by the Pencil's own pressure and every sample it takes.

## Backends

Pick one in Settings at any time. Switching mid-session reconnects
under the same mix. The choice persists across reloads. Both implement `MusicEngine`
(`src/audio/engine.ts`), so everything upstream (reducer, planner, UI) is
unaware of which is running.

| | Lyria RealTime | Magenta RT2 |
| --- | --- | --- |
| Runs | Google's servers | your Mac |
| Needs | API key | Apple Silicon + local bridge |
| Weights | closed | open (CC-BY-4.0) |
| Max tracks | 8 | 6 |
| Controls | bpm, scale, density, brightness, guidance, bass/drums | guidance, drums; the bridge holds the key |

Magenta requires the local bridge in [`server/`](../server/README.md). MRT2 ships
no server component, so that wraps its Python API in a WebSocket. **The Gemini
key is needed either way** (pasted in the UI): the planner always runs on Gemini,
whichever model generates audio.

The control surfaces really differ: MRT2 conditions on blended MusicCoCa
style embeddings and has no concept of tempo, and no key control of its own.
Rather than let dead knobs sit in the UI, `CAPABILITIES` drives both which
controls render and what the planner is told it may emit.

Left alone, MRT2 picks any key it likes, which clashes with the pen's F major.
So the bridge holds it to a four-chord loop in the pen's key through MRT2's
notes input, leaves the voicing to the model, and starts the loop on D minor
for darker moods. In-key energy went from 67% to 94%; see
[the bridge README](../server/README.md#staying-in-key).

## The state model

A **track** is one weighted text prompt. Its `volume` is the prompt's weight,
and the engine normalizes weights across all live tracks, so volume is
*relative prominence in the mix*, not a gain stage.

```ts
interface Track {
  id: string;
  label: string;   // short name the planner reasons about
  prompt: string;  // what Lyria actually receives
  volume: number;  // 0..1, relative weight
  muted: boolean;
  origin: string;  // the event that created it
}
```

The reducer (`src/core/reducer.ts`) is pure and fully tested:

```bash
pnpm test
```

### Actions

| Action | Effect |
| --- | --- |
| `ADD_TRACK` | Adds a weighted prompt; evicts the quietest track at capacity (8) |
| `REMOVE_TRACK` | Drops a track |
| `MODIFY_TRACK` | Rewrites a track's prompt or label in place |
| `SET_VOLUME` | Changes relative weight |
| `SET_MUTED` | Excludes a track without deleting it |
| `SET_CONFIG` | bpm, density, brightness, guidance, scale, mute bass/drums |
| `CLEAR_TRACKS` | Empties the mix |
| `RESET_CONTEXT` | Forces the model to restart generation |

Track-scoped actions take a `target` that is either an id or a label. The
planner is told to use ids, but it drifts toward the labels it just invented, so
`resolve()` falls back to exact, then substring, then prompt matching. An
unresolvable target is a no-op rather than a crash.

## A/B mode

Toggle **A/B test** in the Engine menu and every interpret plans the same event
twice (once with the selected arranger strategy, once with a randomly chosen
rival) and holds both instead of applying either. The two candidate mixes show
up blind-labeled A and B; A starts playing immediately, *listen* switches to
the other arm, *keep* commits one. While the choice is up, the Mix rack mirrors
the arm being auditioned (read-only) rather than the on-hold committed mix.
Which strategy produced which is only revealed in the History tab after the
choice, so the ear decides rather than the label.

The Gemini key is entered in the UI and stored locally (localStorage / Keychain).
On the hosted demo, a visitor without one plays through `api/gemini.mjs`, which
relays Lyria and Reimagine with a server-side key. A/B plays both arms at once:
B is a second, muted Lyria session on the same key, so *listen* is a gain flip.
Measured 2026-10-06, two sessions on one key each kept real time and needed
0.41 s of lead-in at worst. If that second stream can't start, switching falls
back to re-steering the single stream with a `resetContext`, a ducked cut in
about a second.

Every choice is saved to IndexedDB as a preference record: the drawing as the
planner saw it, the event, the mix both plans started from, both full plans
(strategy, reasoning, actions, resulting tracks and config), which one won, and
how long the decision took. **export** in the same menu downloads the lot as
JSONL (`src/lib/dataset.ts`): ready-made (input → chosen) pairs for SFT, or
(chosen, rejected) pairs for DPO, on a future planner.

## The details that make it feel like an instrument

**Weights ramp, they don't snap.** Replacing the prompt set outright produces an
audible jump cut. `LyriaEngine` keeps a `current` and a `target` weight map and
walks between them over ~1s at 10Hz (`src/audio/lyria.ts`). That interpolation
*is* the DJ-blend feel.

**A weight of zero is invalid.** The API rejects it. Tracks fade to an epsilon
and are then dropped from the array entirely. An empty prompt list is also
invalid, so the engine holds the last mix rather than sending nothing.

**bpm and scale need a context reset.** Every other parameter steers live. These
two require `resetContext()`, which is audible as a restart, so the planner is
instructed to change them only when the event really implies it, and the UI
says so out loud.

**Audio arrives faster than real time.** The model emits bursts; the scheduler
buffers ~1.5s and lays chunks end-to-end on the Web Audio clock. On underrun it
re-anchors ahead of `currentTime` instead of scheduling into the past, which
would drop chunks silently. Sample rate is parsed from each chunk's MIME type
rather than hardcoded.

**Setup handshake.** The server rejects client messages sent before
`setupComplete` arrives, so `connect()` awaits that message.

**Structured output is a flat schema.** `anyOf` unions round-trip poorly through
`responseSchema`, so the model emits a flat object with a `type` enum and
`normalize()` narrows it back into the real union, dropping anything malformed.

**The planner translates feeling, not nouns.** A house becomes "shelter, warmth,
wooden timbres", not the words "a house". That instruction lives in
`SYSTEM_INSTRUCTION` in `src/llm/planner.ts` and is the single highest-leverage
thing to tune.

## Layout

```
src/
  core/       types, pure reducer, Gemini response schema  (no I/O, testable)
  llm/        planner: event + state -> actions
  vision/     eyes.ts: SigLIP 2 reads the page, composes the mix
              palette.json: the moods and instruments; palette-vectors.json: generated
              ink.ts: how full and how warm the page is
  audio/      engine interface + capabilities
              lyria.ts:     hosted WebSocket session
              magenta.ts:   local bridge client
              mixer.ts:     weight ramping, shared by both
              scheduler.ts: gapless PCM playback
              touch.ts:     the pen's own sound
  ui/         landing, canvas and dock, mixer, settings, history
scripts/      embed-palette.py: palette tags -> SigLIP text vectors
              make-pen-sounds.py: shared web brush piano samples
server/       Python WebSocket bridge wrapping Magenta RT2
test/         reducer, schema, touch, eyes and ink tests
```

## Stack

React 19 · Vite 8 · TypeScript 7 · pnpm 10 · Tailwind 4 · `@google/genai` 2.13 ·
`@huggingface/transformers` 4.3 · `models/lyria-realtime-exp` (v1alpha) ·
`gemini-3.8-flash` · SigLIP 2 (q4 ONNX) · `magenta-rt` (MLX)

`pnpm.onlyBuiltDependencies` is deliberately empty: the only postinstall scripts
in the tree are `@google/genai`'s (`echo 'preinstall: no-op'`), protobufjs's and
onnxruntime-node's (a Node binary transformers.js only uses outside the
browser), none of which affects a browser bundle. Build output is byte-identical
with them skipped.

