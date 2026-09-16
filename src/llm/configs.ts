/**
 * Arranger strategies.
 *
 * Everything about *how to write a prompt* is shared and lives in the planner's
 * core instruction. What differs between configs is the decision procedure:
 * given a drawing and a mix, what should change. Swapping that one section is
 * enough to give the instrument a different personality.
 */

export type PlannerConfigId = 'sparse' | 'vibe1' | 'realvibe' | 'sounds' | 'continuity';

export interface PlannerConfig {
  id: PlannerConfigId;
  label: string;
  /** One line, shown in the UI picker. */
  description: string;
  strategy: string;
}

const SPARSE: PlannerConfig = {
  id: 'sparse',
  label: 'Sparse v1',
  description: 'Starts near silence and grows only as the page earns it.',
  strategy: `STRATEGY — earn every sound

This deliberately overrides the core instruction wherever they conflict,
especially on how much to play. The default failure of this instrument is
answering a first shy mark with a finished band. This arranger's job is to make
the music *start* almost silent and stay behind the drawing at every step —
the page leads, the music follows.

Scale strictly with how much ink is actually on the canvas:

  one line, one small mark        1 track — a single quiet voice, nothing under
                                  it, density at or below 0.2
  a recognisable subject          2 tracks — floor and voice, density ~0.3
  half a page of drawing          2-3 tracks
  a full, worked page             3 tracks, and only a full page gets a third

One mark gets ONE track. Yes, the core rules call a lone prompt "a sound rather
than music" — here that is the point. A single fingerpicked figure or one soft
chord loop, alone in a room, is an invitation; a rhythm section behind someone's
first line is an ambush.

The second track is the FOUNDATION, and it enters solid. Listeners keep
choosing a bass-led bed over a chord-led one, and a bass that carries (volume
0.5-0.6) over the same bass as a whisper (0.4). Restraint means few tracks,
never a timid floor: when the bass arrives, let it be felt, and put chords
above it rather than instead of it.

When you add anything else, add the *quietest* useful thing, not the most
complete. Prefer MODIFY_TRACK to ADD_TRACK; prefer raising density a notch to
either. Never emit more than one ADD_TRACK per reply. If the drawing loses
weight — erased, simplified — take tracks away just as readily.

Keep every prompt small in its own words: "solo", "just", "sparse", "one
hand", "far away". A prompt that describes a section, a groove, or "the full
band" has already failed this strategy. Percussion enters last, if ever —
not before the page is half full.`,
};

const VIBE1: PlannerConfig = {
  id: 'vibe1',
  label: 'Vibe v1',
  description: 'Reads the whole drawing as one scene and cuts what no longer fits.',
  strategy: `STRATEGY — realign the mix to the whole drawing

Read the image as a complete scene, not as whatever was drawn most recently.
Before choosing any action, name its dominant vibe in one phrase: what world is
this, what weather, what energy, what time of day.

Then audit the mix against that vibe, one track at a time. For each live track
ask whether it still belongs in THIS scene — not whether it was reasonable when
it was added. Every track carries a from= field naming the event that created
it, and a track whose from= belongs to a scene no longer on the canvas is dead
weight, however good it sounded on its own.

  belongs as it is              -> leave it alone
  right job, wrong colour       -> MODIFY_TRACK into the new vibe
  belongs to a vibe that has
  left the canvas               -> REMOVE_TRACK
  doubles a job another track
  already holds                 -> REMOVE_TRACK, or fold the two into one

Only then add what the current vibe needs and the mix does not already have.

A sun alone is warm, open, unhurried. A sun with clouds and rain drawn over it
is not sun music with rain layered on top — it is overcast. The brightness has
to *leave*, not merely be joined. Expect to cut roughly as much as you add.

If you cannot say in a single phrase what the mix as a whole sounds like, you
are carrying a leftover: cut until you can. A mix that only ever grows stops
meaning anything.`,
};

const REALVIBE: PlannerConfig = {
  id: 'realvibe',
  label: 'Real Vibe',
  description: 'Rebuilds the whole mix from the current drawing, every time.',
  strategy: `STRATEGY — mirror the drawing, always

Every reply rebuilds the mix from scratch so it matches the drawing as it is
RIGHT NOW. Do not preserve tracks, do not audit them, do not ask what still
fits. The canvas is the only source of truth; the current mix is merely what
happened to be playing a moment ago.

Read the whole image, name its vibe, then emit exactly this shape:

  CLEAR_TRACKS
  ADD_TRACK  (as many as the scale rule allows — one per job, together
              describing that vibe completely)

Always this shape, every time — even when the drawing has barely changed. If
the vibe really is the same, your prompts will come out nearly the same and the
listener hears no difference. Do not try to be clever about which tracks to
keep; restating the whole mix is the point.

You do not need to soften the change. The instrument crossfades prompt weights
over about a second, so a full replacement is heard as the room turning rather
than as a cut. Describe the destination and let the transition take care of
itself.

Rebuilding from scratch is not licence to rebuild big. A single mark still gets
the two-track floor and nothing more. Where you do have a scene to fill, spend
the tracks in job order: the foundation that establishes the world first, then
the drawing's main character, then a rhythmic or textural detail last.

Rebuilding is also not licence to change bands. The idiom you are rebuilding in
is the idiom of the tracks you are clearing — read it off them before you clear
them, and put the new mix back inside it. A session that changes genre every
time the drawing changes is the worst thing this strategy can do.`,
};

const SOUNDS: PlannerConfig = {
  id: 'sounds',
  label: 'Sounds',
  description: 'Sound effects instead of music — whatever the scene would actually sound like.',
  strategy: `STRATEGY — sound, not music

Build what the scene would actually SOUND like, not a piece of music about it.
No melody, no chords, no beat, no key, nothing recognisable as an instrument
being played. If a prompt could name a musician performing it, rewrite it.

This deliberately overrides the core instruction wherever they conflict: ignore
the rules about naming an idiom, staying consonant, and leaving a musical
register open — none of them apply to a soundscape. Take the drawing literally
too: waves drawn means the sound of waves, a gun means gunshots, a screaming
face means a scream.

There are no limits on subject. Anything that makes a sound belongs:
  weather, place   rain on a roof, wind in trees, room tone, city hum, surf
  events, impacts  gunshots, glass shattering, a door slamming, an explosion
  people           laughter, a crowd murmuring, held breath, a scream, footsteps
  objects          a clock ticking, an engine idling, a fire crackling, a phone
  creatures        gulls, a dog barking, insects at night, wings

Read the STORY in the scene, not only the objects in it. A wide-eyed face with a
knife nearby is not "face sounds" — it is held breath, a floorboard creak,
something moving in the next room. A sun over a field is birdsong, distant
children, warm still air. The mood decides which sounds and how they are treated:
the same rain is cosy on a window and menacing on a tin roof at night.

Write each prompt as what makes the sound, then its character, distance and
motion:
  good: "steady ocean waves breaking on shingle, mid distance, wide stereo"
  good: "single sharp gunshot, long concrete reverb tail, then dead silence"
  good: "low uneasy room tone, faint irregular scraping somewhere behind a wall"
  bad:  "tidal swells rendered as filtered synth pads"   (that is music)
  bad:  "ocean"                                          (no character)

Mix continuous and intermittent. A scene made only of beds is lifeless; one made
only of hits is chaos. Read the job table below in sound-design terms: FOUNDATION
is the room's low rumble, BODY the sustained environmental layer, VOICE the one
sound the scene is *about*, MOTION the thing that intermittently happens. The
one-job-per-track rule holds exactly as written — two overlapping room tones
blur into each other the same way two pads do.

If something drawn has no natural sound — an abstract shape, a letter, a
scribble — give it texture rather than melody: friction, resonance, moving air,
electrical hum, distant machinery.`,
};

const CONTINUITY: PlannerConfig = {
  id: 'continuity',
  label: 'Continuity',
  description: 'Reacts to the newest change and transitions gradually.',
  strategy: `STRATEGY — continue or replace

FIRST DECIDE: does this event CONTINUE the current scene, or REPLACE it?

CONTINUE — the new element belongs beside what is already playing. Add one
track or modify one. Leave the rest alone. Usually one or two actions. If the
job the new element wants is already taken, modifying is the only option.

REPLACE — the event contradicts the mood the current tracks describe.
Contradiction is opposite energy (calm vs violent), opposite register (bright
vs dark), or opposite world (organic/acoustic vs synthetic/harsh). Then, in
this same reply, REMOVE_TRACK or MODIFY_TRACK every track carrying the old
mood as well as adding the new one. Layering a new mood over a contradicting
one makes mush, not a transition. Usually three or four actions.

Replace track by track, not all at once. Keep at least one existing track as a
bridge and MODIFY_TRACK it into the new mood — the listener should hear the
room change around them, not the music stop and restart.

  mix:   t1 "Cozy Felt Piano", t2 "Acoustic Guitar", t3 "Soft Footsteps Perc"
  event: "user drew lightning"
  wrong: ADD_TRACK "Thunder Crash"
         — the cozy guitar keeps strumming underneath the storm
  right: REMOVE_TRACK t2
         MODIFY_TRACK t1 -> "dark detuned piano clusters, heavy sustain"
         ADD_TRACK "Thunder Crash"

Each track carries a from= field: the event that created it. Tracks whose
from= belongs to a scene the user has moved on from are the first to cut.`,
};

export const PLANNER_CONFIGS: Record<PlannerConfigId, PlannerConfig> = {
  sparse: SPARSE,
  vibe1: VIBE1,
  realvibe: REALVIBE,
  sounds: SOUNDS,
  continuity: CONTINUITY,
};

export const PLANNER_CONFIG_LIST: PlannerConfig[] = [SPARSE, VIBE1, REALVIBE, SOUNDS, CONTINUITY];

export const DEFAULT_PLANNER_CONFIG: PlannerConfigId = 'vibe1';
