/**
 * Pencil and watercolor, drawn the way painting apps (and PencilKit, which the
 * iPad app uses) draw them: a small tip stamped along the pen's path many times
 * a stroke, each stamp faint, so paint builds up where the pen lingers or goes
 * back over itself.
 *
 * Each stroke is stamped into a layer of its own, then the paper's tooth is cut
 * out of it and it is glazed onto the page with `multiply`, so it mixes with
 * whatever is underneath while it is being drawn: blue over yellow reads green.
 *
 * Stamping depends only on the points, never on when they arrived, so the stroke
 * drawn live and the stroke replayed for undo, redo or a resize are the same.
 *
 * ponytail: the mix is RGB multiply, not pigment. spectral.js (MIT,
 * Kubelka-Munk) would give cleaner greens; running, drying paint needs a
 * wet-paper simulation like msurguy/watercolor-playground. Pen, marker and
 * crayon, the iPad's other inks, are a Spec each away.
 */

export type Medium = 'pencil' | 'watercolor';

interface Spec {
  /** Tip diameter as a multiple of the brush size, and how much a firm touch widens it. */
  tip: number;
  swell: number;
  /** Gap between stamps, as a fraction of the tip. */
  spacing: number;
  /** Each stamp's opacity at the lightest touch and at the firmest. */
  flow: [number, number];
  /** How much of the paper's tooth shows through (1 = all of it), and how coarse it is. */
  tooth: number;
  grain: number;
  /** How much the path is smoothed, 0 (raw) to 1. */
  streamline: number;
}

const MEDIA: Record<Medium, Spec> = {
  // Narrow and firm. Its darkness comes from pressure and the paper, not its width.
  pencil: { tip: 1, swell: 0.3, spacing: 0.16, flow: [0.06, 0.42], tooth: 1, grain: 1, streamline: 0.3 },
  // Broad and soft, laid very thin, so it pools where the brush slows or crosses itself.
  watercolor: { tip: 3.2, swell: 0.45, spacing: 0.07, flow: [0.05, 0.11], tooth: 0.45, grain: 2.2, streamline: 0.5 },
};

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const empty = (): Rect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const grow = (r: Rect, x: number, y: number, pad: number) => {
  r.x0 = Math.min(r.x0, x - pad);
  r.y0 = Math.min(r.y0, y - pad);
  r.x1 = Math.max(r.x1, x + pad);
  r.y1 = Math.max(r.y1, y + pad);
};

/** A stable number in [0, 1) for stamp `n` of stroke `seed`, so a replay turns each stamp the same way. */
function hash(seed: number, n: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(n + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

/** Tips, one per medium, colour and (for the brush) variant, made once. */
const tips = new Map<string, HTMLCanvasElement>();
const TIP = 64;
const BRUSH_VARIANTS = 4;

function tip(medium: Medium, color: string, variant: number): HTMLCanvasElement {
  const key = `${medium}${color}${variant}`;
  let c = tips.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = TIP;
  const ctx = c.getContext('2d');
  if (ctx) {
    const r = TIP / 2;
    const rgbs = rgb(color);
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    if (medium === 'pencil') {
      // A firm lead with just enough edge falloff to stay smooth when scaled down.
      g.addColorStop(0, `rgba(${rgbs}, 1)`);
      g.addColorStop(0.72, `rgba(${rgbs}, 1)`);
      g.addColorStop(1, `rgba(${rgbs}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, TIP, TIP);
    } else {
      // A soft, loaded brush: a little more pigment toward its edge, where water
      // carries it, then a feathered fall-off. Its outline wanders, differently
      // in each variant, so the stamps never line up into a pattern.
      g.addColorStop(0, `rgba(${rgbs}, 0.5)`);
      g.addColorStop(0.62, `rgba(${rgbs}, 0.58)`);
      g.addColorStop(0.86, `rgba(${rgbs}, 1)`);
      g.addColorStop(0.95, `rgba(${rgbs}, 0.45)`);
      g.addColorStop(1, `rgba(${rgbs}, 0)`);
      ctx.beginPath();
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const wobble =
          0.06 * Math.sin(3 * a + variant * 1.7) + 0.04 * Math.sin(5 * a + variant * 2.9) + 0.03 * Math.sin(9 * a + variant);
        const rr = r * (0.9 + wobble);
        ctx.lineTo(r + rr * Math.cos(a), r + rr * Math.sin(a));
      }
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.filter = 'blur(0.8px)';
      ctx.fill();
    }
  }
  tips.set(key, c);
  return c;
}

/**
 * Walks a stroke's points and stamps its tip along them. Feeding the points in
 * one go, or a few at a time as they arrive, lays exactly the same stamps.
 */
export class Stamper {
  /** Everything stamped so far, in CSS px. */
  readonly bounds = empty();
  private spec: Spec;
  private x = 0;
  private y = 0;
  private p = 0.5;
  private raw: number[] | null = null;
  private carry = 0;
  private n = 0;

  constructor(
    private medium: Medium,
    private size: number,
    private color: string,
    private seed: number,
    /** A mouse or finger: pressure comes from how slowly it moves instead. */
    private simulate: boolean,
  ) {
    this.spec = MEDIA[medium];
  }

  /** Stamps up to these points; returns what changed, in CSS px. */
  add(ctx: CanvasRenderingContext2D, points: number[][]): Rect | null {
    const dirty = empty();
    for (const [px, py, pressure] of points) {
      const last = this.raw;
      this.raw = [px, py];
      const touch = this.simulate
        ? last
          ? Math.min(0.9, Math.max(0.22, 0.9 - Math.hypot(px - last[0], py - last[1]) / 28))
          : 0.6
        : pressure;
      if (!last) {
        // Pen down: a tap leaves a mark.
        [this.x, this.y, this.p] = [px, py, touch];
        this.stamp(ctx, px, py, touch, dirty);
        continue;
      }
      const follow = 1 - this.spec.streamline;
      this.walk(
        ctx,
        this.x + (px - this.x) * follow,
        this.y + (py - this.y) * follow,
        this.p + (touch - this.p) * (this.simulate ? 0.15 : 0.35),
        dirty,
      );
    }
    return dirty.x0 === Infinity ? null : dirty;
  }

  /** Pen up: the smoothed path catches up with the pen. */
  finish(ctx: CanvasRenderingContext2D): Rect | null {
    if (!this.raw) return null;
    const dirty = empty();
    this.walk(ctx, this.raw[0], this.raw[1], this.p, dirty);
    return dirty.x0 === Infinity ? null : dirty;
  }

  private walk(ctx: CanvasRenderingContext2D, nx: number, ny: number, np: number, dirty: Rect) {
    const [x0, y0, p0] = [this.x, this.y, this.p];
    const len = Math.hypot(nx - x0, ny - y0);
    const step = Math.max(0.4, this.diameter(p0) * this.spec.spacing);
    let d = step - this.carry;
    while (d <= len) {
      const t = d / len;
      this.stamp(ctx, x0 + (nx - x0) * t, y0 + (ny - y0) * t, p0 + (np - p0) * t, dirty);
      d += step;
    }
    this.carry = len - (d - step);
    [this.x, this.y, this.p] = [nx, ny, np];
  }

  private diameter(p: number) {
    return this.size * this.spec.tip * (1 - this.spec.swell / 2 + this.spec.swell * p);
  }

  private stamp(ctx: CanvasRenderingContext2D, x: number, y: number, p: number, dirty: Rect) {
    const { flow } = this.spec;
    const r = this.diameter(p) / 2;
    const h = hash(this.seed, this.n++);
    ctx.globalAlpha = flow[0] + (flow[1] - flow[0]) * p ** 1.4;
    if (this.medium === 'watercolor') {
      // Turned and varied a little, stamp to stamp.
      const a = h * Math.PI * 2;
      const [cos, sin] = [Math.cos(a), Math.sin(a)];
      const m = ctx.getTransform();
      ctx.transform(cos, sin, -sin, cos, x, y);
      ctx.drawImage(tip(this.medium, this.color, Math.floor(h * 997) % BRUSH_VARIANTS), -r, -r, r * 2, r * 2);
      ctx.setTransform(m);
    } else {
      ctx.drawImage(tip(this.medium, this.color, 0), x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    grow(dirty, x, y, r + 2);
    grow(this.bounds, x, y, r + 2);
  }
}

/** The paper's hollows, opaque: the grain tile with its alpha turned inside out. */
export function paperPits(grain: HTMLCanvasElement): HTMLCanvasElement {
  const pits = document.createElement('canvas');
  pits.width = grain.width;
  pits.height = grain.height;
  const ctx = pits.getContext('2d');
  const src = grain.getContext('2d');
  if (!ctx || !src) return pits;
  const img = src.getImageData(0, 0, grain.width, grain.height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255 - img.data[i];
  ctx.putImageData(img, 0, 0);
  return pits;
}

/** A CSS px rect as whole device pixels inside the canvas. */
function device(r: Rect, dpr: number, canvas: HTMLCanvasElement) {
  const x = Math.max(0, Math.floor(r.x0 * dpr));
  const y = Math.max(0, Math.floor(r.y0 * dpr));
  return [x, y, Math.min(canvas.width, Math.ceil(r.x1 * dpr)) - x, Math.min(canvas.height, Math.ceil(r.y1 * dpr)) - y];
}

/**
 * Copies `rect` of the stroke's layer into `out` with the paper's tooth taken
 * out of it: graphite and pigment stay off the paper's hollows. The tooth is
 * fixed to the sheet, so every stroke catches the same grain.
 */
export function tooth(
  out: HTMLCanvasElement,
  layer: HTMLCanvasElement,
  rect: Rect,
  medium: Medium,
  pits: CanvasPattern,
  dpr: number,
) {
  const ctx = out.getContext('2d');
  if (!ctx) return;
  const [x, y, w, h] = device(rect, dpr, out);
  if (w <= 0 || h <= 0) return;
  const { tooth: amount, grain } = MEDIA[medium];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(layer, x, y, w, h, x, y, w, h);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = amount;
  pits.setTransform(new DOMMatrix([dpr * grain, 0, 0, dpr * grain, 0, 0]));
  ctx.fillStyle = pits;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Lays a stroke (already through `tooth`) onto the page, mixing with what's there. */
export function glaze(ctx: CanvasRenderingContext2D, toothed: HTMLCanvasElement, rect: Rect, alpha: number, dpr: number) {
  const [x, y, w, h] = device(rect, dpr, toothed);
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = alpha;
  ctx.drawImage(toothed, x, y, w, h, x, y, w, h);
  ctx.restore();
}
