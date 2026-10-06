# Contributing to skuzic

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Good places to start

- **Bugs.** Open an issue with steps to reproduce. Audio bugs are much easier to
  fix with a short screen recording or a screenshot of the mixer's History tab.
- **The palette.** `src/vision/palette.json` is every vibe, mood and
  instrument skuzic can play. New entries change how it sounds and need no
  audio knowledge. A new vibe also wants a little picture in
  `src/ui/VibePicker.tsx` (until then it borrows the blank page's) and a
  preview loop: `scripts/make-vibe-previews.py <id>` renders one.
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

**Start drawing** asks for a Gemini key from https://aistudio.google.com/apikey
and checks it with Google (`checkGeminiKey` in `src/audio/lyria.ts`) before
saving it to localStorage. Settings → Gemini API key changes or removes it.

### iOS

1. Open `ios/Skuzic.xcodeproj`
2. In *Signing & Capabilities*, pick your own team and change the bundle
   identifier. Don't commit those changes.
3. Run, then **Settings** (the gear, in the gallery or on a sketch) and paste
   your Gemini key. It is stored in the Keychain.

The Simulator has no Pencil, so there the mouse draws. Debug builds also take
launch arguments for a scripted session: `-SkuzicDemo sea` (or `sun`) draws a
scene after ten seconds, and `-SkuzicPreview bossa` taps a vibe. The drawing
reader is `ios/Skuzic/Vision/SiglipEyes.mlpackage`, made by
`scripts/make-siglip-coreml.py`.

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
