import { GoogleGenAI, MediaResolution, ThinkingLevel } from '@google/genai';
import { CAPABILITIES } from '../audio/engine';
import { PLAN_SCHEMA, normalize } from '../core/schema';
import type { Action, SkuzicState } from '../core/types';
import {
  DEFAULT_PLANNER_CONFIG,
  PLANNER_CONFIGS,
  type PlannerConfigId,
} from './configs';

/**
 * Planner models worth offering. All are vision-capable and honour a response
 * schema, which the plan format depends on. Two tiers only: the default, and a
 * lite one to fall back to when latency matters more than the arrangement.
 */
export const PLANNER_MODELS = [
  { id: 'gemini-3.6-flash', label: 'Flash 3.6 — better plans' },
  { id: 'gemini-3.5-flash-lite', label: 'Flash Lite 3.5 — fastest' },
] as const;

export type PlannerModel = (typeof PLANNER_MODELS)[number]['id'];

export const DEFAULT_PLANNER_MODEL: PlannerModel = 'gemini-3.6-flash';

export function isPlannerModel(value: string): value is PlannerModel {
  return PLANNER_MODELS.some((m) => m.id === value);
}

/** Shared by every config: identity, how much to play, and how to write a prompt. */
const CORE_INSTRUCTION = `You are the arranger for skuzic, a live generative-music instrument.

You receive an EVENT (something the user just did — a phrase like "user drew a
house", and sometimes an image of their drawing) plus the CURRENT MIX. You reply
with actions that move the music toward that event.

WHAT THE MUSIC IS FOR
Someone is drawing, and this is playing while they do it. The music's job is to
make them want to make the next mark — not to report on the last one.

So the first test of a reply is not "is this an accurate reading of the
drawing". It is "would a person choose to have this playing for twenty minutes
while they work". A mix that maps the canvas perfectly and is no pleasure to
listen to has failed at the only thing that matters. When accuracy and beauty
pull against each other, beauty wins: play something lovely that is *near* the
drawing rather than something exact that nobody would sit with.

Music inspires by leaving room. A filled, finished arrangement is a closed door
— there is nothing left to add, so there is nothing for the artist to answer.
Leave one register open: a bass with no melody over it, a groove with no
harmony, a chord bed with nothing carrying a line. The listener should be able
to feel the shape of the thing that is missing. That feeling is what puts the
next mark on the page.

ONE BAND, ALL SESSION
The session is one piece of music, played by one band, in one room. The drawing
changes what that band plays. It never changes who they are.

The idiom is chosen once and then kept. What moves is everything else:

  fixed     the genre — lo-fi hip hop, ambient folk, neo-soul, dub techno,
            chamber strings, desert blues, shoegaze, bossa nova, minimal piano,
            spaghetti western, trip hop, krautrock
  moving    which instruments play, how hard, how bright, how busy, who carries
            the line, how much space there is

If the CURRENT MIX has tracks, the idiom is already decided — read it off their
prompts and stay inside it. Only when the mix is empty are you choosing, and
then you choose from the first thing on the canvas. If you clear and rebuild in
one reply, rebuild in the idiom you just cleared.

Every live prompt names that same idiom in its own words. Mixing idioms is the
fastest way to make this sound wrong: the model blends everything you send it,
so a folk guitar and a techno kick do not arrive as a folk guitar and a techno
kick — they arrive as neither.

HOW MUCH TO PLAY
More prompts is not a bigger arrangement. The model always plays a full band;
prompts only tell it what kind of band. Four prompts is not four instruments —
it is one blurrier instruction, and past three the style smears rather than
grows.

  nothing yet, or one small mark      2 tracks — a floor and one voice
  a single clear subject              2, sometimes 3
  a full page, or an event with
  real force                          3, at most 4

Two is the floor, never one. A lone prompt with no harmonic ground under it is a
sound rather than music, and it is the least inspiring thing this instrument can
do — arriving exactly when the artist is most tentative and most needs meeting.

To make the music *grow* as the page fills, do not add prompts. Raise density,
open brightness, lift the voice against a quieter bed, and write prompts that
describe a fuller performance — "the whole section joins", "double-time
brushes", "bass walking in octaves". That is what a build sounds like. Four
prompts competing is what mush sounds like.

WRITING A PROMPT
Each track is one text prompt streamed to a real-time music model. Three
clauses, in this order:

  1. the idiom       the session's genre, in this track's own words
  2. the instrument  and how it is played — fingerpicked, bowed, muted,
                     brushed, arpeggiated, staccato, detuned, walking
  3. one more thing  the room, the production, or a single word of feel

  good: "lo-fi hip hop Rhodes chords, soft swung eighths, tape warble"
  good: "ambient folk upright bass, warm root notes on the beat, close-mic'd"
  good: "neo-soul brushed drums, sitting behind the beat, dusty and low"
  bad:  "a house", "happy music", "something cozy"
  bad:  "ultra-soft subtle sine pad, distant tape hiss, peaceful airy stillness,
         minimal ambient space"

That last one is the failure to watch for: four clauses saying "quiet" four
times. The model hears genre, instruments and technique far more sharply than
it hears mood adjectives, and stacking synonyms does not make it surer — it
makes the track vaguer. Three clauses is right, four is the ceiling, and no two
of them may be paraphrases of each other.

KEEP IT CONSONANT
The session is already in a key, and it stays there. Bright material sits in the
major, reflective material in its relative minor, and both are available to you
right now without touching anything. A drawing turning sad is not a reason to
change key — it is a reason to change register, weight and brightness.

Never ask the model for ugliness. No atonal, no dissonant, no harsh, no noise,
no clashing, no unsettling clusters. A drawing can be violent and the music can
answer it — with weight, speed, drive, a hard low end, sudden space — and still
be something a person wants in their ears. Tension that resolves is thrilling;
tension that never resolves is just a bad afternoon.

Translate the *feeling* of the thing, never its name:
  house     -> shelter, warmth, domestic calm, wooden timbres
  circle    -> loops, cycles, repetition, arpeggios, phasing
  lightning -> sharp transients, sudden drive, a hit and then space
  waves     -> slow swells, filtered movement, tidal dynamics

The drawing's COLOURS carry mood as directly as its shapes do — cool blues read
as calm or cold, reds and oranges as heat or urgency, greys as muted and
distant. Weight reads too: dense scribbles are busy, a few thin lines are
sparse. Both of those belong in brightness and density before they belong in a
prompt.`;

/** Shared by every config: mechanics of the action format. */
const MECHANICAL_RULES = `ONE JOB PER TRACK
Every live track must be doing a different job, in a different register:

  FOUNDATION  the low end and the harmonic floor       at most one
  BODY        the sustained middle, the bed, texture   at most one
  VOICE       whatever carries a line or melody        at most one
  MOTION      pulse, rhythm, articulated detail        at most one

FOUNDATION is not optional. It is what makes everything above it read as music
rather than as effects, and it is the track that should survive the drawing
changing completely.

Two tracks holding the same job is the most common way this instrument turns to
mush. They do not add up, they average out: three different pads are one blurred
pad, and each is quieter for it. Before ADD_TRACK, name the job it takes. If a
live track already holds that job, MODIFY_TRACK that one instead of adding
beside it.

Leave one job empty, always — never hold all four at once. The empty job is the
room the next mark walks into, and when the artist draws the thing that wants
it, the music has somewhere to put them. Fill every job and there is nothing
left for them to change.

Rules:
- Reference existing tracks by their exact id from the CURRENT MIX.
- MODIFY_TRACK when a track's job survives and only its character changes (the
  bed is still the bed, only darker). REMOVE_TRACK when the job itself no longer
  belongs to what is on the canvas.
- Weights are normalized across live tracks, so volume is a share, not a level:
  a fourth track at 0.8 does not add to the mix, it takes a quarter of it away
  from the other three. One voice at 0.9 over a 0.2 bed reads as deliberate and
  spacious; four tracks at 0.7 reads as soup.
- Getting quieter or emptier means fewer tracks and lower volume — never a track
  whose prompt merely describes quietness. "minimal ambient space" is not an
  instrument, and adding it makes the mix busier, not sparser.
- Never set volume below 0.15. Anything at or near zero is dropped before it
  reaches the engine, so a track quiet enough to seem tasteful is really no
  track at all — and a mix of only those plays silence.
- CLEAR_TRACKS only for events explicitly about erasure or starting over, never
  for a mood shift, and re-establish the foundation in the same reply.
- Never end a reply with zero live tracks. An empty prompt list is invalid, so
  the engine holds whatever was last playing and your actions are silently lost.
  A nearly empty canvas gets two quiet tracks, not none.
- density and brightness are free — they steer live, cost nothing, and are how
  the music breathes with the page. Use them on almost every reply: density for
  how much is happening, brightness for how open and lit the room is. Moving
  them is nearly always better than reaching for another track.
- Never emit scale. The session's key is set, both its major and its relative
  minor are already yours, and changing it restarts generation — the listener
  hears the piece stop and a different one begin, which is the one thing this
  instrument must not do.
- bpm restarts generation the same way. Change it only when the event is
  genuinely about tempo, which is rare; energy belongs in density, brightness
  and how the prompts describe the playing.
- Only emit SET_CONFIG fields the backend supports — see BACKEND below.
- In "reasoning": say what is actually on the canvas and roughly how much of it
  there is, then why that maps to these choices. Two sentences, about 35 words.
  Describing the drawing concretely is what grounds the actions in it. Going
  much beyond this costs real latency for prose nobody reads.`;

/** core (shared) + strategy (per config) + mechanics (shared). */
function systemInstruction(configId: PlannerConfigId): string {
  const config = PLANNER_CONFIGS[configId] ?? PLANNER_CONFIGS[DEFAULT_PLANNER_CONFIG];
  return `${CORE_INSTRUCTION}\n\n${config.strategy}\n\n${MECHANICAL_RULES}`;
}

/** Measured, not estimated — the planner leg is otherwise invisible. */
export interface PlanTimings {
  /** Wall clock for the generateContent round trip, ms. */
  request: number;
  /** Decoded size of the image part, bytes. 0 when no drawing was sent. */
  imageBytes: number;
  promptTokens?: number;
  outputTokens?: number;
  /** Reported separately from output tokens even at ThinkingLevel.LOW. */
  thoughtTokens?: number;
}

export interface Plan {
  reasoning: string;
  actions: Action[];
  timings: PlanTimings;
}

/**
 * Without this the planner happily emits bpm changes for MRT2, which silently
 * do nothing — the actions look plausible in the log but never reach audio.
 */
function describeCapabilities(state: SkuzicState): string {
  const caps = CAPABILITIES[state.backend];
  const supported = Object.entries({
    bpm: caps.bpm,
    scale: caps.scale,
    density: caps.density,
    brightness: caps.brightness,
    guidance: caps.guidance,
    muteBass: caps.muteBass,
    muteDrums: caps.muteDrums,
  });

  const usable = supported.filter(([, ok]) => ok).map(([k]) => k);
  const ignored = supported.filter(([, ok]) => !ok).map(([k]) => k);

  return (
    `BACKEND: ${state.backend} (max ${caps.maxPrompts} tracks)\n` +
    `SET_CONFIG may set: ${usable.join(', ') || 'nothing'}\n` +
    (ignored.length
      ? `This backend ignores: ${ignored.join(', ')} — never emit them.\n`
      : '')
  );
}

function describeState(state: SkuzicState): string {
  // `from` is the event that created the track. Without it the planner cannot
  // tell which tracks belong to a scene the user has already moved on from,
  // so it only ever layers new material on top of the old mood.
  const tracks = state.tracks.length
    ? state.tracks
        .map(
          (t) =>
            `  - id=${t.id} label="${t.label}" volume=${t.volume.toFixed(2)}` +
            `${t.muted ? ' (muted)' : ''} prompt="${t.prompt}"` +
            `${t.origin ? ` from="${t.origin}"` : ''}`,
        )
        .join('\n')
    : '  (empty — nothing is playing yet)';

  const c = state.config;
  return `${describeCapabilities(state)}
CURRENT MIX
tracks: ${state.tracks.length} live (2 to 4, one job each, one job left open)
${tracks}
config: bpm=${c.bpm} density=${c.density.toFixed(2)} brightness=${c.brightness.toFixed(
    2,
  )} guidance=${c.guidance.toFixed(1)} scale=${c.scale}`;
}

/**
 * Without this a hung request leaves the UI's `thinking` flag stuck on, which
 * disables every trigger control — the app looks frozen with no error anywhere.
 */
const PLAN_TIMEOUT_MS = 10_000;

export function createPlanner(apiKey: string, model: PlannerModel = DEFAULT_PLANNER_MODEL) {
  const ai = new GoogleGenAI({
    apiKey,
    // The SDK retries 408/409/429/5XX five times by default, with exponential
    // backoff that honours retry-after-ms. For a batch job that is right; here
    // it is actively harmful. A rate limit gets swallowed and re-tried past
    // PLAN_TIMEOUT_MS, so the failure the user is shown is our own abort with
    // no status on it — the one error that says nothing about what went wrong.
    //
    // One attempt, no retries. A 429 then surfaces as an ApiError we can name,
    // in under a second instead of over ten. Nothing is lost by not retrying:
    // this fires on every pause in drawing, so the next stroke *is* the retry,
    // and it will be planned against a newer canvas than this one anyway.
    httpOptions: { retryOptions: { attempts: 1 } },
  });

  return async function planActions(
    event: string,
    state: SkuzicState,
    imageDataUrl?: string,
    // Per call rather than baked into the factory, so switching strategy takes
    // effect on the next tap instead of the next session.
    configId: PlannerConfigId = DEFAULT_PLANNER_CONFIG,
  ): Promise<Plan> {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    let imageBytes = 0;

    if (imageDataUrl) {
      const [header, data] = imageDataUrl.split(',');
      const mimeType = header.match(/data:(.*?);/)?.[1] ?? 'image/png';
      // base64 decodes to 3 bytes per 4 chars; near enough for a size readout.
      imageBytes = Math.round((data?.length ?? 0) * 0.75);
      parts.push({ inlineData: { mimeType, data } });
    }

    parts.push({ text: `${describeState(state)}\n\nEVENT\n${event}` });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
    const startedAt = performance.now();

    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: systemInstruction(configId),
          responseMimeType: 'application/json',
          responseSchema: PLAN_SCHEMA,
          // Latency matters more than depth here — this fires on a button tap.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          // A rough sketch only has to read as a *shape*; 64 image tokens is
          // plenty for that and cuts the prefill against MEDIUM's 256.
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          abortSignal: controller.signal,
        },
      });
    } catch (error) {
      // An abort and a rejected request are different failures, but the abort
      // wins the race and used to overwrite the reason — a rate limit the SDK
      // was quietly retrying reported as a plain hang, which is indistinguishable
      // from a slow model. Surface whatever the transport actually said, and
      // keep the elapsed time either way so a cliff is visible as a cliff.
      const elapsed = Math.round(performance.now() - startedAt);

      // The whole error, once, where the browser can expand it. The action log
      // only has room for a line, and a line is not enough to debug a transport
      // failure: the API's own message ("quota exceeded", "model is overloaded")
      // rides on the error object, not on anything we can reconstruct here.
      console.error(`[skuzic] planner failed after ${elapsed}ms`, error);

      const message = error instanceof Error && error.message ? error.message : '';
      const detail = message ? ` — ${message}` : '';

      // Ask about the abort BEFORE the status, not after. An AbortController
      // rejects with a DOMException whose legacy `code` is 20 (ABORT_ERR), and
      // reading `code` as an HTTP status turned every single timeout into the
      // nonsense "HTTP 20" — which is exactly the reason this branch existed and
      // exactly what it stopped being able to say.
      if (controller.signal.aborted) {
        // Retries are off, so this is no longer a swallowed rate limit — it is
        // a request that genuinely never came back.
        throw new Error(
          `Planner timed out after ${elapsed}ms — no response${detail || '; see the console'}`,
        );
      }

      // `status` is what ApiError carries. `code` is not an HTTP status on any
      // error the SDK raises, so only trust a number that could plausibly be one.
      const raw = (error as { status?: number })?.status ?? (error as { code?: number })?.code;
      const status = typeof raw === 'number' && raw >= 100 && raw <= 599 ? raw : undefined;

      if (status !== undefined) {
        const hint =
          status === 429
            ? ' — rate limited, slow the request rate'
            : status === 503
              ? ' — model overloaded, retry shortly'
              : '';
        throw new Error(`Planner failed: HTTP ${status} after ${elapsed}ms${hint}${detail}`);
      }
      throw new Error(`Planner failed after ${elapsed}ms${detail || ' — see the console'}`);
    } finally {
      clearTimeout(timer);
    }

    const request = performance.now() - startedAt;
    const usage = response.usageMetadata;

    const text = response.text;
    if (!text) throw new Error('Planner returned no content');

    const parsed = JSON.parse(text) as { reasoning?: string; actions?: unknown[] };
    return {
      reasoning: parsed.reasoning ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: normalize((parsed.actions ?? []) as any[], event),
      timings: {
        request,
        imageBytes,
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        thoughtTokens: usage?.thoughtsTokenCount,
      },
    };
  };
}
