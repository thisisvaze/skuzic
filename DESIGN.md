---
name: skuzic
description: Make art with music.
colors:
  paper: "#fcfbf8"
  ink: "#2a2621"
  ink-soft: "#5f5850"
  watercolor-blue: "#2468ad"
  chrome: "#f2b705"
  on-watercolor: "#ffffff"
  pencil-blue: "#2d7dd2"
  pencil-orange: "#e2711d"
  pencil-violet: "#7c3aed"
  pencil-green: "#6a994e"
  pencil-pink: "#e26d9e"
  pencil-teal: "#1b998b"
  pencil-red: "#d1495b"
  pencil-amber: "#f0a202"
  pencil-indigo: "#3d348b"
  pencil-brown: "#8b5a2b"
typography:
  display:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2.5rem, 4.8vw, 4rem)"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 2.75rem)"
    fontWeight: 700
    lineHeight: 0.98
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  lead:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.625
  body-sm:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.375
  label:
    fontFamily: "Libre Franklin, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.375
rounded:
  none: "0"
  button: "1rem"
  full: "9999px"
spacing:
  gutter: "clamp(1.25rem, 4vw, 2.5rem)"
  container: "72rem (max-w-6xl)"
  section: "clamp(2.5rem, 5vw, 4rem)"
components:
  button-primary:
    backgroundColor: "{colors.watercolor-blue}"
    textColor: "{colors.on-watercolor}"
    rounded: "{rounded.button}"
    padding: "1.125rem 2rem"
  text-link:
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
  text-link-hover:
    textColor: "{colors.pencil-blue}"
  figure-caption:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
---

# Design System: skuzic

## Overview

**Creative North Star: "A box of coloured pencils on good paper"**

skuzic is for making art with music, and the landing looks like it: warm white paper, and every line on it drawn in the studio's own coloured pencils with the same paper grain. The colour lives in what is drawn: the visitor's lines and the example drawing. Everything else stays quiet and lined up, set in Libre Franklin in a warm charcoal, never pure black.

The page is a small playable experiment: one sun-and-sailboat scene draws itself, visitors add their own musical scribbles, and one button opens the studio. With reduced motion the scene rests finished. The user asked for an Experiments with Google feel and rejected the repeated hero and explanation sections (2026-10-07).

The world is light only, whatever the OS theme. It rejects the gradient headline, the tilted product card and three feature cards, the dark waveform music app, and black technical line art.

**Key Characteristics:**
- Paper, charcoal text, and the studio's pencils for everything drawn.
- Every drawn line carries the studio's paper grain (`.pencil`).
- One centered scene, one short invitation and one primary action.
- Motion is drawing: the scene draws itself once; visitors can scribble over it.
- Light only; no dark theme.

## Colors

Warm paper, a warm charcoal for words, the studio's pencil box for drawing, and a blue watercolor wash for the action.

### Primary
- **Watercolor Blue** (`watercolor-blue`): Start drawing uses a painted blue fill with pooled pigment and fine grain inside crisp, smooth corners (the user, 2026-10-07).

### The pencils
- **The studio's inks** (`pencil-*`): the colours `DrawCanvas` offers, minus its black, grey and brown (`INKS` in `src/ui/Landing.tsx`; brown is kept for wood in drawings). The wall hands them out in order, one per line, starting with blue. Illustrations use them like a person would: an amber sun with orange rays, blue and teal waves, a brown boat with a red sail.

### Neutral
- **Paper** (`paper`): the only background, the studio's own paper colour.
- **Charcoal** (`ink`): all text, the focus ring, and light rules at 12%.
- **Pencil Grey** (`ink-soft`): secondary copy and the note beside the opening button.
- **Chrome Yellow** (`chrome`): text selection, with charcoal on top.
- **Plate White** (`on-watercolor`): the label on the button.

### Named Rules
**The Colour Is Drawn Rule.** Colour comes from pencils and the watercolor button. No tinted sections or gradient text. The button uses layered blue washes to resemble pigment on paper.

**The No Black Line Art Rule.** Illustrations and the visitor's lines are never black or charcoal; the user found the black wire look "too much black" (2026-10-07). Charcoal is for words.

**The Blue Action Rule.** Start drawing stays blue, with a watercolor fill and restrained motion. Use the shared `WatercolorButton` component for the single landing action.

**The Daylight Rule.** The world is light only. Do not ship a dark variant or follow `prefers-color-scheme` on the page.

## Typography

**Font:** Libre Franklin, self-hosted variable (100 to 900), with ui-sans-serif, system-ui, sans-serif. Synthetic faces are off (`font-synthesis: none`).

### Hierarchy
- **Display** (650, `typography.display`, leading 1.08, tracking -0.045em): one centered title beneath the drawing. At small phone widths it balances over two lines.
- **Headline** (700, `typography.headline`, leading 0.98, tracking -0.03em): the short explanation in the left column, about 14ch wide, balanced.
- **Lead** (400, `typography.lead`): the paragraph under a statement, about 28 to 36rem wide.
- **Body** (400, `typography.body`): explanatory copy in Pencil Grey, about 40ch.
- **Body small** (400 or 500, `typography.body-sm`): nav and the note beside the opening button.
- **Label** (600, `typography.label`): figure captions, sentence case.

### Named Rules
**The Plain Words Rule.** It's art with music: the action is "Start drawing", never "Make music". Copy says "the music", never "the band", and uses no em dashes.

## Layout

A single experiment fills the landing, with a quiet wordmark and documentation link at the top and small project credits at the bottom. Keep the existing 72rem outer column and fluid gutters.

The whole landing page is the canvas, with no border or drawing box. A sun-and-sailboat illustration remains centered in a 44rem area, 13–22rem tall. Visitors can scribble across the margins and behind the text; words stay readable and links and buttons stay clickable. “Scribble anywhere. Hear it play.” explains it, and a labeled Clear control appears after the first mark. Clear removes visitor scribbles and keeps the illustration.

Under the scene: “Make art with music.”, “You draw. The music follows. See where it takes you.”, then one Start drawing button with its short note underneath. No second explanation, duplicate CTA, section rules or feature catalog. The main area flexes to fill available height on desktop; short screens scroll naturally. Phone layouts keep the same order with a two-line title and centered footer.

Desktop drawing works across the page. Touch devices start in scroll mode; a sticky Draw on page / Done drawing switch enables full-page drawing and returns to scrolling. Both the landing and studio use the shared local piano-and-paper brush engine. Landing styles live in `src/ui/landing.css`; layout tokens extend the existing palette in `tokens.css`.

## Texture & Depth

Drawn things get the studio's paper grain as a CSS mask: `Landing` renders `makeGrainTile()` from `DrawCanvas` once into `--grain`, and `.pencil` masks with it at 256px. Lines are the studio's `PENCIL` stroke (tapered by speed or pressure, ink alpha 0.88) at nib 6 on the wall, and an even 4 to 5 unit stroke in SVG drawings.

The page is flat. The watercolor button has a soft blue-grey shadow: `0 2px 4px` at 8% at rest, `0 3px 7px` at 10% on hover, and `0 1px 2px` at 8% when pressed. Its SVG fill combines blue pigment washes and fine static grain, clipped inside a crisp CSS boundary; the white label stays crisp.

## Motion

All of it sits inside `prefers-reduced-motion: no-preference`; otherwise each drawing rests finished.
- **Drawing in:** the example drawing is replayed stroke by stroke in the studio's own pencil (perfect-freehand, `PENCIL`, the paper grain), slowly, at a steady hand's pace with a breath between marks, about ten seconds in all, once on entry.
- **Buttons:** on a fine-pointer hover, two soft, irregular pools of blue pigment bloom through the fill over 900ms and 1200ms, the second starting 90ms later. The button and label stay still. Pools fade out over 400–500ms on pointer leave. A press settles to 98.5% scale over 120ms. No idle loop. Reduced motion disables the blooms, movement and transitions.

## Components

Keep the landing short and fun (the user, 2026-10-07): one playable scene, one short invitation and Start drawing, then a quiet footer. Vibes, sound labels, benchmarks and setup details do not need landing sections. Source, technical documentation and the license stay in the footer.

### Start drawing button (primary action)
- **Component:** `src/components/ui/watercolor-button.tsx`, with its own CSS. Accepts native button props, defaults to `type="button"`, and uses unique SVG IDs per instance.
- **Shape:** crisp 1rem corners with `corner-shape: superellipse(2)`, matching ViddyScribe's shared button. Browsers without corner-shape support use the same radius with normal rounded corners. The paint stays clipped inside the boundary. Padding 1.125rem by 2rem, minimum height 3.5rem, 1.125rem bold Plate White on Watercolor Blue. Keyboard focus, disabled and forced-colors states are included.
- **Placement:** centered below the title and one-sentence invitation, with its note beneath in Pencil Grey. Only one instance on the landing. Reads "Back to your drawing" when a session is open.

### Playable scene
- **Style:** one centered hand-drawn scene, with “Scribble anywhere. Hear it play.” and a Clear control after the first mark. The actual local pen engine plays visitor strokes. No second heading, numbered steps or model names.
- **The example drawing:** a sun over the sea made the way a hand makes it, never perfect geometry: a lopsided loop that runs past its start, uneven rays with round ends, two gulls, a leaning mast, loose waves of uneven humps. Strokes are hand-placed points joined by a spline, with seeded wobble and pressure, so it is the same drawing every visit. Long strokes taper; short dashes keep round ends, since any taper in perfect-freehand ends in a point.

### Text links and navigation
- **Style:** charcoal text; underlines are 2px thick, offset 0.2em. Nav links underline on hover; links that lead further in turn pencil blue on hover.
- **Navigation:** the shared `SkuzicLogo` at left and a GitHub pill at right with the live star count. Its amber star draws itself and shines once on load, then fills and shines again on hover. GitHub and MIT license sit in the compact footer alongside the author credit.
- **Focus:** 3px solid charcoal outline, 4px offset, everywhere.

## Do's and Don'ts

### Do:
- **Do** draw everything that's drawn in the studio's pencils, with the paper grain.
- **Do** keep words in charcoal and colour in drawings.
- **Do** line every section up on the shared grid, and keep items in a row or list on one top edge.
- **Do** make every control look like one: a button with a word or a familiar icon on it.
- **Do** let things draw themselves, and rest finished under reduced motion.
- **Do** frame it as art with music: "Start drawing", "the music", no em dashes.

### Don't:
- **Don't** draw illustrations or the visitor's lines in black or charcoal; the user found it "too much black" (2026-10-07).
- **Don't** stagger items to different heights, or hang abstract shapes as controls; the user found that "all over the place" (2026-10-07).
- **Don't** draw illustrations as perfect geometry (true circles, even rays, sine waves). The user asked for "a very natural hand made drawing", slow, "not perfect shapes" (2026-10-07).
- **Don't** call the action "Make music" or call the music "the band".
- **Don't** explain the product as numbered technical steps or lead with model names (SigLIP 2, Lyria RealTime). Share the mission and the vibe; the user called the steps "a developer's dump of text" (2026-10-07).
- **Don't** add a dark theme, gradient text, or tinted text panels.
- **Don't** replace the blue watercolor action with a flat red button.
- **Don't** build a hanging mobile or balancing weights; the user tried and rejected them.

## Shared brand mark

The logo is a bold scribble running into three round-ended bars, short, tall, medium, filled with the web app’s orange–pink–violet gradient (user, 2026-10-07: thicker, clean, never rough or hand-drawn). Use it on every branded surface. The gradient belongs to the mark; the word “skuzic” stays in the surrounding ink color.

- Web: `src/components/SkuzicLogo.tsx` owns the mark and wordmark for both the landing and studio headers. Compact mode hides only the name on phones and retains the accessible name.
- Canonical artwork: `public/brand/skuzic-mark.svg`, pure vector from the Figma export: the scribble and each bar are one path, each with its own stretch of the brand gradient, centred in a 1024 square so the app icon is the same art. There are no external image references or page-level SVG IDs. `docs/brand/skuzic-mark-bold.svg` is the Figma export itself.
- Browser icon: the same canonical SVG; `public/favicon.svg` remains a generated alias for previously cached URLs.
- iPad: `Wordmark` uses the generated `SkuzicMark` asset, and AppIcon uses the same gradient mark on warm paper. The web home-screen icon uses the same composition.
- Exports: run `pnpm brand:export` after updating the SVG. The exporter produces transparent inline artwork and opaque RGB app/home-screen icons.
