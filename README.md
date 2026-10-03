<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/cover-dark.jpg">
  <img alt="skuzic: a sketchpad that plays along with whatever you draw" src="docs/cover-light.jpg">
</picture>

# skuzic

**Draw something. Hear it turn into music.**

[![CI](https://github.com/thisisvaze/skuzic/actions/workflows/ci.yml/badge.svg)](https://github.com/thisisvaze/skuzic/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)

skuzic is an instrument you play with a pen. Sketch a house and the music gets
warm and woody. Scribble a storm and it darkens. The song never stops or
restarts. It just keeps bending around whatever you draw.

```
you draw a house
  → you hear the paper under the pen, and a soft piano answers in key
  → you lift the pen: SigLIP 2 reads the page, also in the browser: "home and city"
  → the band follows: cozy and nostalgic, warm Rhodes in front, the beat never stops
  → Lyria RealTime plays the new sound, live
```

Want to steer it yourself? Open the **Mixer**. Every sound is a fader you can
turn up, switch off or rewrite in plain words, and knobs like Energy and
Brightness do what they say. Or tap **Reimagine** and Gemini rewrites the whole
arrangement from your drawing.

Works in the browser and on iPad/iPhone; the pen's sound and the in-browser
reading are web-only for now. On a Mac you can also generate the audio locally
with Google's open Magenta RT2 model.

## Try it

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173, paste a Gemini key from
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), hit **Start
drawing**, and draw. The key stays in your browser; it is never baked into the
build. The first visit also downloads SigLIP 2's image model (63 MB, cached
after that).

On iPad/iPhone: open `ios/Skuzic.xcodeproj`, run, then **Settings** (gear) and
paste the same kind of key. It lives in the Keychain, not the app binary.

## Build it with us

skuzic is early and there's a lot of fun stuff left to make:

- 🎛️ **Give it taste.** `src/vision/palette.json` holds the moods and
  instruments a drawing can turn into. Add a mood like "snow" or an instrument
  you love; you don't need to know anything about audio.
- ✏️ **Read drawings better.** Right now the whole page is one picture. Where
  you draw, how fast, and how hard you press could all shape the music.
- 🎹 **Draw melodies.** Magenta RT takes piano-roll notes. Today skuzic uses
  them to hold a chord loop; lines could become tunes.
- 🎚️ **Play it like a deck.** Map a MIDI controller to the mixer, pick a genre,
  or record a clip to share.
- 🎮 **Play it with anything.** Game events, sensors, scrolling. If it can say
  "something happened", it can make music.

The [open issues](https://github.com/thisisvaze/skuzic/issues) each say where to
start, and the [good first ones](https://github.com/thisisvaze/skuzic/labels/good%20first%20issue)
are small. [CONTRIBUTING.md](CONTRIBUTING.md) gets you set up, and
[docs/how-it-works.md](docs/how-it-works.md) has the long version of how it all
fits together.

## Good to know

- Your Gemini key stays in the browser (web) or the Keychain (iOS). It is not
  in the repo or the shipped binary. A public `pnpm build` is fine: each visitor
  pastes their own key.
- Lyria RealTime is an experimental Google model, so limits can change.

## License

[MIT](LICENSE.md) © 2026 Aaditya Vaze. Use it, change it, build on it. A link
back is always appreciated.
