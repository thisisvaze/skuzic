---
version: 1
slug: "src-ui-landing-tsx"
primary_target: "src/ui/Landing.tsx"
related_targets: []
---

# Landing

Mode: Play. Scope: the landing overlay (`src/ui/Landing.tsx`), shown on a first visit and from the studio wordmark. Light only: a daylit drawing experiment, whatever the OS theme.

- Audience and job: anyone who doodles; within seconds they see the wall takes a pen and hear their line ring, then press the single Start drawing action. It's art with music, not a music maker (user, 2026-10-07: "the idea of this app is not to make music - but do art with music"). Builders and the curious find how it works and the source.
- Action: draw on the live wall (the local pen engine, no key needed); primary: Start drawing, which opens the studio at /app (the key dialog only appears without the demo relay).
- Proof: the live pen and the animated sun-and-sailboat drawing. The explanation is short and playful; detailed evidence and implementation live in the linked documentation.
- Constraints: call it "the music", never "the band" (user, 2026-10-07); no balancing mobile or weights (user, 2026-10-07: "the balancing weights doesnt go well"); shadows stay light (user: "shadows look soo much"); the main invitation keeps its words to the headline and one line (user, 2026-10-07: "too much text"); no black line art (user, 2026-10-07: "too much black", asked for more animation and colours that read as hand-drawn art); nothing staggered or hung, and every control looks like a control (user, 2026-10-07, on the stepped stations and hanging vibe plates: "it just looks all over the place", "what is this - i dont even understand this"); no em dashes; never present the iPad app as available; no invented press, numbers or users; landing and studio use the shared `SkuzicLogo`, with the bold scribble-and-three-bars mark and orange–pink–violet gradient (user, 2026-10-07).
- Memorable moment: a sun and sailboat draw themselves on open paper; visitors add musical scribbles to the scene, then open the studio.
- Unresolved: carrying the landing drawing into the studio; when the studio adopts this world.

## Direction contract

THESIS: Make art with music: warm paper where every line is the studio's coloured pencil and rings in key, with a blue watercolor button to start drawing. Refuses the gradient headline, tilted product card and three feature cards, and the dark waveform music app.

OWN-WORLD: The studio's paper as ground. Every drawn thing in the studio's pencils with its paper grain; words in warm charcoal; light 1px rules. The action is a blue watercolor wash within crisp, smooth 16px corners. Libre Franklin; small exact labels.

STORY: See a drawing, add a musical scribble, start drawing. One centered scene, one title, one short sentence and one blue CTA. A quiet footer follows. No repeated explanation, vibe catalog or separate closing pitch.

FIRST VIEWPORT: A single experiment on open paper. The whole page is a playable canvas behind the centered sun-and-sailboat illustration and readable text. A short sound hint and a Clear control after drawing explain it. Touch devices have a Draw on page / Done drawing switch to preserve scrolling. Beneath it: “Make art with music.”, “You draw. The music follows. See where it takes you.”, and one blue watercolor Start drawing button. Wordmark and documentation link stay at the top; credits at the bottom.

FORM: Playful, centered experiment, reworked 2026-10-07 after the user rejected the two repeated sections and asked for an Experiments with Google feel. Motion is the scene drawing itself and blue pigment on button hover. Paper, pencil texture, Libre Franklin and the crisp blue squircle button remain.

FINISH: Production build and typecheck pass. The desktop page fits in one viewport. Drawing plays audio and enables the clear control; clearing resets it. Mobile visual verification was interrupted by the shared browser changing state; do not treat the phone widths as visually verified.

BUTTON: The single Start drawing action uses the shared `WatercolorButton`. Blue pigment and fine grain sit inside a crisp 16px boundary with ViddyScribe’s `superellipse(2)` corners. Two soft pools spread on hover and fade on leave, clipped inside the edge. Native button semantics and reduced-motion support remain.
