# Contributing to skuzic

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Good places to start

- **Bugs.** Open an issue with steps to reproduce. Audio bugs are much easier to
  fix with a short screen recording or the action log.
- **The planner prompt.** Nearly all of the perceived quality lives in
  `SYSTEM_INSTRUCTION` in `src/llm/planner.ts`. Better event → mix translations
  are high-impact and need no audio knowledge.
- **New event sources.** Anything that can become an event string fits the
  `event → actions → state` pipe.
- Issues labelled [`good first issue`](https://github.com/thisisvaze/skuzic/labels/good%20first%20issue).

For anything large, open an issue first so we can agree on the approach before
you spend time on it.

## Setup

### Web

```bash
pnpm install
pnpm dev
```

Paste a Gemini key from https://aistudio.google.com/apikey into the start
overlay (or Engine → Gemini API key). It is stored in localStorage.

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
- Say how you tested it. For audio changes, say what you listened for.
- **Never commit API keys.** `.env` is gitignored; keys belong in the browser
  (localStorage) or the iOS Keychain, not in source.

## License of contributions

skuzic is licensed under [PolyForm Noncommercial 1.0.0](LICENSE.md): free for
personal, research and educational use, not for commercial use.

By submitting a contribution you agree that:

1. it is your own work, or you have the right to submit it, and
2. it is licensed under the project license, and you grant Aaditya Vaze a
   perpetual, irrevocable, worldwide, royalty-free right to use, modify and
   relicense your contribution under any terms.

Point 2 keeps the door open for skuzic to move to a new home or license later
(for example, a larger AI-experiments program) without tracking down every past
contributor.
