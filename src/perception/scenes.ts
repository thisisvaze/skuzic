/**
 * Drawings for evaluating perception, written as the inputs a hand would make
 * so they replay through the real page, brushes and all. Each comparison
 * names two scenes that differ, by design, in one quality, and which way it
 * should read. Real recorded drawings (test/perception/recordings) join these
 * in the lab's evaluation; these only scaffold it.
 */

import type { PageInput, StrokeTool } from './gesture';

export interface Recording {
  name: string;
  /** The page it was drawn on, in page px; a replay scales it to fit. */
  page: { width: number; height: number };
  events: PageInput[];
}

const PAGE = { width: 1200, height: 800 };
const INK = '#15130f';
const BLUE = '#2d7dd2';
const RED = '#d1495b';
const YELLOW = '#f0a202';

const pencil = (color = INK, size = 3, alpha = 1): StrokeTool => ({ medium: 'pencil', color, size, alpha, erasing: false, simulate: true });
const brush = (color = BLUE, size = 6, alpha = 1): StrokeTool => ({ medium: 'watercolor', color, size, alpha, erasing: false, simulate: true });
const eraser = (size = 40): StrokeTool => ({ medium: 'pencil', color: INK, size, alpha: 1, erasing: true, simulate: true });

type Path = number[][];

/** A deterministic wobble, so lines look drawn rather than plotted. */
function jitter(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** Points every few px along straight segments through `corners`, with a hand's wobble. */
function polyline(corners: Path, seed = 1, wobble = 0.8): Path {
  const r = jitter(seed);
  const out: Path = [];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 4));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n + r() * wobble, ay + ((by - ay) * k) / n + r() * wobble]);
  }
  return out;
}

const curve = (f: (t: number) => [number, number], steps: number, seed = 1) =>
  polyline(Array.from({ length: steps + 1 }, (_, i) => f(i / steps)), seed);

const circle = (cx: number, cy: number, r: number, seed = 1) =>
  curve((t) => [cx + r * Math.cos(2 * Math.PI * t), cy + r * Math.sin(2 * Math.PI * t)], 90, seed);
const wave = (x0: number, x1: number, y: number, amp: number, periods: number, seed = 1) =>
  curve((t) => [x0 + (x1 - x0) * t, y + amp * Math.sin(2 * Math.PI * periods * t)], 160, seed);
const spiral = (cx: number, cy: number, r: number, turns: number, seed = 1) =>
  curve((t) => [cx + r * t * Math.cos(2 * Math.PI * turns * t), cy + r * t * Math.sin(2 * Math.PI * turns * t)], 240, seed);
const zigzag = (x0: number, x1: number, y: number, amp: number, teeth: number, seed = 1) =>
  polyline(Array.from({ length: 2 * teeth + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / (2 * teeth), y + (i % 2 ? amp : -amp)]), seed);
const polygon = (cx: number, cy: number, r: number, sides: number, spin = 0, seed = 1) =>
  polyline(Array.from({ length: sides + 1 }, (_, i) => [cx + r * Math.cos(spin + (2 * Math.PI * i) / sides), cy + r * Math.sin(spin + (2 * Math.PI * i) / sides)]), seed);
const star = (cx: number, cy: number, r: number, points: number, seed = 1) =>
  polyline(Array.from({ length: 2 * points + 1 }, (_, i) => {
    const a = -Math.PI / 2 + (Math.PI * i) / points;
    const rr = i % 2 ? r * 0.42 : r;
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  }), seed);
/** A tangle: a walk that keeps changing direction sharply. */
function scribble(cx: number, cy: number, w: number, h: number, turns: number, seed = 1): Path {
  const r = jitter(seed);
  const corners: Path = [];
  for (let i = 0; i < turns; i++) corners.push([cx + r() * w, cy + r() * h]);
  return polyline(corners, seed, 1.2);
}
/** Parallel strokes across a box at `angle`, `gap` apart. */
function hatch(x0: number, y0: number, x1: number, y1: number, angle: number, gap: number, seed = 1): Path[] {
  const out: Path[] = [];
  const [dx, dy] = [Math.cos(angle), Math.sin(angle)];
  const [nx, ny] = [-dy, dx];
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const reach = Math.hypot(x1 - x0, y1 - y0) / 2;
  for (let o = -reach; o <= reach; o += gap) {
    // Clip the line through (c + n*o) along d to the box.
    let tmin = -Infinity;
    let tmax = Infinity;
    const px = cx + nx * o;
    const py = cy + ny * o;
    for (const [p, d, lo, hi] of [[px, dx, x0, x1], [py, dy, y0, y1]]) {
      if (Math.abs(d) < 1e-9) {
        if (p < lo || p > hi) tmin = Infinity;
        continue;
      }
      const a = (lo - p) / d;
      const b = (hi - p) / d;
      tmin = Math.max(tmin, Math.min(a, b));
      tmax = Math.min(tmax, Math.max(a, b));
    }
    if (tmax - tmin < 20) continue;
    out.push(polyline([[px + dx * tmin, py + dy * tmin], [px + dx * tmax, py + dy * tmax]], seed + out.length));
  }
  return out;
}

/** Builds a scene's inputs: strokes drawn at a hand's pace, with pauses between. */
class Draw {
  readonly events: PageInput[] = [];
  private t = 0;

  stroke(path: Path, tool: StrokeTool, speed = 700): this {
    if (!path.length) return this;
    const [x, y] = path[0];
    this.events.push({ type: 'down', t: this.t, x, y, p: 0.5, tool });
    for (let i = 1; i < path.length; i += 2) {
      const points = path.slice(i, i + 2).map(([px, py], k): [number, number, number, number] => {
        const [qx, qy] = path[i + k - 1];
        this.t += (Math.hypot(px - qx, py - qy) / speed) * 1000;
        return [px, py, 0.5, this.t];
      });
      this.events.push({ type: 'move', t: this.t, points });
    }
    this.events.push({ type: 'up', t: (this.t += 10) });
    this.t += 250;
    return this;
  }

  strokes(paths: Path[], tool: StrokeTool, speed?: number): this {
    for (const p of paths) this.stroke(p, tool, speed);
    return this;
  }

  act(type: 'undo' | 'redo' | 'clear'): this {
    this.events.push({ type, t: (this.t += 200) });
    return this;
  }

  as(name: string): Recording {
    return { name, page: PAGE, events: this.events };
  }
}

const draw = () => new Draw();

const sweeps = (seed = 1): Path[] => [
  wave(140, 1060, 210, 30, 0.6, seed),
  wave(180, 1020, 380, 26, 0.5, seed + 1),
  wave(120, 1080, 560, 34, 0.7, seed + 2),
  wave(300, 900, 690, 18, 0.4, seed + 3),
];
const house = (): Path[] => [
  polyline([[450, 420], [750, 420], [750, 660], [450, 660], [450, 420]], 3),
  polyline([[430, 430], [600, 290], [770, 430]], 4),
  polyline([[570, 660], [570, 560], [630, 560], [630, 660]], 5),
  polygon(680, 490, 26, 4, Math.PI / 4, 6),
  circle(920, 200, 60, 7),
  ...Array.from({ length: 6 }, (_, i) => {
    const a = (2 * Math.PI * i) / 6;
    return polyline([[920 + 80 * Math.cos(a), 200 + 80 * Math.sin(a)], [920 + 120 * Math.cos(a), 200 + 120 * Math.sin(a)]], 8 + i);
  }),
];
const sixStrokes = (): Path[] => [
  circle(330, 300, 120, 11),
  zigzag(150, 1050, 650, 30, 7, 12),
  wave(600, 1100, 260, 40, 1.5, 13),
  polyline([[200, 520], [1000, 480]], 14),
  spiral(850, 420, 120, 2.5, 15),
  polygon(560, 420, 90, 3, 0, 16),
];

export const SCENES: Record<string, () => Recording> = {
  'sweeps-dark': () => draw().strokes(sweeps(), pencil()).as('sweeps-dark'),
  'sweeps-pale': () => draw().strokes(sweeps(), pencil(INK, 3, 0.25)).as('sweeps-pale'),
  'sweeps-yellow': () => draw().strokes(sweeps(), pencil(YELLOW, 3)).as('sweeps-yellow'),
  'hatch-sparse': () => draw().strokes(hatch(200, 150, 1000, 650, 1.1, 70), pencil(INK, 2)).as('hatch-sparse'),
  'hatch-dense': () => draw().strokes(hatch(200, 150, 1000, 650, 1.1, 14), pencil(INK, 2)).as('hatch-dense'),
  'crosshatch': () =>
    draw().strokes([...hatch(200, 150, 1000, 650, 1.1, 16), ...hatch(200, 150, 1000, 650, -0.6, 16, 50)], pencil(INK, 2)).as('crosshatch'),
  // Bands of the same width: the pencil's edge is crisp, the watercolor's feathers out.
  'bands-pencil': () => draw().strokes([wave(150, 1050, 300, 40, 0.5, 2), wave(150, 1050, 480, 40, 0.5, 3)], pencil(BLUE, 40)).as('bands-pencil'),
  'bands-watercolor': () => draw().strokes([wave(150, 1050, 300, 40, 0.5, 2), wave(150, 1050, 480, 40, 0.5, 3)], brush(BLUE, 12.5)).as('bands-watercolor'),
  'wash-broad': () => draw().strokes([wave(150, 1050, 300, 40, 0.5, 2), wave(150, 1050, 480, 40, 0.5, 3)], brush(BLUE, 14)).as('wash-broad'),
  'round-forms': () =>
    draw().strokes([circle(300, 300, 130, 21), circle(700, 420, 170, 22), spiral(980, 250, 120, 2, 23), circle(520, 640, 90, 24)], pencil()).as('round-forms'),
  'angular-forms': () =>
    draw().strokes([polygon(300, 300, 150, 3, 0.3, 31), star(700, 420, 190, 5, 32), zigzag(850, 1120, 250, 60, 3, 33), polygon(520, 640, 110, 4, 0.2, 34)], pencil()).as('angular-forms'),
  'loops-flowing': () => draw().strokes([wave(120, 1080, 300, 90, 2, 41), wave(120, 1080, 520, 70, 2.5, 42), spiral(600, 400, 160, 3, 43)], pencil()).as('loops-flowing'),
  'zigzags-jagged': () => draw().strokes([zigzag(120, 1080, 300, 90, 9, 51), zigzag(120, 1080, 520, 70, 12, 52), star(600, 400, 160, 7, 53)], pencil()).as('zigzags-jagged'),
  'scribble-restless': () => draw().strokes([scribble(600, 400, 500, 360, 70, 61), scribble(560, 420, 380, 300, 50, 62)], pencil(), 1600).as('scribble-restless'),
  'marks-clustered': () => draw().strokes(hatch(160, 120, 420, 340, 0.8, 14), pencil()).as('marks-clustered'),
  'marks-spread': () =>
    draw()
      .strokes([...hatch(80, 60, 200, 160, 0.8, 14), ...hatch(1000, 80, 1120, 180, 0.8, 14, 7), ...hatch(90, 620, 210, 720, 0.8, 14, 9), ...hatch(990, 600, 1110, 700, 0.8, 14, 11), ...hatch(540, 340, 660, 440, 0.8, 14, 13)], pencil())
      .as('marks-spread'),
  'thin-pale-lines': () => draw().strokes(sweeps(5), pencil('#7a7266', 1.5, 0.6)).as('thin-pale-lines'),
  'thick-dark-marker': () => draw().strokes(sweeps(5), pencil(INK, 28)).as('thick-dark-marker'),
  'overlap-colours': () =>
    draw().strokes([wave(150, 1050, 330, 40, 0.5, 71)], brush(BLUE, 14)).strokes([wave(150, 1050, 400, 40, 0.5, 72)], brush(YELLOW, 14)).as('overlap-colours'),
  'recolor-form': () => draw().stroke(circle(600, 400, 160, 81), pencil()).stroke(polyline([[480, 420], [720, 380]], 82), pencil(RED, 6)).as('recolor-form'),
  'lines-six': () => draw().strokes(hatch(200, 150, 1000, 650, 0, 90), pencil(INK, 4)).as('lines-six'),
  'erase-half': () =>
    draw().strokes(hatch(200, 150, 1000, 650, 0, 90), pencil(INK, 4)).stroke(polyline([[600, 100], [600, 700]], 91), eraser(400), 400).as('erase-half'),
  'undo-two': () => draw().strokes(sixStrokes().slice(0, 5), pencil()).act('undo').act('undo').as('undo-two'),
  'first-three': () => draw().strokes(sixStrokes().slice(0, 3), pencil()).as('first-three'),
  'order-a': () => draw().strokes(sixStrokes(), pencil()).as('order-a'),
  'order-b': () => draw().strokes([...sixStrokes()].reverse(), pencil()).as('order-b'),
  'order-c': () => {
    const s = sixStrokes();
    return draw().strokes([s[2], s[5], s[0], s[3], s[1], s[4]], pencil()).as('order-c');
  },
  'house-40': () => draw().strokes(house().slice(0, 4), pencil()).as('house-40'),
  'house-70': () => draw().strokes(house().slice(0, 8), pencil()).as('house-70'),
  'house-100': () => draw().strokes(house(), pencil()).as('house-100'),
};

/** `b` should read higher than `a` on `dim`. `same` lists dimensions the pair should leave about where they were. */
export interface Comparison {
  a: string;
  b: string;
  dim: string;
  same?: string[];
}

export const COMPARISONS: Comparison[] = [
  // Colour and tone alone: what the lines do, measured or interpreted, should hold still.
  { a: 'sweeps-dark', b: 'sweeps-pale', dim: 'lightness', same: ['density', 'angularity', 'openness', 'curvature', 'model.curved', 'model.flowing', 'model.restless'] },
  { a: 'sweeps-dark', b: 'sweeps-yellow', dim: 'lightness', same: ['angularity', 'openness', 'curvature', 'model.curved', 'model.flowing', 'model.restless'] },
  { a: 'thick-dark-marker', b: 'thin-pale-lines', dim: 'lightness' },
  { a: 'hatch-sparse', b: 'hatch-dense', dim: 'density', same: ['lightness', 'softness', 'angularity'] },
  { a: 'sweeps-dark', b: 'crosshatch', dim: 'density' },
  { a: 'marks-clustered', b: 'crosshatch', dim: 'density' },
  { a: 'sweeps-dark', b: 'wash-broad', dim: 'softness' },
  { a: 'sweeps-dark', b: 'bands-watercolor', dim: 'softness' },
  { a: 'crosshatch', b: 'overlap-colours', dim: 'softness' },
  { a: 'round-forms', b: 'angular-forms', dim: 'angularity', same: ['lightness', 'softness'] },
  { a: 'loops-flowing', b: 'zigzags-jagged', dim: 'angularity', same: ['lightness', 'softness'] },
  { a: 'sweeps-dark', b: 'scribble-restless', dim: 'angularity' },
  { a: 'marks-clustered', b: 'marks-spread', dim: 'spread', same: ['lightness', 'softness', 'density'] },
  { a: 'marks-spread', b: 'marks-clustered', dim: 'concentration' },
  { a: 'crosshatch', b: 'sweeps-dark', dim: 'openness' },
  { a: 'hatch-dense', b: 'hatch-sparse', dim: 'openness' },
  { a: 'wash-broad', b: 'crosshatch', dim: 'texture' },
  { a: 'thin-pale-lines', b: 'thick-dark-marker', dim: 'weight', same: ['angularity', 'curvature'] },
  { a: 'sweeps-pale', b: 'sweeps-dark', dim: 'contrast' },
  { a: 'erase-half', b: 'lines-six', dim: 'density', same: ['lightness'] },
  // Interpretations the measurements can't name directly.
  // A broad pencil's edge is as wide as a wash's (its tip fades out), so edge
  // width can't tell these apart; only the overall look can: grainy against smooth.
  { a: 'bands-pencil', b: 'bands-watercolor', dim: 'model.soft', same: ['angularity', 'curvature', 'weight', 'model.curved'] },
  { a: 'zigzags-jagged', b: 'loops-flowing', dim: 'model.flowing' },
  { a: 'scribble-restless', b: 'sweeps-dark', dim: 'model.flowing' },
  { a: 'angular-forms', b: 'round-forms', dim: 'model.flowing' },
  { a: 'crosshatch', b: 'loops-flowing', dim: 'model.flowing' },
  { a: 'thick-dark-marker', b: 'thin-pale-lines', dim: 'model.delicate' },
  { a: 'crosshatch', b: 'sweeps-pale', dim: 'model.delicate' },
  { a: 'bands-pencil', b: 'sweeps-pale', dim: 'model.delicate' },
  { a: 'thin-pale-lines', b: 'thick-dark-marker', dim: 'model.heavy' },
  { a: 'sweeps-pale', b: 'crosshatch', dim: 'model.heavy' },
  { a: 'sweeps-dark', b: 'thick-dark-marker', dim: 'model.heavy' },
  { a: 'sweeps-dark', b: 'scribble-restless', dim: 'model.restless' },
  { a: 'loops-flowing', b: 'zigzags-jagged', dim: 'model.restless' },
  { a: 'round-forms', b: 'scribble-restless', dim: 'model.restless' },
  { a: 'sweeps-pale', b: 'zigzags-jagged', dim: 'model.restless' },
];

/** Probes that interpret a measured quality, and which way they read it. */
export const PROBE_FOR: Record<string, { probe: string; invert?: boolean }> = {
  lightness: { probe: 'model.light' },
  density: { probe: 'model.dense' },
  softness: { probe: 'model.soft' },
  angularity: { probe: 'model.curved', invert: true },
};

/** Scenes that end on the same picture by different routes: their settled readings should agree. */
export const SAME_PICTURE: string[][] = [
  ['order-a', 'order-b', 'order-c'],
  ['undo-two', 'first-three'],
];

/** Scenes drawn bit by bit: each step should move the reading in proportion, not jump. */
export const PROGRESSIONS: string[][] = [['house-40', 'house-70', 'house-100']];
