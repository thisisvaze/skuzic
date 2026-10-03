# Contributing to skuzic

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Good places to start

- **Bugs.** Open an issue with steps to reproduce. Audio bugs are much easier to
  fix with a short screen recording or a screenshot of the mixer's History tab.
- **The palette.** `src/vision/palette.json` is every mood and instrument the
  drawing reader can pick. New entries change how skuzic sounds and need no
  audio knowledge.
- **The Reimagine prompt.** What Gemini does with your drawing lives in
  `SYSTEM_INSTRUCTION` in `src/llm/planner.ts`.
- **New event sources.** Anything that can become an event string fits the
  `event → actions → state` pipe.
- Issues labelled [`good first issue`](https://github.com/thisisvaze/skuzic/labels/good%20first%20issue).

For anything large, open an issue first so we can agree on the approach before
you spend time on it.

## Where things live

- `src/ui/`: the screens. `DrawCanvas.tsx` is the paper and the pen,
  `Mixer.tsx` the mixer, `Settings.tsx` everything you set once.
- `src/audio/touch.ts`: the pen's own sound.
- `src/vision/`: reading the drawing. `eyes.ts` picks a mix from
  `palette.json`; `ink.ts` turns how full and colourful the page is into
  energy and brightness.
- `src/llm/`: Gemini's prompts for Reimagine and for asking the band.
- `src/audio/lyria.ts` and `magenta.ts`: the two music engines. `server/` is
  the bridge that runs Magenta RT on your Mac.
- [`docs/how-it-works.md`](docs/how-it-works.md): the long version.

## Setup

### Web

```bash
pnpm install
pnpm dev
```

Paste a Gemini key from https://aistudio.google.com/apikey into the start
overlay (or Settings → Gemini API key). It is stored in localStorage.

### iOS

1. Open `ios/Skuzic.xcodeproj`
2. In *Signing & Capabilities*, pick your own team and change the bundle
   identifier. Don't commit those changes.
3. Run, then **Settings** (gear on the gallery, or Engine on a sketch) and
   paste your Gemini key. It is stored in the Keychain.

### Magenta RT2 (optional, Apple Silicon)

See [`server/README.md`](server/README.md).

## Before you open a PR

```bash
pnpm typecheck
pnpm test
sh ios/scripts/test-audio.sh   # macOS only; needed if you touched ios/
```

CI runs the same checks.

- Keep PRs focused: one fix or feature each.
- Say how you tested it. If you changed how it sounds, a short before/after
  recording helps more than any description.
- **Never commit API keys.** `.env` is gitignored; keys belong in the browser
  (localStorage) or the iOS Keychain, not in source.

## License of contributions

skuzic is [MIT licensed](LICENSE.md). By opening a pull request you agree that
your contribution is released under the same license.
