import type { Action, Backend, MixConfig } from '../core/types';
import palette from './palette.json';

/**
 * The eyes: SigLIP 2 reads what is drawn and composes the music from a curated
 * palette: the things the page shows, each as its own mood layer, and one or
 * two instruments that fit the chosen vibe. Each layer is a short phrase with
 * its own weight. The vibe shapes the instrument choices here and accompanies
 * one drawing prompt at the engine boundary (core/music-prompts.ts); it has
 * no separate channel or weight competing with the art.
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
 * The lead and the quieter colour instrument. A drawing can choose up to two
 * from the vibe's instrument palette; solo styles may supply their voice in
 * the genre cue itself.
 */
const INSTRUMENT_WEIGHTS = [0.6, 0.4];
/** No layer plays quieter than this; under it a prompt barely registers. */
const MIN_VOLUME = 0.15;

type Table = Record<string, { vector: number[] }>;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/** Items ranked by SigLIP's softmax over its scaled similarity, best first. */
const rank = <T extends { id: string }>(items: T[], table: Table, scale: number, image: ArrayLike<number>): Ranked<T>[] =>
  softmax(items, items.map((item) => scale * dot(table[item.id].vector, image)));

function softmax<T>(items: T[], logits: number[]): Ranked<T>[] {
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

/** Turns a thing's pull toward an instrument into belief: one clear thing gives its instrument most of it. */
const THING_SCALE = 20;
const affinities = new WeakMap<Vectors, Map<string, number>>();

/**
 * How much each thing calls for each instrument: the cosine of their text
 * vectors, less that instrument's mean over every thing, so one whose tags
 * sound like everything (kalimba's small animals) doesn't win everywhere.
 * Keyed `${mood} ${instrument}`. Mountains call for strings, water for harp,
 * clouds for pads, a house for Rhodes.
 */
function affinityOf(vectors: Vectors): Map<string, number> {
  let table = affinities.get(vectors);
  if (table) return table;
  table = new Map();
  for (const inst of palette.instruments) {
    const v = vectors.instruments[inst.id].vector;
    const raw = MOODS.map((m) => dot(vectors.moods[m.id].vector, v));
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
    MOODS.forEach((m, k) => table!.set(`${m.id} ${inst.id}`, raw[k] - mean));
  }
  affinities.set(vectors, table);
  return table;
}

/**
 * The instruments the page's things ask for, each thing pulling by its share.
 * Read from the things, not the page's look: the look is mostly its colour, so
 * blue mountains used to play harp because blue reads as water.
 */
function instrumentsFor(vectors: Vectors, scene: Ranked<Mood>[], vibe: Vibe): Ranked<Instrument>[] {
  const table = affinityOf(vectors);
  const offered = palette.instruments.filter((i) => vibe.instruments.includes(i.id));
  return softmax(
    offered,
    offered.map((i) => THING_SCALE * scene.reduce((sum, r) => sum + r.p * table.get(`${r.item.id} ${i.id}`)!, 0)),
  );
}

/**
 * The page as the music needs it: its things, the instruments it suggests, and
 * whether anything is clear. `seen` is in drawing order, so the last figure is
 * the one being drawn.
 */
export function readScene(vectors: Vectors, seen: Seen[], vibe: Vibe = DEFAULT_VIBE): Reading {
  const counted = seen.filter((s, k) => settled(s, k === seen.length - 1));
  const moods = sceneOf(counted);
  return {
    moods,
    instruments: counted.length ? instrumentsFor(vectors, moods, vibe) : [],
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
 * eyes add or drop another. Layers whose prompt doesn't change (a kept thing
 * or instrument) play straight through, since the mixer keys on
 * prompt text.
 */
export function mixActions(
  mix: Mix,
  backend: Backend,
  config: Partial<MixConfig>,
  words: ReadonlyMap<string, string> = new Map(),
): Action[] {
  const origin = originOf(mix);
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return [
    { type: 'CLEAR_TRACKS' },
    { type: 'SET_SOUND_EFFECTS', enabled: false },
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
  /** An image URL (a canvas data URL works) or RGBA pixels to a unit-length SigLIP embedding. */
  read: (image: string | ImageData) => Promise<Float32Array>;
  vectors: Vectors;
}

let eyes: Promise<Eyes> | null = null;

/**
 * Starts SigLIP 2's image half in a worker of its own (eyes.worker.ts; 63 MB,
 * then cached by the browser), so neither loading it nor a read ever holds up
 * the page, and loads the palette's vectors (170 KB zipped). Both come on
 * demand so the app's own bundle doesn't carry them.
 */
export function loadEyes(): Promise<Eyes> {
  if (eyes) return eyes;
  const worker = new Worker(new URL('./eyes.worker.ts', import.meta.url), { type: 'module' });
  const reads = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();
  let next = 0;
  const vectors = import('./palette-vectors.json');
  const loading = new Promise<Eyes>((resolve, reject) => {
    // A failed load (offline, blocked) or read (a lost GPU device fails every
    // read after it) retires the worker; the next pen-up starts a fresh one.
    const fail = (error: Error) => {
      worker.terminate();
      if (eyes === loading) eyes = null;
      reject(error);
      reads.forEach((r) => r.reject(error));
      reads.clear();
    };
    const read = (image: string | ImageData) =>
      new Promise<Float32Array>((resolve, reject) => {
        const id = next++;
        reads.set(id, { resolve, reject });
        worker.postMessage({ id, image });
      });
    worker.onerror = (e) => fail(new Error(e.message || "The drawing reader didn't start"));
    worker.onmessage = ({ data }: MessageEvent<{ id?: number; device?: Eyes['device']; vector?: Float32Array; error?: string }>) => {
      if (data.error) return fail(new Error(data.error));
      if (data.device) {
        const device = data.device;
        vectors.then(({ default: vectors }) => resolve({ device, vectors, read }), fail);
        return;
      }
      reads.get(data.id!)?.resolve(data.vector!);
      reads.delete(data.id!);
    };
  });
  eyes = loading;
  return loading;
}
