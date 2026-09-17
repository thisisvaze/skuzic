# skuzic

**Draw something. Hear it turn into music.**

[![CI](https://github.com/thisisvaze/skuzic/actions/workflows/ci.yml/badge.svg)](https://github.com/thisisvaze/skuzic/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE.md)

skuzic is an instrument you play with a pen. Sketch a house and the music gets
warm and woody. Scribble a storm and it darkens. The song never stops or
restarts. It just keeps bending around whatever you draw.

```
you draw a house
  → Gemini reads it: "shelter, warmth, wooden timbres"
  → the mix changes: add a track, fade another
  → Lyria RealTime plays the new sound, live
```

Works in the browser and on iPad/iPhone. On a Mac you can also generate the
audio locally with Google's open Magenta RT2 model.

## Try it

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173, paste a Gemini key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), hit **start**,
and draw. The key stays in your browser; it is never baked into the build.

On iPad/iPhone: open `ios/Skuzic.xcodeproj`, run, then **Settings** (gear) and
paste the same kind of key. It lives in the Keychain, not the app binary.

## Build it with us

skuzic is early and there's a lot of fun stuff left to make:

- 🎛️ **Give it taste.** One prompt in `src/llm/planner.ts` decides how drawings
  sound. You don't need to know anything about audio to make it better.
- ✏️ **Read drawings better.** Right now the whole canvas is one image. Where
  you draw, how fast, and which colors you pick could all shape the music.
- 🎹 **Draw melodies.** Magenta RT2 takes piano-roll notes that skuzic ignores
  today. Lines could become tunes.
- 🎮 **Play it with anything.** Game events, sensors, scrolling. If it can say
  "something happened", it can make music.
- 🌍 **Put it online.** The web app is static files; visitors paste their own
  key. A tiny proxy that holds a shared key would let anyone play without one.

Grab a [good first issue](https://github.com/thisisvaze/skuzic/labels/good%20first%20issue),
[share an idea](https://github.com/thisisvaze/skuzic/issues/new/choose), or read
[CONTRIBUTING.md](CONTRIBUTING.md) to get set up. Curious how it works under the
hood? See [docs/how-it-works.md](docs/how-it-works.md).

## Good to know

- Your Gemini key stays in the browser (web) or the Keychain (iOS). It is not
  in the repo or the shipped binary. A public `pnpm build` is fine: each visitor
  pastes their own key.
- Lyria RealTime is an experimental Google model, so limits can change.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) © 2026 Aaditya Vaze. Free for
personal, research and educational use, but not for commercial use. If you share
or build on skuzic, keep the copyright notice and give it credit.
