import { GoogleGenAI, MediaResolution, ThinkingLevel, Type, type Schema } from '@google/genai';
import { geminiAuth } from '../lib/relay';
import { CAPABILITIES } from '../audio/engine';
import { PLAN_SCHEMA, normalize } from '../core/schema';
import type { Action, MixConfig, SkuzicState, Track } from '../core/types';
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
  { id: 'gemini-3.8-flash', label: 'Smarter', detail: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Faster', detail: 'Gemini 3.5 Flash Lite' },
] as const;

export type PlannerModel = (typeof PLANNER_MODELS)[number]['id'];

/**
 * The better planner by default: SigLIP reacts to every pen-up, so Gemini's
 * passes (a refine every few seconds while the page changes, a full rethink on
 * Reimagine) can wait a second longer for better words.
 */
export const DEFAULT_PLANNER_MODEL: PlannerModel = 'gemini-3.8-flash';

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

One layer names the idiom: the style, at weight 1.0, kept all session. Every
other layer lives inside it and does not repeat the genre; repeating it in
every prompt was measured to make every drawing sound alike. Mixing idioms is
still the fastest way to make this sound wrong: the model blends everything you
send it, so a folk guitar and a techno kick do not arrive as a folk guitar and
a techno kick. They arrive as neither.

HOW MUCH TO PLAY
More prompts is not a bigger arrangement. The model always plays a full band;
prompts only tell it what kind of band, and past four the style smears rather
than grows.

  nothing yet, or one small mark      style, mood and one instrument
  a recognisable subject              style, mood, a lead and a second
                                      instrument: four, the ceiling

Three is the floor. A style and a mood with nothing to play them is a sound
rather than music, and it would arrive exactly when the artist is most
tentative and most needs meeting.

To make the music grow as the page fills, do not add layers. Raise density,
open brightness, and let the lead's words describe a fuller performance:
"strings swelling", "double-time brushes", "bass walking in octaves". That is
what a build sounds like. Layers competing is what mush sounds like.

WRITING THE LAYERS
Each layer is a short text prompt with its own weight, the way these music
models are meant to be steered. The words are yours; the shape is not:

  style    the genre, once                  "dreamy lo-fi hip hop"      1.0
  mood     two words for the feeling        "gentle and bittersweet"    0.45
  lead     an instrument and how it plays   "soft felt piano melody"    0.6
  second   another, under the lead          "twinkling glockenspiel"    0.4

On BACKEND magenta, keep the style to the bare genre ("lo-fi hip hop") and give
the mood more weight, 0.8. That balance measured best there; the lighter mood
and the "dreamy" style measured best on lyria.

  bad:  "a house", "happy music", "something cozy"
  bad:  "lo-fi hip hop Rhodes chords, soft swung eighths, tape warble"
  bad:  "ultra-soft subtle sine pad, distant tape hiss, peaceful airy stillness"

The first says nothing a model can play. The second is a whole track in one
prompt with the genre repeated; in a listening test that shape scored lowest of
everything tried. The third says "quiet" four times: stacking synonyms does not
make the model surer, it makes the layer vaguer. Two to six words a layer, and
the mood's two words should point the same way, not restate each other.

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
const MECHANICAL_RULES = `ONE ROLE PER LAYER
Every live layer holds a different role:

  STYLE   the genre; it brings the band's own bass and drums    exactly one
  MOOD    how it feels                                          exactly one
  VOICE   the lead instrument, carrying the line                exactly one
  BODY    a second instrument: a bed, a texture or a pulse     at most one

STYLE is the floor. It is what makes everything above it read as music rather
than as effects, and it is the layer that should survive the drawing changing
completely.

Two layers in one role is the most common way this instrument turns to mush.
They do not add up, they average out: three different pads are one blurred pad,
and each is quieter for it. Before ADD_TRACK, name the role it takes. If a live
layer already holds that role, MODIFY_TRACK that one instead of adding beside it.

Four is the ceiling. A third instrument does not add a part; it blurs the two
already playing.

Rules:
- Reference existing tracks by their exact id from the CURRENT MIX.
- MODIFY_TRACK when a track's job survives and only its character changes (the
  bed is still the bed, only darker). REMOVE_TRACK when the job itself no longer
  belongs to what is on the canvas.
- Weights are normalized across live tracks, so volume is a share, not a level:
  a fourth layer at 0.8 does not add to the mix, it takes a share of it away
  from the other three. A clear lead over a light second reads as deliberate
  and spacious; four layers at 0.7 reads as soup.
- Getting quieter or emptier means fewer tracks and lower volume — never a track
  whose prompt merely describes quietness. "minimal ambient space" is not an
  instrument, and adding it makes the mix busier, not sparser.
- Never set volume below 0.15. Anything at or near zero is dropped before it
  reaches the engine, so a track quiet enough to seem tasteful is really no
  track at all — and a mix of only those plays silence.
- CLEAR_TRACKS only for events explicitly about erasure or starting over, never
  for a mood shift, and re-establish the style in the same reply.
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

/**
 * The follow-up pass, every few seconds while the page changes. SigLIP names
 * the page's things in milliseconds, but in stock words: it can't see colour,
 * line or story, so violet water and blue water sound the same. Gemini sees the
 * drawing and rewrites those words for it, keeping the mix's shape so the two
 * readers never pull the arrangement between them. Its own short instruction
 * and reply shape: under the arranger's, Gemini answered with knob moves only,
 * leaving every layer's words as they were.
 */
const REFINE_INSTRUCTION = `You voice the music for skuzic, a live instrument: someone is drawing, and this
plays while they do. A fast on-device reader has just set the mix. It names the
things on the page ("water", "mountains"), gives each a stock mood written
before anyone drew anything ("flowing and serene"), and picks instruments. It
cannot see colour, line, style or story: violet water and blue water get the
same words. You can see the drawing. Make the music belong to this drawing in
particular by rewriting the words of every layer except Style.

  a thing        its label is what was drawn. Write its mood as this drawing
                 shows it: what its colours, line and company make you feel.
  an instrument  its label is the instrument. Keep the instrument and say how
                 it plays here: register, figure, touch.

Two to six words a layer, the feeling first, and no genre words: the Style layer
holds the genre, and repeating it makes every drawing sound alike. Keep it
lovely: never atonal, dissonant, harsh or noisy; a dark or violent page gets
weight, drive and space instead. Translate the feeling of a thing, not its name.
Words from an earlier pass, anything more specific than a stock phrase, stay
unless the drawing has changed past them.

  a sun in pale yellow crayon      sunshine: "soft, hazy and golden"
  the same sun in thick red marker sunshine: "blazing, bold and urgent"
  a face in soft grey pencil       face: "tender and wistful"
                                   felt piano: "felt piano, slow and rubato"
  rain in dense black scribbles    rain: "heavy, restless and dark"
                                   harp: "harp, quick falling runs"

Set density from how much is drawn and how busy the line is, and brightness
from how warm and light the colours are. In reasoning, one sentence of about 20
words on what this drawing has that the stock words missed.`;

const REFINE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reasoning: { type: Type.STRING, description: 'What this drawing has that the stock words missed.' },
    layers: {
      type: Type.ARRAY,
      description: 'Every layer except Style, with its words for this drawing.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'The track id from the CURRENT MIX.' },
          words: { type: Type.STRING, description: 'Two to six words, the feeling first.' },
        },
        required: ['id', 'words'],
      },
    },
    density: { type: Type.NUMBER, description: '0.0 sparse to 1.0 busy.' },
    brightness: { type: Type.NUMBER, description: '0.0 dark to 1.0 bright.' },
  },
  required: ['reasoning', 'layers', 'density', 'brightness'],
};

/** The event the follow-up pass sends with the drawing. */
export const REFINE_EVENT = 'Rewrite every layer except Style for this drawing.';

type Knobs = Pick<MixConfig, 'density' | 'brightness'>;

/**
 * What a refine pass may change: a layer's words, never the Style layer's, and
 * the two live knobs, kept in their gentle range. Anything else is dropped, so
 * Gemini can't restructure the eyes' mix. A target matches by id, or by label
 * when the eyes rebuilt the tracks while Gemini was thinking.
 */
export function keepRefinement(actions: Action[], tracks: Track[], knobs: Knobs) {
  const find = (target: string) =>
    tracks.find((t) => t.id === target) ?? tracks.find((t) => t.label.toLowerCase() === target.toLowerCase());
  const round = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
  const kept: Action[] = [];
  const words = new Map<string, string>();
  let next: Knobs | null = null;
  for (const action of actions) {
    if (action.type === 'MODIFY_TRACK' && action.prompt) {
      const track = find(action.target);
      if (!track || track.label === 'Style' || track.prompt === action.prompt) continue;
      kept.push({ type: 'MODIFY_TRACK', target: track.id, prompt: action.prompt });
      words.set(track.label, action.prompt);
    } else if (action.type === 'SET_CONFIG') {
      const { density, brightness } = action.config;
      if (density === undefined && brightness === undefined) continue;
      const was: Knobs = next ?? knobs;
      next = { density: round(density ?? was.density, 0.15, 0.85), brightness: round(brightness ?? was.brightness, 0.15, 0.9) };
    }
  }
  if (next) kept.push({ type: 'SET_CONFIG', config: next });
  return { actions: kept, words, knobs: next };
}

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
  /** The model that answered: the chosen one, or the other tier when it was out of quota or overloaded. */
  model: PlannerModel;
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
tracks: ${state.tracks.length} live (style, a mood for each thing drawn, and one or two instruments)
${tracks}
config: bpm=${c.bpm} density=${c.density.toFixed(2)} brightness=${c.brightness.toFixed(
    2,
  )} guidance=${c.guidance.toFixed(1)} scale=${c.scale} muteDrums=${c.muteDrums} muteBass=${c.muteBass}
LOCKED CONTROLS: ${Object.entries(state.configLocks).filter(([, locked]) => locked === true).map(([field]) => `${field}=${c[field as keyof MixConfig]}`).join(', ') || 'none'}
Never change a locked control, even when the event asks for it. The user must unlock it first.`;
}

/**
 * Without this a hung request leaves the UI's `thinking` flag stuck on, which
 * disables every trigger control — the app looks frozen with no error anywhere.
 */
const PLAN_TIMEOUT_MS = 10_000;

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

/** The drawing, if there is one, then the text: the order the model reads them in. */
function partsFor(imageDataUrl: string | undefined, text: string): { parts: Part[]; imageBytes: number } {
  const parts: Part[] = [];
  let imageBytes = 0;
  if (imageDataUrl) {
    const [header, data] = imageDataUrl.split(',');
    const mimeType = header.match(/data:(.*?);/)?.[1] ?? 'image/png';
    // base64 decodes to 3 bytes per 4 chars; near enough for a size readout.
    imageBytes = Math.round((data?.length ?? 0) * 0.75);
    parts.push({ inlineData: { mimeType, data } });
  }
  parts.push({ text });
  return { parts, imageBytes };
}

export function createPlanner(apiKey: string, model: PlannerModel = DEFAULT_PLANNER_MODEL) {
  const auth = geminiAuth(apiKey);
  const ai = new GoogleGenAI({
    apiKey: auth.apiKey,
    // No retryOptions. Given any, the SDK wraps fetch in a retry loop whose
    // failures read "Retryable HTTP Error: <statusText>": no status, none of
    // Google's message, and over HTTP/2 no status text either, so a spent quota
    // showed as a blank error. Without them it makes one attempt and a failure
    // is an ApiError with the status and Google's own words. Nothing is lost by
    // not retrying: the next stroke or tap is the retry, against a newer page.
    httpOptions: auth.httpOptions,
  });

  /** One round trip to one model, with the timeout and the error naming both passes need. */
  async function once(which: PlannerModel, systemInstruction: string, parts: Part[], responseSchema: Schema) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
    const startedAt = performance.now();
    try {
      const response = await ai.models.generateContent({
        model: which,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          // Latency matters more than depth here. On 2026-10-07 Flash Lite took
          // 8-20 s at LOW, past the timeout, and 0.5-1 s at MINIMAL.
          thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
          // A rough sketch only has to read as a *shape*; 64 image tokens is
          // plenty for that and cuts the prefill against MEDIUM's 256.
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
          abortSignal: controller.signal,
        },
      });
      const text = response.text;
      if (!text) throw new Error('Planner returned no content');
      const usage = response.usageMetadata;
      return {
        parsed: JSON.parse(text) as Record<string, unknown>,
        request: performance.now() - startedAt,
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        thoughtTokens: usage?.thoughtsTokenCount,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'Planner returned no content') throw error;
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
        // An ApiError's message is Google's JSON body; its own sentence is the useful part.
        let said = message;
        try {
          said = (JSON.parse(message) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          // Not JSON: keep it as it came.
        }
        const hint = status === 429 ? ' — out of quota or rate limited' : status === 503 ? ' — model overloaded' : '';
        const first = said.split(/(?<=\.)\s/)[0];
        throw Object.assign(new Error(`Planner failed: HTTP ${status} after ${elapsed}ms${hint}${first ? ` — ${first}` : ''}`), {
          status,
        });
      }
      throw new Error(`Planner failed after ${elapsed}ms${detail || ' — see the console'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The chosen model, or once the other tier when it is out of quota or overloaded. */
  async function ask(systemInstruction: string, parts: Part[], responseSchema: Schema) {
    try {
      return { ...(await once(model, systemInstruction, parts, responseSchema)), model };
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 429 && status !== 503) throw error;
      const other = PLANNER_MODELS.find((m) => m.id !== model)!.id;
      return { ...(await once(other, systemInstruction, parts, responseSchema)), model: other };
    }
  }

  async function planActions(
    event: string,
    state: SkuzicState,
    imageDataUrl?: string,
    // Per call rather than baked into the factory, so switching strategy takes
    // effect on the next tap instead of the next session.
    configId: PlannerConfigId = DEFAULT_PLANNER_CONFIG,
  ): Promise<Plan> {
    const { parts, imageBytes } = partsFor(imageDataUrl, `${describeState(state)}\n\nEVENT\n${event}`);
    const { parsed, request, model: answered, ...usage } = await ask(systemInstruction(configId), parts, PLAN_SCHEMA);
    return {
      reasoning: (parsed.reasoning as string) ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actions: normalize(((parsed.actions as unknown[]) ?? []) as any[], event),
      timings: { request, imageBytes, ...usage },
      model: answered,
    };
  }

  /**
   * The follow-up pass: every layer but Style rewritten for the drawing, and
   * the two live knobs, as actions for keepRefinement to vet.
   */
  async function refine(state: SkuzicState, imageDataUrl: string): Promise<Plan> {
    const { parts, imageBytes } = partsFor(imageDataUrl, `${describeState(state)}\n\nEVENT\n${REFINE_EVENT}`);
    const { parsed, request, model: answered, ...usage } = await ask(REFINE_INSTRUCTION, parts, REFINE_SCHEMA);
    const layers = (parsed.layers as { id?: string; words?: string }[] | undefined) ?? [];
    const { density, brightness } = parsed as { density?: number; brightness?: number };
    const actions: Action[] = layers.flatMap((l) =>
      l.id && l.words ? [{ type: 'MODIFY_TRACK' as const, target: l.id, prompt: l.words }] : [],
    );
    if (density != null || brightness != null) actions.push({ type: 'SET_CONFIG', config: { density, brightness } });
    return { reasoning: (parsed.reasoning as string) ?? '', actions, timings: { request, imageBytes, ...usage }, model: answered };
  }

  return Object.assign(planActions, { refine });
}
