import type { Action, Backend, MixConfig } from '../core/types';
import palette from './palette.json';

/**
 * The eyes: SigLIP 2 reads what is drawn and composes the music from a curated
 * palette, as layered prompts the way Lyria is meant to be steered: a ground
 * (the genre, all session), the things the page shows, each as its own mood
 * layer, and one or two instruments. Each layer is a short phrase with its own
 * weight, so a change moves one layer while the others play straight through.
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
 * The page is read figure by figure. Strokes that belong together (the same
 * ink, close by) make a figure, and each figure is read from its own crop:
 * read whole, the biggest thing on a page drowns out the rest, so a sun or a
 * bike drawn into a landscape never registered. The music then mixes the
 * page's things by size, which lets it settle as the drawing grows: a bike
 * drawn into a finished landscape joins the music rather than taking it over.
 *
 * It runs in the browser in milliseconds, costs nothing, sends the drawing
 * nowhere, and can only play phrases a person chose. Only the image half of
 * SigLIP 2 runs here; scripts/embed-palette.py embeds the palette once,
 * offline, because the text half is over 280 MB.
 */

/** Something a drawing can show, and the mood it plays. */
export type Mood = (typeof palette.moods)[number];
export type Instrument = (typeof palette.instruments)[number];
/**
 * Where a session starts: the genre the music plays in, the instruments it
 * opens with, and the only instruments a drawing may bring in, so a string
 * quartet never grows a kalimba.
 */
export type Vibe = (typeof palette.vibes)[number];

/** The palette's SigLIP 2 vectors (scripts/embed-palette.py), loaded with the model. */
export interface Vectors {
  scale: number;
  moods: Record<string, { vector: number[] }>;
  instruments: Record<string, { vector: number[] }>;
}

export interface Ranked<T> {
  item: T;
  /** Share of belief across its list, 0..1. */
  p: number;
}

/** A stroke as the eyes group it, in page pixels. */
export interface Mark {
  id: number;
  color: string;
  erasing: boolean;
  /** [x, y, ...rest] per point. */
  points: number[][];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Strokes that belong together: one thing on the page, read from its own crop.
 * The key changes whenever its strokes do or an eraser crosses it, which is
 * when it needs reading again.
 */
export interface Figure {
  key: string;
  box: Box;
  /** How many strokes make it, erasers aside. */
  strokes: number;
}

/** A figure and what SigLIP made of it. */
export interface Seen {
  figure: Figure;
  /** Its unit-length SigLIP embedding. */
  image: ArrayLike<number>;
  moods: Ranked<Mood>[];
}

export interface Reading {
  /** The page's things: every settled figure's reading weighted by its size, best first. */
  moods: Ranked<Mood>[];
  instruments: Ranked<Instrument>[];
  /** Whether any figure reads clearly as something. The intro waits for one. */
  sure: boolean;
}

/** What the music plays: the page's main things by share, the lead first, and one or two instruments. */
export interface Mix {
  moods: Ranked<Mood>[];
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
  moods: [{ item: INTRO_MOOD, p: 1 }],
  instruments: vibe.start.map(instrument),
});
export const isIntro = (mix: Mix) => mix.moods[0]?.item === INTRO_MOOD;

/**
 * How close, as a share of the page diagonal, a stroke in the same ink must
 * come to the figure being drawn to join it; a change of ink always starts a
 * new figure. Drawn stroke by stroke, 8 scenes of Quick, Draw! doodles split
 * into exactly their 30 doodles when each had its own ink. In one ink, 5 of
 * the 8 still split exactly; the rest merged things drawn touching, like a
 * boat on its waves or a dog in front of a house.
 */
const JOIN = 0.1;
/**
 * Up to three things play at once. One joins at an eighth of the page, or by
 * beating the weakest playing thing by SWAP once three play, and stays until
 * it falls under LEAVE, so the music settles rather than chasing every stroke.
 */
const MIX_SIZE = 3;
const ENTER = 0.12;
const LEAVE = 0.08;
const SWAP = 0.05;
/** How sure SigLIP must be of some figure before the intro gives way. */
const MIN_BELIEF = 0.4;
/**
 * Moods that name the marks rather than a thing. The first stroke of nearly
 * anything reads as one of these, and a lone line (a horizon, the ground)
 * reads as squiggles however long it is. So they count half: what the page
 * clearly shows leads and marks add colour, unless marks are all there is.
 */
const MARKS = new Set(['energy', 'dots', 'spiral', 'writing']);
/**
 * The figure being drawn has no say until it reads clearly as a thing or has
 * this many strokes: every object starts as one stroke, and one stroke reads
 * as squiggles, so without the wait each new object opened on squiggles.
 */
const SETTLE = 3;
/** Instruments split belief ten ways, so they need less of it to win a seat. */
const INSTRUMENT_BELIEF = 0.25;
const INSTRUMENT_MARGIN = 0.12;
/**
 * The lead and the colour instrument, under a ground at 1.0. Always two once
 * the page is read: a lone lead measured lower on Lyria (enjoyment 7.1 against
 * 7.3), even where SigLIP's runner-up is only a faint guess.
 */
const INSTRUMENT_WEIGHTS = [0.6, 0.4];
/** No layer plays quieter than this; under it a prompt barely registers. */
const MIN_VOLUME = 0.15;

type Table = Record<string, { vector: number[] }>;

/** Items ranked by SigLIP's softmax over its scaled similarity, best first. */
function rank<T extends { id: string }>(items: T[], table: Table, scale: number, image: ArrayLike<number>): Ranked<T>[] {
  const logits = items.map((item) => {
    const v = table[item.id].vector;
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * image[i];
    return scale * dot;
  });
  const top = Math.max(...logits);
  const weights = logits.map((l) => Math.exp(l - top));
  const sum = weights.reduce((a, b) => a + b, 0);
  return items.map((item, i) => ({ item, p: weights[i] / sum })).sort((a, b) => b.p - a.p);
}

const boxOf = (points: number[][]): Box => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

const union = (a: Box, b: Box): Box => boxOf([[a.x, a.y], [a.x + a.width, a.y + a.height], [b.x, b.y], [b.x + b.width, b.y + b.height]]);

/** Whether two boxes come within `gap` of each other. */
const within = (a: Box, b: Box, gap = 0) =>
  a.x - gap <= b.x + b.width && b.x - gap <= a.x + a.width && a.y - gap <= b.y + b.height && b.y - gap <= a.y + a.height;

/** Whether any point of `a` comes within `reach` of any point of `b`. Every third point is plenty at pointer density. */
function near(a: number[][], b: number[][], reach: number): boolean {
  const r2 = reach * reach;
  for (let i = 0; i < a.length; i += 3) {
    for (let j = 0; j < b.length; j += 3) {
      const dx = a[i][0] - b[j][0];
      const dy = a[i][1] - b[j][1];
      if (dx * dx + dy * dy <= r2) return true;
    }
  }
  return false;
}

/** The page's strokes, since the last clear and in drawing order, as figures. */
export function figuresOf(marks: Mark[], page: { width: number; height: number }): Figure[] {
  const reach = JOIN * Math.hypot(page.width, page.height);
  const groups: { ids: number[]; color: string; points: number[][]; box: Box }[] = [];
  const erasers: { id: number; box: Box }[] = [];
  for (const mark of marks) {
    if (!mark.points.length) continue;
    const box = boxOf(mark.points);
    if (mark.erasing) {
      erasers.push({ id: mark.id, box });
      continue;
    }
    const last = groups.at(-1);
    if (last && last.color === mark.color && within(box, last.box, reach) && near(mark.points, last.points, reach)) {
      last.ids.push(mark.id);
      last.points.push(...mark.points);
      last.box = union(last.box, box);
    } else {
      groups.push({ ids: [mark.id], color: mark.color, points: [...mark.points], box });
    }
  }
  return groups.map(({ ids, box }) => ({
    key: [...ids, ...erasers.filter((e) => within(e.box, box)).map((e) => `e${e.id}`)].join(' '),
    box,
    strokes: ids.length,
  }));
}

/** What one figure looks like, from its crop's embedding. */
export const readFigure = (vectors: Vectors, image: ArrayLike<number>): Ranked<Mood>[] =>
  rank(MOODS, vectors.moods, vectors.scale, image);

/** A figure counts by the square root of its area: a mountain range leads, a sun still shows. */
const sizeOf = (figure: Figure) => Math.sqrt(Math.max(figure.box.width, 8) * Math.max(figure.box.height, 8));

/**
 * The page's things: every figure's reading, weighted by its size, as shares.
 * Marks count half, and only from a figure they lead, never as a runner-up
 * guess about a figure that reads as something else.
 */
export function sceneOf(seen: Seen[]): Ranked<Mood>[] {
  const weights = new Map<Mood, number>();
  let total = 0;
  for (const s of seen) {
    const size = sizeOf(s.figure);
    for (const r of s.moods) {
      const w = size * r.p * (MARKS.has(r.item.id) ? (r === s.moods[0] ? 0.5 : 0) : 1);
      weights.set(r.item, (weights.get(r.item) ?? 0) + w);
      total += w;
    }
  }
  return [...weights].map(([item, w]) => ({ item, p: w / total })).sort((a, b) => b.p - a.p);
}

/** Whether a figure has a say: any finished one does, the one being drawn once it has settled. */
const settled = (s: Seen, drawing: boolean) =>
  !drawing || s.figure.strokes >= SETTLE || (s.moods[0].p >= MIN_BELIEF && !MARKS.has(s.moods[0].item.id));

/** The whole page as one embedding, its figures' own weighted the same way. */
function gistOf(seen: Seen[]): Float32Array {
  const gist = new Float32Array(seen[0]?.image.length ?? 0);
  for (const s of seen) {
    const size = sizeOf(s.figure);
    for (let i = 0; i < gist.length; i++) gist[i] += size * s.image[i];
  }
  const norm = Math.hypot(...gist) || 1;
  return gist.map((x) => x / norm);
}

/**
 * The page as the music needs it: its things, the instruments it suggests, and
 * whether anything is clear. `seen` is in drawing order, so the last figure is
 * the one being drawn.
 */
export function readScene(vectors: Vectors, seen: Seen[], vibe: Vibe = DEFAULT_VIBE): Reading {
  const counted = seen.filter((s, k) => settled(s, k === seen.length - 1));
  return {
    moods: sceneOf(counted),
    instruments: counted.length
      ? rank(
          palette.instruments.filter((i) => vibe.instruments.includes(i.id)),
          vectors.instruments,
          vectors.scale,
          gistOf(counted),
        )
      : [],
    sure: counted.some((s) => s.moods[0].p >= MIN_BELIEF),
  };
}

/**
 * The things to play, by their share among themselves. Playing ones keep their
 * seats while they hold LEAVE; a newcomer needs ENTER, and a free seat or a
 * clear lead over the weakest seat.
 */
export function chooseMoods(scene: Ranked<Mood>[], playing: Mood[]): Ranked<Mood>[] {
  const share = (m: Mood) => scene.find((r) => r.item === m)?.p ?? 0;
  const seats = playing.filter((m) => share(m) >= LEAVE);
  for (const r of scene) {
    if (r.p < ENTER) break;
    if (seats.includes(r.item)) continue;
    if (seats.length < MIX_SIZE) {
      seats.push(r.item);
      continue;
    }
    const weakest = seats.reduce((a, b) => (share(a) <= share(b) ? a : b));
    if (r.p - share(weakest) >= SWAP) seats[seats.indexOf(weakest)] = r.item;
  }
  const total = seats.reduce((sum, m) => sum + share(m), 0);
  return seats.map((item) => ({ item, p: share(item) / total })).sort((a, b) => b.p - a.p);
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
 * first reading still starts the intro; after that the intro waits for a
 * figure SigLIP is sure of, and the music changes only when what it plays does.
 */
export function nextMix(reading: Reading, playing: Mix | null, vibe: Vibe = DEFAULT_VIBE): Mix | null {
  const intro = !playing || isIntro(playing);
  const moods = chooseMoods(reading.moods, intro ? [] : playing.moods.map((r) => r.item));
  const ready = moods.length > 0 && (!intro || reading.sure);
  if (!playing) return ready ? { moods, instruments: chooseInstruments(reading.instruments, []) } : introMix(vibe);
  if (!ready) return null;
  const instruments = chooseInstruments(
    reading.instruments,
    intro ? [] : playing.instruments.map((i) => i.id),
  );
  const same =
    !intro &&
    moods.length === playing.moods.length &&
    moods.every((r, k) => r.item === playing.moods[k].item) &&
    instruments.length === playing.instruments.length &&
    instruments.every((i, k) => i === playing.instruments[k]);
  return same ? null : { moods, instruments };
}

/** What the music is playing, in words: "mountains, trees and bicycle". */
export function titleOf(mix: Mix): string {
  const names = mix.moods.map((r) => r.item.label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/** The mix's base energy and brightness, each thing pulling by its share. */
export const feelOf = (mix: Mix) => ({
  density: mix.moods.reduce((sum, r) => sum + r.p * r.item.density, 0),
  brightness: mix.moods.reduce((sum, r) => sum + r.p * r.item.brightness, 0),
});

const originOf = (mix: Mix) => `drawing read as ${titleOf(mix)}`;

/** Whether the tracks playing are still the eyes' own, not rewritten by Gemini. */
export const eyesOwn = (tracks: { origin: string }[], mix: Mix) =>
  tracks.every((t) => t.origin === originOf(mix));

/**
 * The mix as tracks, weighted for the engine that will play it. The page's
 * things share the mood's measured weight between them, so a busy page keeps
 * the balance the listening test chose. `words` are Gemini's rewrites by layer
 * label, so a thing or instrument Gemini has described keeps its words when the
 * eyes add or drop another. Layers whose prompt doesn't change (the ground, a
 * kept thing or instrument) play straight through, since the mixer keys on
 * prompt text.
 */
export function mixActions(
  mix: Mix,
  backend: Backend,
  config: Partial<MixConfig>,
  vibe: Vibe = DEFAULT_VIBE,
  words: ReadonlyMap<string, string> = new Map(),
): Action[] {
  const origin = originOf(mix);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return [
    { type: 'CLEAR_TRACKS' },
    { type: 'ADD_TRACK', label: 'Style', prompt: vibe.ground[backend], volume: 1, origin },
    ...mix.moods.map(
      (r): Action => ({
        type: 'ADD_TRACK',
        label: isIntro(mix) ? 'Mood' : r.item.label,
        prompt: words.get(r.item.label) ?? r.item.prompt,
        volume: Math.max(MIN_VOLUME, round2(palette.moodWeight[backend] * r.p)),
        origin,
      }),
    ),
    ...mix.instruments.map(
      (inst, i): Action => ({
        type: 'ADD_TRACK',
        label: inst.label,
        prompt: words.get(inst.label) ?? inst.prompt,
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
  vectors: Vectors;
}

let eyes: Promise<Eyes> | null = null;

/**
 * Loads SigLIP 2's image half once (63 MB, then cached by the browser) and the
 * palette's vectors (170 KB zipped). Both are imported on demand so the app's
 * own bundle doesn't carry them.
 *
 * Every half-precision export (fp16, q4f16) drifts far from the reference on
 * this model: cosine about 0.6 against PyTorch. q4 keeps full-precision maths
 * and scores 0.97, and int8 only 0.87. Measured at 21 ms a read on WebGPU and
 * 0.7 s on WASM.
 */
export function loadEyes(): Promise<Eyes> {
  eyes ??= (async (): Promise<Eyes> => {
    const [{ AutoImageProcessor, RawImage, SiglipVisionModel }, { default: vectors }] = await Promise.all([
      import('@huggingface/transformers'),
      import('./palette-vectors.json'),
    ]);
    const load = async (device: Eyes['device']) => ({
      device,
      model: await SiglipVisionModel.from_pretrained(MODEL, { device, dtype: 'q4' }),
    });
    // A browser can expose WebGPU and still refuse an adapter (WebGPU off, or
    // after its GPU process crashed), and a failed WebGPU session leaves the
    // runtime unable to start a WASM one in the same page. So WebGPU is tried
    // only once the browser has actually handed over an adapter.
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    const [processor, { device, model }] = await Promise.all([
      AutoImageProcessor.from_pretrained(MODEL),
      adapter ? load('webgpu').catch(() => load('wasm')) : load('wasm'),
    ]);
    return {
      device,
      vectors,
      read: async (url) => {
        try {
          const { pooler_output } = await model(await processor(await RawImage.read(url)));
          const v = pooler_output.data as Float32Array;
          const norm = Math.hypot(...v) || 1;
          return v.map((x) => x / norm);
        } catch (error) {
          // A lost GPU device fails every read after it; load afresh on the
          // next pen-up instead of failing for the rest of the session.
          eyes = null;
          throw error;
        }
      },
    };
  })();
  // A failed load (offline, blocked) gets another try on the next pen-up.
  eyes.catch(() => {
    eyes = null;
  });
  return eyes;
}
