# How skuzic works

You draw something, or fire an event like `user drew a house`. A planner model
reads that event alongside the current mix and returns a list of **actions**
(`ADD_TRACK`, `SET_VOLUME`, `MODIFY_TRACK`, …). A pure reducer applies those
actions to state. The state is then continuously synced to
[Lyria RealTime](https://ai.google.dev/gemini-api/docs/realtime-music-generation),
which streams music that changes under your hands. No restarts, no clip
stitching.

```
event ──▶ planner (gemini-3.8-flash) ──▶ Action[] ──▶ reducer ──▶ SkuzicState
                                                                      │
                                                        weighted prompts + config
                                                                      ▼
                                                      Lyria RealTime (WebSocket)
                                                                      │
                                                          48kHz PCM chunks
                                                                      ▼
                                                     Web Audio gapless scheduler
```

## Backends

Pick one in the top bar at any time. Switching mid-session reconnects
under the same mix. The choice persists across reloads. Both implement `MusicEngine`
(`src/audio/engine.ts`), so everything upstream (reducer, planner, UI) is
unaware of which is running.

| | Lyria RealTime | Magenta RT2 |
| --- | --- | --- |
| Runs | Google's servers | your Mac |
| Needs | API key | Apple Silicon + local bridge |
| Weights | closed | open (CC-BY-4.0) |
| Max tracks | 8 | 6 |
| Controls | bpm, scale, density, brightness, guidance, bass/drums | guidance, drums |

Magenta requires the local bridge in [`server/`](../server/README.md). MRT2 ships
no server component, so that wraps its Python API in a WebSocket. **The Gemini
key is needed either way** (pasted in the UI): the planner always runs on Gemini,
whichever model generates audio.

The control surfaces really differ: MRT2 conditions on blended MusicCoCa
style embeddings and has no concept of tempo or key. Rather than let dead knobs
sit in the UI, `CAPABILITIES` drives both which controls render and what the
planner is told it may emit.

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
Which strategy produced which is only revealed in the action log after the
choice, so the ear decides rather than the label.

The Gemini key is entered in the UI and stored locally (localStorage / Keychain).
A/B still works on one key: switching re-steers the single stream with a
`resetContext`, landing as a ducked cut in about a second. Dual-stream instant
switching would need a second key, which we don't collect.

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
  audio/      engine interface + capabilities
              lyria.ts:     hosted WebSocket session
              magenta.ts:   local bridge client
              mixer.ts:     weight ramping, shared by both
              scheduler.ts: gapless PCM playback
  ui/         canvas, track rack, config knobs, action log
server/       Python WebSocket bridge wrapping Magenta RT2
test/         reducer + schema tests
```

## Stack

React 19 · Vite 8 · TypeScript 7 · pnpm 10 · Tailwind 4 · `@google/genai` 2.13 ·
`models/lyria-realtime-exp` (v1alpha) · `gemini-3.8-flash` · `magenta-rt` (MLX)

`pnpm.onlyBuiltDependencies` is deliberately empty: the only postinstall scripts
in the tree are `@google/genai`'s (`echo 'preinstall: no-op'`) and protobufjs's,
neither of which affects a browser bundle. Build output is byte-identical with
them skipped.

