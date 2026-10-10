# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone who doodles. They need no music skills or music words: they open skuzic on a laptop, tablet or phone for a few minutes of play, draw whatever comes to mind, and want to hear something they enjoy.

Two secondary audiences follow from the confirmed success goals: builders who want to extend skuzic (the palette, the eyes, the engines), and people following real-time AI music who come to see what is possible.

## Product Purpose

skuzic is for making art with music: you draw, and the music plays along. It is not a music maker (the user, 2026-10-07: "the idea of this app is not to make music - but do art with music"). The music leans with your hand straight away; when you lift the pen the page is read and the music follows, so one continuous song bends around the drawing.

Success right now (all three confirmed):

- people play, stay with the pen, and come back;
- builders join in: stars, forks, and pull requests to the palette, the eyes and the engines;
- it shows what real-time AI music can do.

## Positioning

The song never stops or restarts; it bends to the page. Three things together make that true: the pen answers instantly on the device (a paper texture under every stroke, and the music leaning with your hand), an image model reads the whole page in the browser on pen-up (SigLIP 2, nothing uploaded), and Lyria RealTime streams one continuous piece that follows the reading. Drawing is the only input a visitor needs; no music knowledge, prompts or settings.

## Operating Context

- Played in the browser: the landing is at skuzic.vercel.app and the studio at skuzic.vercel.app/app (one app; vercel.json rewrites /app to it; going back to the landing pauses the music and keeps the drawing, and "Back to your drawing" picks the song up again), on a shared demo key: free, no sign-up. A visitor can connect their own free Gemini key (checked with Google, kept in the browser) when the shared key is slow or busy.
- Best with headphones. Browsers start audio only after a gesture, so the landing's start action is also what unlocks sound.
- The first visit downloads SigLIP 2's image model (63 MB, cached after that).
- A blank page offers vibes to start from, each with a short preview loop: Lo-fi, Ambient, Solo piano, Indie folk, Bossa nova, Jazz café, String quartet, or Just draw.
- For people who want to steer: the Mixer (every sound is a fader you can rewrite in plain words), Reimagine (Gemini rewrites the arrangement from the drawing), and typed requests such as "add a saxophone".
- Wiping the page winds the music down to silence; the next mark brings it back.

## Capabilities and Constraints

- Engines: Lyria RealTime (hosted, the default) and Magenta RT2 (offline on Apple Silicon Macs, only when self-hosting with the bridge; never on the hosted site).
- The drawing leaves the browser only when the visitor asks Gemini (Reimagine or a typed request).
- The pen's sound runs locally and works before the music connects.
- iPad and iPhone: a native port exists (`ios/`, on-device SigLIP via Core ML, the same pen sound). It is not distributed yet; a public release is planned but undated. Never present it as available.
- Lyria RealTime is an experimental Google model, so limits can change, and the shared key can be busy.
- Hosted relay: Vercel Hobby ends each connection after 5 minutes; skuzic reconnects with a short dip.
- Open source under MIT at github.com/thisisvaze/skuzic.

## Brand Commitments

- Name: "skuzic", always lowercase.
- Line: "Make art with music." (since 2026-10-07; the landing headline and page title). The README and social card still carry the older "Draw something. Hear it turn into music." until they are redone.
- Voice: plain, warm and concrete, in short sentences; it describes what you hear and do before the technology. No em dashes in copy. Credits the author as "An experiment by Aaditya Vaze."
- Terminology: call it "the music", never "the band" (the user's call, 2026-10-07). On the web, layers represent the drawing's moods and instruments; a vibe is the style they are played in, with no separate Style channel or intensity. "Your pen" is the instant sound under the nib. The primary action is "Start drawing", never "Make music".
- Bar: Apple-level polish, and music that stays bright and enjoyable over a long session.

## Evidence on Hand

- Product screenshots: `docs/cover-light.jpg`, `docs/cover-dark.jpg` (2560×1280), `.github/social-preview.jpg`.
- Real audio: vibe preview loops in `public/sounds/vibes/` (lofi, ambient, piano, folk, bossa, jazz, strings).
- Existing wordmark: a pencil line that is also a sound wave (`Wordmark` in `src/ui/Landing.tsx`), also in the studio header.
- Measured facts, with their source in `docs/how-it-works.md`: SigLIP reads a page in 21 to 30 ms on WebGPU; 12 of 12 test drawings landed in the right mood; a listening test raised enjoyment from 7.0 to 7.3 on Lyria and from 6.3 to 7.5 on Magenta.
- Absent: press, testimonials, user counts and ratings. Never invent them.

## Product Principles

1. Drawing is the whole interface. Anything a visitor must learn before the first stroke is a cost.
2. Sound answers at once; the music follows and never interrupts. The song bends, it does not restart.
3. Bright and pleasant over a long session: sparse, phrase-shaped sound beats constant feedback.
4. Private by default, and honest about it: the page is read on the device, and Gemini sees it only when asked.
5. Open to build on: anyone can add a vibe, a mood or an instrument without knowing audio.
