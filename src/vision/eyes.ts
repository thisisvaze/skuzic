import type { Action, Backend, MixConfig } from '../core/types';
import palette from './palette.json';
import vectors from './palette-vectors.json';

/**
 * The eyes: SigLIP 2 reads the page on pen-up and composes the band from a
 * small curated palette, as layered prompts the way Lyria is meant to be
 * steered: a ground (the genre, all session), a mood, and one or two
 * instruments. Each layer is a short phrase with its own weight, so a change
 * moves one layer while the others play straight through.
 *
 * Chosen by a listening test (numbers in docs/how-it-works.md): on both engines,
 * full sentences per track with the genre repeated in each (the old fixed
 * scenes) scored lowest for enjoyment and made every drawing sound alike, and
 * fully generic prompts drifted genre from drawing to drawing (and once
 * collapsed on Magenta). Short layers scored best and most reliably. The
 * engines want different balances: Lyria a "dreamy" ground with a light mood,
 * Magenta a plain ground with a strong mood (palette.json holds both). The
 * ground itself comes from the vibe the artist starts from.
 *
 * It runs in the browser in milliseconds, costs nothing, sends the drawing
 * nowhere, and can only play phrases a person chose. Only the image half of
 * SigLIP 2 runs here; scripts/embed-palette.py embeds the tags once, offline,
 * because the text half is over 280 MB.
 */

export type Mood = (typeof palette.moods)[number];
export type Instrument = (typeof palette.instruments)[number];
/**
 * Where a session starts: the genre the band plays in, the instruments it
 * opens with, and the only instruments a drawing may bring in, so a string
 * quartet never grows a kalimba.
 */
export type Vibe = (typeof palette.vibes)[number];

export interface Ranked<T> {
  item: T;
  /** Share of SigLIP's belief across its list, 0..1. */
  p: number;
}

export interface Reading {
  moods: Ranked<Mood>[];
  instruments: Ranked<Instrument>[];
}

/** What the band plays: a mood and one or two instruments, the lead first. */
export interface Mix {
  mood: Mood;
  instruments: Instrument[];
}

const MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';

const instrument = (id: string) => palette.instruments.find((i) => i.id === id)!;

export const VIBES: Vibe[] = palette.vibes;
/** "Just draw": silence until the first mark, then the drawing picks the sound. */
export const DEFAULT_VIBE = VIBES[0];
export const vibeById = (id: string) => VIBES.find((v) => v.id === id) ?? DEFAULT_VIBE;

/**
 * The intro mood has no tags and never competes in a reading: simple line art
 * looks enough like "a few faint lines" that it used to win over a plainly
 * drawn house.
 */
const INTRO_MOOD = palette.moods[0];
const MOODS = palette.moods.filter((m) => m.tags.length);

/** What an empty page plays, and what first marks play until SigLIP is sure what they are. */
export const introMix = (vibe: Vibe): Mix => ({
  mood: INTRO_MOOD,
  instruments: vibe.start.map(instrument),
});
export const isIntro = (mix: Mix) => mix.mood === INTRO_MOOD;

/**
 * How sure SigLIP must be, and by how much it must prefer a new mood over the
 * playing one, before the band changes. Below that the page is ambiguous (a
 * first tentative mark, a half-drawn shape) and whatever is playing holds.
 */
const MIN_BELIEF = 0.4;
const SWITCH_MARGIN = 0.15;
/** Instruments split belief ten ways, so they need less of it to win a seat. */
const INSTRUMENT_BELIEF = 0.25;
const INSTRUMENT_MARGIN = 0.12;
/**
 * The lead and the colour instrument, under a ground at 1.0. Always two once
 * the page is read: a lone lead measured lower on Lyria (enjoyment 7.1 against
 * 7.3), even where SigLIP's runner-up is only a faint guess.
 */
const INSTRUMENT_WEIGHTS = [0.6, 0.4];

type Vectors = Record<string, { tags: string[]; vector: number[] }>;

/** Items ranked by SigLIP's softmax over scaled cosine similarity, best first. */
function rank<T extends { id: string }>(items: T[], table: Vectors, image: ArrayLike<number>): Ranked<T>[] {
  const logits = items.map((item) => {
    const v = table[item.id].vector;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * image[i];
    return vectors.scale * dot;
  });
  const top = Math.max(...logits);
  const weights = logits.map((l) => Math.exp(l - top));
  const sum = weights.reduce((a, b) => a + b, 0);
  return items.map((item, i) => ({ item, p: weights[i] / sum })).sort((a, b) => b.p - a.p);
}

export function readPage(image: ArrayLike<number>, vibe: Vibe = DEFAULT_VIBE): Reading {
  return {
    moods: rank(MOODS, vectors.moods, image),
    instruments: rank(
      palette.instruments.filter((i) => vibe.instruments.includes(i.id)),
      vectors.instruments,
      image,
    ),
  };
}

/** The mood to switch to, or null to keep what is playing. */
export function chooseMood(ranked: Ranked<Mood>[], playing: string | null): Mood | null {
  const best = ranked[0];
  const current = ranked.find((r) => r.item.id === playing)?.p ?? 0;
  return best.p >= MIN_BELIEF && best.p - current >= SWITCH_MARGIN ? best.item : null;
}

/**
 * The instruments to play: each playing one keeps its seat unless another
 * clearly beats the weaker of the two, so one swaps at a time and the other
 * carries the music through the change.
 */
export function chooseInstruments(ranked: Ranked<Instrument>[], playing: string[]): Instrument[] {
  const belief = (id: string) => ranked.find((r) => r.item.id === id)?.p ?? 0;
  // Only instruments still on offer keep their seats: a new vibe can take some away.
  const seats = playing.filter((id) => ranked.some((r) => r.item.id === id));
  if (!seats.length) return ranked.slice(0, 2).map((r) => r.item);
  seats.sort((a, b) => belief(b) - belief(a));
  const challenger = ranked.find((r) => !seats.includes(r.item.id));
  const weakest = seats[seats.length - 1];
  if (
    challenger &&
    challenger.p >= INSTRUMENT_BELIEF &&
    challenger.p - belief(weakest) >= INSTRUMENT_MARGIN
  ) {
    seats[seats.length - 1] = challenger.item.id;
  }
  return seats.sort((a, b) => belief(b) - belief(a)).map(instrument);
}

/**
 * The next mix for this reading, or null to keep what is playing. An unsure
 * first reading still starts the intro; after that, an unsure page holds, and
 * the intro waits for a confident mood before it changes anything.
 */
export function nextMix(reading: Reading, playing: Mix | null, vibe: Vibe = DEFAULT_VIBE): Mix | null {
  const mood = chooseMood(reading.moods, playing?.mood.id ?? null);
  if (!playing) {
    return mood ? { mood, instruments: chooseInstruments(reading.instruments, []) } : introMix(vibe);
  }
  if (isIntro(playing) && !mood) return null;
  const instruments = chooseInstruments(
    reading.instruments,
    isIntro(playing) ? [] : playing.instruments.map((i) => i.id),
  );
  const next = { mood: mood ?? playing.mood, instruments };
  const same =
    next.mood === playing.mood &&
    next.instruments.length === playing.instruments.length &&
    next.instruments.every((i, k) => i === playing.instruments[k]);
  return same ? null : next;
}

const originOf = (mix: Mix) => `drawing read as ${mix.mood.label}`;

/** Whether the tracks playing are still the eyes' own, not rewritten by Gemini. */
export const eyesOwn = (tracks: { origin: string }[], mix: Mix) =>
  tracks.every((t) => t.origin === originOf(mix));

/**
 * The mix as tracks, weighted for the engine that will play it. Layers whose
 * prompt doesn't change (the ground, a kept instrument) play straight through,
 * since the mixer keys on prompt text.
 */
export function mixActions(
  mix: Mix,
  backend: Backend,
  config: Partial<MixConfig>,
  vibe: Vibe = DEFAULT_VIBE,
): Action[] {
  const origin = originOf(mix);
  return [
    { type: 'CLEAR_TRACKS' },
    { type: 'ADD_TRACK', label: 'Style', prompt: vibe.ground[backend], volume: 1, origin },
    { type: 'ADD_TRACK', label: 'Mood', prompt: mix.mood.prompt, volume: palette.moodWeight[backend], origin },
    ...mix.instruments.map(
      (inst, i): Action => ({
        type: 'ADD_TRACK',
        label: inst.label,
        prompt: inst.prompt,
        volume: INSTRUMENT_WEIGHTS[i],
        origin,
      }),
    ),
    { type: 'SET_CONFIG', config },
  ];
}

export interface Eyes {
  device: 'webgpu' | 'wasm';
  /** An image URL (a canvas data URL works) to a unit-length SigLIP embedding. */
  read: (url: string) => Promise<Float32Array>;
}

let eyes: Promise<Eyes> | null = null;

/**
 * Loads SigLIP 2's image half once (63 MB, then cached by the browser). The
 * runtime is imported on demand so the app's own bundle doesn't carry it.
 *
 * Every half-precision export (fp16, q4f16) drifts far from the reference on
 * this model: cosine about 0.6 against PyTorch. q4 keeps full-precision maths
 * and scores 0.97, and int8 only 0.87. Measured at 21 ms a read on WebGPU and
 * 0.7 s on WASM.
 */
export function loadEyes(): Promise<Eyes> {
  eyes ??= (async (): Promise<Eyes> => {
    const { AutoImageProcessor, RawImage, SiglipVisionModel } = await import('@huggingface/transformers');
    const load = async (device: Eyes['device']) => ({
      device,
      model: await SiglipVisionModel.from_pretrained(MODEL, { device, dtype: 'q4' }),
    });
    const [processor, { device, model }] = await Promise.all([
      AutoImageProcessor.from_pretrained(MODEL),
      // A browser can expose WebGPU and still refuse an adapter; WASM always works.
      'gpu' in navigator ? load('webgpu').catch(() => load('wasm')) : load('wasm'),
    ]);
    return {
      device,
      read: async (url) => {
        const { pooler_output } = await model(await processor(await RawImage.read(url)));
        const v = pooler_output.data as Float32Array;
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      },
    };
  })();
  // A failed load (offline, blocked) gets another try on the next pen-up.
  eyes.catch(() => {
    eyes = null;
  });
  return eyes;
}
