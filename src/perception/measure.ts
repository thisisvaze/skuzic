/**
 * What the page looks like, measured from its pixels and its strokes: no
 * model, no labels, no idea what anything is. These are observations. Each is
 * 0..1 (warmth is -1..1) and means the same thing on any page size.
 *
 * Everything reads the page as rendered, so a pale glaze over black reads dark
 * and an erased line reads gone. Pure functions over plain arrays: they run in
 * the measuring worker and under node in the tests alike.
 */

export interface Pixels {
  /** RGBA, row by row. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The paper fill in DrawCanvas. */
export const PAPER = [252, 251, 248] as const;

export interface ImageMeasures {
  /** Share of the area under ink, each pixel counted by how strongly it is inked. The evidence for everything else. */
  ink: number;
  /** Mean lightness of the marks themselves, 0 black to 1 as light as the paper. */
  lightness: number;
  /** The lightest part of the page against its darkest marks. */
  contrast: number;
  /** How full the page is: ink share on a saturating curve, since most drawings cover well under a third. */
  density: number;
  /** Share of the area still blank at a glance: cells about 3% of the page across with no mark in them. */
  openness: number;
  /** Mean thickness of the marks, from hairline to broad wash. */
  weight: number;
  /** Edges per area: smooth washes and empty paper low, hatching and grain high. */
  texture: number;
  /** How wide the marks' edges are: crisp lines 0, soft washes 1. */
  softness: number;
  /** How colourful the marks are. */
  chroma: number;
  /** Hue of the coloured marks, -1 cool (blue) to 1 warm (orange); greys count for nothing. */
  warmth: number;
  /** The hue's other axis, -1 violet to 1 green: with warmth it tells blue from violet, yellow from red. */
  tint: number;
  /** The ink's centre of mass. */
  x: number;
  y: number;
  /** How far the ink reaches from its centre; 1 is an evenly covered page. */
  spread: number;
  /** 1 when all the ink sits in one place, 0 when it is even across the area. */
  concentration: number;
  /** 1 when the ink is centred, 0 when it all sits at an edge. */
  balance: number;
  /** Length of edge found, in analysis pixels: the evidence for softness and texture. */
  edges: number;
}

export interface StrokeMeasures {
  /** Total visible length in page diagonals. The evidence for the two below. */
  length: number;
  /** Total turning in radians, visible parts only. */
  turning: number;
  /** How much the lines bend: 0 straight, 1 coiled. */
  curvature: number;
  /** Share of the turning that happens at sharp corners: 0 round, 1 angular. */
  angularity: number;
}

export interface Change {
  /** Ink added, removed (erased or undone) and recoloured, as shares of the page. */
  added: number;
  removed: number;
  recolored: number;
  /** Where the page changed, in analysis pixels, or null if it didn't. */
  box: Rect | null;
}

/** A drawn stroke as the measures need it: its points in page (CSS) px. Erasers carry no marks. */
export interface Line {
  id: number;
  erasing: boolean;
  points: number[][];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const saturate = (v: number, scale: number) => 1 - Math.exp(-v / scale);

/** sRGB to linear light, by table. */
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIE L*a*b* of an sRGB colour (D65). */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = LINEAR[r];
  const G = LINEAR[g];
  const B = LINEAR[b];
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const PAPER_LAB = lab(...PAPER);

/**
 * The page as numbers every measure shares: lightness 0..1 and ink strength
 * 0..1 per pixel. Strength grows with the colour distance from the paper, so
 * a faint glaze counts a little and a solid mark fully.
 */
export interface Planes {
  width: number;
  height: number;
  light: Float32Array;
  ink: Float32Array;
  a: Float32Array;
  b: Float32Array;
}

/** Colour distance from the paper below this is invisible; at INK_FULL a pixel counts as fully inked. */
const INK_FLOOR = 3;
const INK_FULL = 38;

export function planesOf({ data, width, height }: Pixels): Planes {
  const n = width * height;
  const light = new Float32Array(n);
  const ink = new Float32Array(n);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [L, A, B] = lab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    light[i] = L / 100;
    a[i] = A;
    b[i] = B;
    const d = Math.hypot(L - PAPER_LAB[0], A - PAPER_LAB[1], B - PAPER_LAB[2]);
    ink[i] = clamp01((d - INK_FLOOR) / (INK_FULL - INK_FLOOR));
  }
  return { width, height, light, ink, a, b };
}

/** Hue where warmth peaks, in degrees on the a*b* plane: orange. Its opposite, sky blue, is the coolest. */
export const WARM_HUE = (55 * Math.PI) / 180;
/** Ink share where density reaches about two thirds. */
const DENSITY_SCALE = 0.15;
/** Edge length per pixel of drawn-on area where texture reaches about two thirds. */
const TEXTURE_SCALE = 0.15;
/**
 * A pixel is on an edge where lightness changes at least this much per pixel
 * and spans this much nearby. Low, so a soft, pale wash still has edges.
 */
const EDGE_SLOPE = 0.005;
const EDGE_SPAN = 0.04;
/** The window that measures an edge's span: up to this many pixels each side. Edges wider than it read fully soft. */
const SPAN_RADIUS = 5;
/** Edge widths, in analysis pixels, read as fully crisp and fully soft. A sharp step measures 2. */
const CRISP = 2.2;
const SOFT = 7;
/** Grid for concentration, and the fine grid (cells across the long edge) for texture and openness. */
const GRID = [6, 4];
const CELLS = 64;

/** Sliding max and min of a row or column, by brute force over a small radius. */
function spanFilter(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  const n = width * height;
  const hi = new Float32Array(n);
  const lo = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let mx = -Infinity;
      let mn = Infinity;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) {
        const v = src[y * width + k];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      hi[y * width + x] = mx;
      lo[y * width + x] = mn;
    }
  }
  const span = new Float32Array(n);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let mx = -Infinity;
      let mn = Infinity;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) {
        if (hi[k * width + x] > mx) mx = hi[k * width + x];
        if (lo[k * width + x] < mn) mn = lo[k * width + x];
      }
      span[y * width + x] = mx - mn;
    }
  }
  return span;
}

/** Value at which `share` of the histogram's weight lies below. */
function quantile(hist: Float64Array, total: number, share: number): number {
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= share * total) return i / (hist.length - 1);
  }
  return 1;
}

/** Measures `rect` of the page (all of it by default). */
export function measureImage(planes: Planes, rect: Rect = { x: 0, y: 0, width: planes.width, height: planes.height }): ImageMeasures {
  const { width: W } = planes;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const w = Math.max(1, Math.min(planes.width, Math.ceil(rect.x + rect.width)) - x0);
  const h = Math.max(1, Math.min(planes.height, Math.ceil(rect.y + rect.height)) - y0);
  const n = w * h;

  // The window as its own planes, so the filters below see only it.
  const light = new Float32Array(n);
  const ink = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      light[y * w + x] = planes.light[(y0 + y) * W + x0 + x];
      ink[y * w + x] = planes.ink[(y0 + y) * W + x0 + x];
    }
  }

  let inkSum = 0;
  let lightSum = 0;
  let chromaSum = 0;
  let warmSum = 0;
  let tintSum = 0;
  let mx = 0;
  let my = 0;
  let darkness = 0;
  const all = new Float64Array(101);
  const marks = new Float64Array(101);
  const [cols, rows] = GRID;
  const grid = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const L = light[i];
      const bin = Math.round(clamp01(L) * 100);
      all[bin]++;
      const s = ink[i];
      if (s <= 0) continue;
      const src = (y0 + y) * W + x0 + x;
      const C = Math.hypot(planes.a[src], planes.b[src]);
      inkSum += s;
      lightSum += s * L;
      chromaSum += s * C;
      const hue = Math.atan2(planes.b[src], planes.a[src]) - WARM_HUE;
      warmSum += s * C * Math.cos(hue);
      tintSum += s * C * Math.sin(hue);
      mx += s * x;
      my += s * y;
      marks[bin] += s;
      darkness += Math.max(0, PAPER_LAB[0] / 100 - L);
      grid[Math.min(rows - 1, Math.floor((y / h) * rows)) * cols + Math.min(cols - 1, Math.floor((x / w) * cols))] += s;
    }
  }

  const diag = Math.hypot(w, h);
  const cx = inkSum ? mx / inkSum : w / 2;
  const cy = inkSum ? my / inkSum : h / 2;
  let gyration = 0;
  let entropy = 0;
  if (inkSum) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ink[y * w + x];
        if (s > 0) gyration += s * ((x - cx) ** 2 + (y - cy) ** 2);
      }
    }
    for (const m of grid) if (m > 0) entropy -= (m / inkSum) * Math.log(m / inkSum);
  }

  // Edges: central-difference slope against the span of lightness nearby. A
  // step's slope is half its span; a ramp n pixels wide has a slope of span/n,
  // so slope-weighted span/slope estimates how wide the edges are, and
  // slope/span summed over an edge's pixels is 1 per pixel of its length,
  // however soft it is.
  const span = spanFilter(light, w, h, SPAN_RADIUS);
  let edges = 0;
  let variation = 0;
  let narrowness = 0;
  let slopes = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.hypot((light[i + 1] - light[i - 1]) / 2, (light[i + w] - light[i - w]) / 2);
      slopes += g;
      if (g < EDGE_SLOPE || span[i] < EDGE_SPAN) continue;
      edges += g / span[i];
      variation += g;
      narrowness += (g * g) / span[i];
    }
  }
  const edgeWidth = narrowness ? variation / narrowness : CRISP;
  // A line's darkness integrates to its width times its depth, and its slope
  // to twice its depth, so their ratio is its width whatever its tone.
  const thickness = slopes ? (2 * darkness) / slopes : 0;

  const cells = Math.max(w, h) / CELLS;
  const oc = Math.max(1, Math.round(w / cells));
  const or = Math.max(1, Math.round(h / cells));
  const coarse = new Float64Array(oc * or);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      coarse[Math.min(or - 1, Math.floor((y / h) * or)) * oc + Math.min(oc - 1, Math.floor((x / w) * oc))] += ink[y * w + x];
    }
  }
  const cellArea = (w / oc) * (h / or);
  const inked = Uint8Array.from(coarse, (m) => (m >= 0.02 * cellArea ? 1 : 0));
  // The drawn-on area: inked cells and their neighbours. Texture is edges per
  // drawn-on area, so a big smooth wash stays smooth and a small knot of
  // scribbles reads as busy as hatching that fills the page.
  let occupied = 0;
  for (let y = 0; y < or; y++) {
    for (let x = 0; x < oc; x++) {
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy++) {
        for (let dx = -1; dx <= 1 && !near; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < or && xx >= 0 && xx < oc && inked[yy * oc + xx]) near = 1;
        }
      }
      occupied += near;
    }
  }
  // Blank paper at a glance: 2x2 blocks of the fine grid with next to no ink.
  let blank = 0;
  let blocks = 0;
  for (let y = 0; y < or; y += 2) {
    for (let x = 0; x < oc; x += 2) {
      let m = 0;
      for (let dy = 0; dy < 2 && y + dy < or; dy++) for (let dx = 0; dx < 2 && x + dx < oc; dx++) m += coarse[(y + dy) * oc + x + dx];
      blocks++;
      if (m < 0.08 * cellArea) blank++;
    }
  }

  return {
    ink: inkSum / n,
    lightness: inkSum ? lightSum / inkSum : 1,
    contrast: inkSum ? clamp01(quantile(all, n, 0.98) - quantile(marks, inkSum, 0.1)) : 0,
    density: saturate(inkSum / n, DENSITY_SCALE),
    openness: blank / blocks,
    weight: saturate(thickness, 0.02 * Math.max(w, h)),
    texture: occupied ? saturate(edges / (occupied * cellArea), TEXTURE_SCALE) : 0,
    softness: clamp01((edgeWidth - CRISP) / (SOFT - CRISP)),
    chroma: inkSum ? clamp01(chromaSum / inkSum / 60) : 0,
    // Near-greys have a hue too; it counts only as far as the marks have colour.
    warmth: chromaSum ? (warmSum / chromaSum) * clamp01(chromaSum / inkSum / 12) : 0,
    tint: chromaSum ? (tintSum / chromaSum) * clamp01(chromaSum / inkSum / 12) : 0,
    x: cx / w,
    y: cy / h,
    // An evenly covered rectangle has a radius of gyration of diag/sqrt(12).
    spread: inkSum ? clamp01(Math.sqrt(gyration / inkSum) / (diag / Math.sqrt(12))) : 0,
    concentration: inkSum ? clamp01(1 - entropy / Math.log(cols * rows)) : 0,
    balance: clamp01(1 - Math.hypot(cx / w - 0.5, cy / h - 0.5) / Math.hypot(0.5, 0.5)),
    edges,
  };
}

/** A pixel counts as recoloured when both versions are inked and their colours differ by this much (CIE ΔE). */
const RECOLOR = 12;

/** What changed between two analyses of the same page. */
export function changeOf(before: Planes, after: Planes): Change {
  if (before.width !== after.width || before.height !== after.height) {
    return { added: 0, removed: 0, recolored: 0, box: null };
  }
  const { width, height } = after;
  let added = 0;
  let removed = 0;
  let recolored = 0;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < width * height; i++) {
    const d = after.ink[i] - before.ink[i];
    const both = Math.min(after.ink[i], before.ink[i]);
    const shift =
      both > 0.2 &&
      Math.hypot(
        (after.light[i] - before.light[i]) * 100,
        after.a[i] - before.a[i],
        after.b[i] - before.b[i],
      ) > RECOLOR;
    if (d > 0.05) added += d;
    else if (d < -0.05) removed -= d;
    if (shift) recolored += both;
    if (Math.abs(d) > 0.05 || shift) {
      const x = i % width;
      const y = (i - x) / width;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const n = width * height;
  return {
    added: added / n,
    removed: removed / n,
    recolored: recolored / n,
    box: x1 >= x0 ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
  };
}

/** Resample spacing along a stroke, as a share of the page diagonal. */
const STEP = 0.004;
/** Turning within this many steps either side that adds up to CORNER radians is a corner, not a curve. */
const CORNER_REACH = 2;
const CORNER = 0.9;
/** Mean turning per step where curvature reaches about two thirds. */
const CURVE_SCALE = 0.06;

/** A stroke resampled every `step` px and lightly smoothed, so pointer jitter doesn't read as turning. */
export function resample(points: number[][], step: number): number[][] {
  if (!points.length) return [];
  const out = [[points[0][0], points[0][1]]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let t = step - carry;
    while (t <= seg) {
      out.push([ax + ((bx - ax) * t) / seg, ay + ((by - ay) * t) / seg]);
      t += step;
    }
    carry = seg - (t - step);
  }
  if (out.length < 5) return out;
  // Binomial [1 4 6 4 1] smoothing, ends kept.
  const smooth = out.map((p) => [...p]);
  for (let i = 2; i < out.length - 2; i++) {
    for (const k of [0, 1]) {
      smooth[i][k] = (out[i - 2][k] + 4 * out[i - 1][k] + 6 * out[i][k] + 4 * out[i + 1][k] + out[i + 2][k]) / 16;
    }
  }
  return smooth;
}

/** Signed turning at each interior point of a polyline, in radians. */
export function turnsOf(path: number[][]): number[] {
  const turns: number[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const h0 = Math.atan2(path[i][1] - path[i - 1][1], path[i][0] - path[i - 1][0]);
    const h1 = Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]);
    let d = h1 - h0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turns.push(d);
  }
  return turns;
}

/**
 * How the lines bend, from the strokes themselves: the pixels can't tell a
 * corner from a crossing. Only what is still visible counts: `visible` says
 * how inked the page is at a point, so erased stretches drop out.
 */
export function measureStrokes(
  lines: Line[],
  page: { width: number; height: number },
  visible: (x: number, y: number) => number = () => 1,
): StrokeMeasures {
  const diag = Math.hypot(page.width, page.height) || 1;
  const step = STEP * diag;
  let length = 0;
  let turning = 0;
  let cornered = 0;
  let steps = 0;
  for (const line of lines) {
    if (line.erasing || line.points.length < 2) continue;
    const path = resample(line.points, step);
    const seen = path.map(([x, y]) => visible(x, y));
    for (let i = 1; i < path.length; i++) length += (step * (seen[i] + seen[i - 1])) / 2;
    const turns = turnsOf(path);
    for (let i = 0; i < turns.length; i++) {
      const v = seen[i + 1];
      if (v <= 0) continue;
      let local = 0;
      for (let k = Math.max(0, i - CORNER_REACH); k <= Math.min(turns.length - 1, i + CORNER_REACH); k++) local += turns[k];
      const t = Math.abs(turns[i]) * v;
      turning += t;
      if (Math.abs(local) >= CORNER) cornered += t;
      steps += v;
    }
  }
  return {
    length: length / diag,
    turning,
    curvature: steps ? saturate(turning / steps, CURVE_SCALE) : 0,
    angularity: turning ? cornered / turning : 0,
  };
}
