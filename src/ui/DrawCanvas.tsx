import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Droplet, Eraser, Loader2, Play, Redo2, Trash2, Undo2 } from 'lucide-react';
import getStroke from 'perfect-freehand';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { KEYS, load, save } from '@/lib/persist';

/** Longest edge sent to the planner. Above ~640px the extra detail is wasted. */
const EXPORT_MAX_EDGE = 640;
const EXPORT_QUALITY = 0.8;

const PAPER = '#f4f1ea';

/** Picked to stay legible against the paper fill once the model downsamples it. */
const COLORS = [
  '#15130f',
  '#7a7266',
  '#d1495b',
  '#e2711d',
  '#f0a202',
  '#6a994e',
  '#1b998b',
  '#2d7dd2',
  '#3d348b',
  '#7c3aed',
  '#e26d9e',
  '#8b5a2b',
];

/**
 * Nib range, Procreate-style: one continuous slider from a hairline to a
 * marker. Pressure/velocity still shapes each stroke; this only scales it.
 */
const SIZE_MIN = 1;
const SIZE_MAX = 40;
/** The preview dot must fit its cell however big the nib gets. */
const SIZE_DOT_MAX = 18;

/** Floor, not zero: a fully transparent nib is a broken tool, not a light one. */
const OPACITY_MIN = 0.1;

/**
 * Width comes from stylus pressure, or from velocity when there is none, which
 * is what makes a stroke read as drawn rather than plotted. Tuned for
 * sketching: quick strokes taper, slow ones press dark.
 */
const PENCIL = {
  size: 5,
  thinning: 0.62,
  smoothing: 0.5,
  streamline: 0.42,
  easing: (t: number) => Math.sin((t * Math.PI) / 2),
  last: true,
};

/** Erasing with a pencil-width nib is unusable; the wider nib matches intent. */
const ERASER_SCALE = 4;

/**
 * Paper tooth. The tile is generated once and repeated in canvas space, so two
 * strokes crossing the same spot hit the same peaks and pits — that alignment
 * is what reads as graphite. Grain that moved with each stroke would just read
 * as noise.
 */
const GRAIN_TILE = 256;
/** Floor keeps the pits translucent rather than transparent, so a single pass
 *  still reads as a continuous line once the planner downsamples it to 640px. */
const GRAIN_FLOOR = 0.42;
/** Below 1 so overlapping passes build up, the way graphite actually darkens. */
const INK_ALPHA = 0.88;

/** Bounded so a long session can't grow the history without limit. */
const MAX_HISTORY = 200;

/**
 * Every tool — colour, eraser, history — sits in the same square cell, so the
 * selected-state overlay is one consistent shape across the whole rail rather
 * than a ring on swatches and a pill on icons.
 */
const TOOL_CELL =
  'grid size-9 place-items-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60';
const TOOL_ON = 'bg-accent text-foreground';
const TOOL_OFF = 'text-muted-foreground hover:bg-secondary hover:text-foreground';

/** Resting pose when silent — still an equalizer glyph, just not moving. */
const EQ_REST = [0.45, 0.8, 0.6, 0.35];
const EQ_FLOOR = 0.16;
/** Meters look wrong with symmetric smoothing: level should jump and then sag,
 *  so attack is near-instant and release is slow. */
const EQ_ATTACK = 0.55;
const EQ_RELEASE = 0.12;

/**
 * Bars follow the actual spectrum. Levels are written straight to the DOM in a
 * rAF loop rather than through state — this runs at display rate, and putting
 * it through React would re-render the whole canvas tree 60 times a second.
 */
function Equalizer({
  animated,
  getLevels,
}: {
  animated?: boolean;
  getLevels?: (bands: number) => number[] | null;
}) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const apply = (values: number[]) =>
      values.forEach((v, i) => {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${EQ_FLOOR + v * (1 - EQ_FLOOR)})`;
      });

    if (!animated || !getLevels) {
      apply(EQ_REST);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply(EQ_REST);
      return;
    }

    const smoothed = [...EQ_REST];
    let raf = 0;

    const tick = () => {
      const levels = getLevels(EQ_REST.length);
      if (levels) {
        for (let i = 0; i < smoothed.length; i++) {
          const target = levels[i] ?? 0;
          const k = target > smoothed[i] ? EQ_ATTACK : EQ_RELEASE;
          smoothed[i] += (target - smoothed[i]) * k;
        }
        apply(smoothed);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animated, getLevels]);

  return (
    <span className="flex h-4 items-center gap-[2.5px]" aria-hidden="true">
      {EQ_REST.map((rest, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full w-[2.5px] origin-center rounded-full bg-current"
          style={{ transform: `scaleY(${EQ_FLOOR + rest * (1 - EQ_FLOOR)})` }}
        />
      ))}
    </span>
  );
}

const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface Stroke {
  /** [x, y, pressure] — the shape perfect-freehand consumes directly. */
  points: number[][];
  color: string;
  size: number;
  /** 0-1 nib opacity, multiplied into INK_ALPHA. Per stroke, so replaying the
   *  history after an undo keeps each mark as light as it was drawn. */
  alpha: number;
  erasing: boolean;
  /**
   * perfect-freehand *ignores* the supplied pressure when this is on, deriving
   * width from velocity instead. So it has to be off for a stylus, which
   * reports real pressure, and on for a mouse, which does not.
   */
  simulate: boolean;
}

/** Cheap deterministic PRNG — grain must not shimmer when history repaints. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Wrapping value noise — the lattice indices are taken modulo `cells`, so the
 * tile is seamless when repeated. Plain per-pixel random would tile fine but
 * looks like television static; correlated noise looks like fibre.
 */
function octave(cells: number, seed: number) {
  const grid = new Float32Array(cells * cells);
  const rand = seeded(seed);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  return (x: number, y: number) => {
    const fx = (x / GRAIN_TILE) * cells;
    const fy = (y / GRAIN_TILE) * cells;
    const x0 = Math.floor(fx) % cells;
    const y0 = Math.floor(fy) % cells;
    const x1 = (x0 + 1) % cells;
    const y1 = (y0 + 1) % cells;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    // Smoothstep, so the lattice doesn't show as diamond banding.
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const top = grid[y0 * cells + x0] + (grid[y0 * cells + x1] - grid[y0 * cells + x0]) * sx;
    const bot = grid[y1 * cells + x0] + (grid[y1 * cells + x1] - grid[y1 * cells + x0]) * sx;
    return top + (bot - top) * sy;
  };
}

/** A grayscale tooth in the alpha channel: 255 lets ink through, 0 blocks it. */
function makeGrainTile(): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = GRAIN_TILE;
  tile.height = GRAIN_TILE;
  const ctx = tile.getContext('2d');
  if (!ctx) return tile;

  // Three scales: broad paper undulation, fibre, and per-pixel bite.
  const coarse = octave(16, 0x9e37);
  const mid = octave(48, 0x85eb);
  const fine = octave(128, 0xc2b2);

  const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  for (let y = 0; y < GRAIN_TILE; y++) {
    for (let x = 0; x < GRAIN_TILE; x++) {
      const v = coarse(x, y) * 0.4 + mid(x, y) * 0.36 + fine(x, y) * 0.24;
      const a = GRAIN_FLOOR + (1 - GRAIN_FLOOR) * v;
      img.data[(y * GRAIN_TILE + x) * 4 + 3] = Math.round(255 * Math.min(1, a));
    }
  }
  ctx.putImageData(img, 0, 0);
  return tile;
}

/** perfect-freehand returns an outline; stitch it with mid-point quadratics. */
function outlinePath(outline: number[][]): Path2D {
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

/**
 * History is a list of vector strokes rather than bitmap snapshots — an
 * ImageData copy of this canvas is several megabytes, so a useful undo depth
 * would cost hundreds. Replaying strokes is cheap and makes `clear` undoable
 * too, as its own entry.
 */
type Entry = { kind: 'stroke'; stroke: Stroke } | { kind: 'clear' };

/** Ink laid down since the most recent clear; eraser strokes don't count. */
function hasInkIn(entries: Entry[]): boolean {
  const lastClear = entries.map((e) => e.kind).lastIndexOf('clear');
  return entries.slice(lastClear + 1).some((e) => e.kind === 'stroke' && !e.stroke.erasing);
}

export interface CanvasHandle {
  toDataURL: () => string;
  clear: () => void;
  isEmpty: () => boolean;
  undo: () => void;
  redo: () => void;
}

interface Props {
  /** Explicit request — the sparkle button. Runs immediately. */
  onInterpret?: () => void;
  /**
   * Fired when the pad changes on its own (stroke finished, undo, redo) while
   * auto-interpret is on. The parent debounces this, so a burst of strokes
   * costs one plan rather than one per stroke.
   */
  onAutoInterpret?: () => void;
  /** Fired after clearing the pad when auto-interpret is on. */
  onClearInterpret?: () => void;
  interpretDisabled?: boolean;
  interpreting?: boolean;
  /** Drives the equalizer icon — it should only move while audio is running. */
  playing?: boolean;
  /** Live spectrum for the equalizer icon. */
  getLevels?: (bands: number) => number[] | null;
  autoInterpret?: boolean;
  /** Idle gate — fades the pad and shows a centered start control. */
  showStart?: boolean;
  onStart?: () => void;
  startDisabled?: boolean;
  startTitle?: string;
  startExtras?: ReactNode;
}

/**
 * Light paper surface with dark ink — the model reads a drawn shape far more
 * reliably this way than as light strokes on a dark background.
 */
export const DrawCanvas = forwardRef<CanvasHandle, Props>(function DrawCanvas(
  {
    onInterpret,
    onAutoInterpret,
    onClearInterpret,
    interpretDisabled,
    interpreting,
    playing,
    getLevels,
    autoInterpret,
    showStart,
    onStart,
    startDisabled,
    startTitle,
    startExtras,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const [color, setColor] = useState(() => load(KEYS.inkColor, COLORS[0]));
  useEffect(() => {
    save(KEYS.inkColor, color);
  }, [color]);
  const [erasing, setErasing] = useState(false);
  const [brushSize, setBrushSize] = useState(() => load(KEYS.brushSize, PENCIL.size));
  useEffect(() => {
    save(KEYS.brushSize, brushSize);
  }, [brushSize]);
  const [brushOpacity, setBrushOpacity] = useState(() => load(KEYS.brushOpacity, 1));
  useEffect(() => {
    save(KEYS.brushOpacity, brushOpacity);
  }, [brushOpacity]);

  const past = useRef<Entry[]>([]);
  const future = useRef<Entry[]>([]);
  const stroke = useRef<Stroke | null>(null);
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const grainRef = useRef<CanvasPattern | null>(null);
  const dprRef = useRef(1);
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });

  const fill = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const paintStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    if (!s.points.length) return;

    const outline = getStroke(s.points, {
      ...PENCIL,
      size: s.size,
      simulatePressure: s.simulate,
      // The eraser is a blunt tool: no taper, so it lifts a predictable band.
      thinning: s.erasing ? 0 : PENCIL.thinning,
    });

    const path = outlinePath(outline);

    // The eraser lifts everything, tooth included.
    if (s.erasing) {
      ctx.fillStyle = PAPER;
      ctx.fill(path);
      return;
    }

    const scratch = scratchRef.current;
    const sctx = scratch?.getContext('2d');
    const grain = grainRef.current;
    if (!scratch || !sctx || !grain) {
      ctx.globalAlpha = INK_ALPHA * s.alpha;
      ctx.fillStyle = s.color;
      ctx.fill(path);
      ctx.globalAlpha = 1;
      return;
    }

    // Only touch the stroke's own bounds — masking the full canvas per frame
    // during a live stroke is what would make this crawl.
    const dpr = dprRef.current;
    const w = scratch.width / dpr;
    const h = scratch.height / dpr;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outline) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) return;

    const bx = Math.max(0, Math.floor(minX) - 2);
    const by = Math.max(0, Math.floor(minY) - 2);
    const bw = Math.min(w, Math.ceil(maxX) + 2) - bx;
    const bh = Math.min(h, Math.ceil(maxY) + 2) - by;
    if (bw <= 0 || bh <= 0) return;

    // The clip is load-bearing, not tidiness: destination-in is defined over
    // the whole surface, so without it every frame of a live stroke would mask
    // the entire canvas and the bounds above would buy nothing.
    sctx.save();
    sctx.beginPath();
    sctx.rect(bx, by, bw, bh);
    sctx.clip();

    sctx.clearRect(bx, by, bw, bh);
    sctx.fillStyle = s.color;
    sctx.fill(path);
    // Punch the paper tooth out of the stroke. The pattern is filled in canvas
    // coordinates, which is what keeps it locked to the sheet.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.fillStyle = grain;
    sctx.fillRect(bx, by, bw, bh);
    sctx.globalCompositeOperation = 'source-over';
    sctx.restore();

    ctx.globalAlpha = INK_ALPHA * s.alpha;
    ctx.drawImage(scratch, bx * dpr, by * dpr, bw * dpr, bh * dpr, bx, by, bw, bh);
    ctx.globalAlpha = 1;
  };

  /**
   * Committed strokes live on an offscreen copy. A perfect-freehand outline
   * changes shape as points arrive, so the in-progress stroke has to be redrawn
   * every frame — blitting the buffer keeps that cost flat instead of replaying
   * the whole drawing on each pointer move.
   */
  const redrawBase = () => {
    const base = baseRef.current;
    const ctx = base?.getContext('2d');
    if (!base || !ctx) return;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, base.width, base.height);
    for (const entry of past.current) {
      if (entry.kind === 'clear') ctx.fillRect(0, 0, base.width, base.height);
      else paintStroke(ctx, entry.stroke);
    }
  };

  /** Blit the committed buffer, then the live stroke on top. */
  const present = () => {
    const canvas = canvasRef.current;
    const base = baseRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !base || !ctx) return;
    const dpr = dprRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, base.width / dpr, base.height / dpr);
    if (stroke.current) paintStroke(ctx, stroke.current);
  };

  const repaint = () => {
    redrawBase();
    present();
    const ink = hasInkIn(past.current);
    dirty.current = ink;
    setHasInk(ink);
    setDepth({ undo: past.current.length, redo: future.current.length });
  };

  /** A new entry always invalidates the redo branch. */
  const commit = (entry: Entry) => {
    past.current.push(entry);
    if (past.current.length > MAX_HISTORY) past.current.shift();
    future.current = [];
    setDepth({ undo: past.current.length, redo: 0 });
  };

  const undo = () => {
    const entry = past.current.pop();
    if (!entry) return;
    future.current.push(entry);
    repaint();
    if (canAutoInterpret()) onAutoInterpret?.();
  };

  const redo = () => {
    const entry = future.current.pop();
    if (!entry) return;
    past.current.push(entry);
    repaint();
    if (canAutoInterpret()) onAutoInterpret?.();
  };

  const clearPad = () => {
    commit({ kind: 'clear' });
    repaint();
  };

  /** Clearing from the toolbar also has to tell the planner the page is blank. */
  const clearFromToolbar = () => {
    const hadInk = dirty.current;
    clearPad();
    if (hadInk && canAutoInterpret()) {
      (onClearInterpret ?? onAutoInterpret ?? onInterpret)?.();
    }
  };

  /**
   * Size the backing store to the element's *current* box. Assigning width or
   * height resets the 2D context, so every transform has to be reapplied here.
   */
  const resizeSurfaces = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === w && canvas.height === h && dprRef.current === dpr) return;

    dprRef.current = dpr;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.scale(dpr, dpr);

    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    base.getContext('2d')?.scale(dpr, dpr);
    baseRef.current = base;

    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d');
    sctx?.scale(dpr, dpr);
    scratchRef.current = scratch;
    grainRef.current = sctx?.createPattern(makeGrainTile(), 'repeat') ?? null;

    fill();
    redrawBase();
    present();
  };

  /**
   * Without this the backing store keeps its mount-time pixel size while the
   * CSS box follows the window, and the browser stretches one to the other —
   * the drawing scales and every stroke changes apparent width. Re-sizing and
   * replaying the stroke history instead keeps marks at the size they were
   * drawn; a wider window reveals more paper rather than magnifying the page.
   *
   * ponytail: only observes layout, so dragging the window to a monitor with a
   * different devicePixelRatio at identical CSS size won't re-render until the
   * next resize. Add a resolution matchMedia listener if that ever shows up.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeSurfaces();

    // A drag fires this every frame, and each pass replays the whole history —
    // coalescing to one rebuild per frame is what keeps that affordable.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resizeSurfaces();
      });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
    // Mount only: the callbacks it uses read through refs, never through props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    toDataURL: () => {
      const canvas = canvasRef.current;
      if (!canvas) return '';

      // The backing store is DPR-scaled and can run past 1400px wide, but the
      // planner only needs the shape. Downscaling before encoding shrinks the
      // upload by an order of magnitude, which is the part of the round trip we
      // actually control. JPEG is safe here — the paper fill means no alpha.
      const scale = Math.min(1, EXPORT_MAX_EDGE / Math.max(canvas.width, canvas.height));
      if (scale === 1) return canvas.toDataURL('image/jpeg', EXPORT_QUALITY);

      const out = document.createElement('canvas');
      out.width = Math.round(canvas.width * scale);
      out.height = Math.round(canvas.height * scale);
      const ctx = out.getContext('2d');
      if (!ctx) return canvas.toDataURL('image/jpeg', EXPORT_QUALITY);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', EXPORT_QUALITY);
    },
    clear: clearPad,
    isEmpty: () => !dirty.current,
    undo,
    redo,
  }));

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // A mouse reports 0 (or a flat 0.5); perfect-freehand simulates the rest
    // from velocity, so a neutral seed is the right starting point.
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
    };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!canvasRef.current) return;
    drawing.current = true;
    // An eraser stroke can only remove ink, so it never makes a blank canvas
    // count as drawn-on.
    if (!erasing) {
      dirty.current = true;
      setHasInk(true);
    }
    const { x, y, pressure } = pos(e);
    // Recorded as it is drawn so undo can replay the pad without bitmap copies.
    stroke.current = {
      points: [[x, y, pressure]],
      color,
      size: erasing ? brushSize * ERASER_SCALE : brushSize,
      alpha: brushOpacity,
      erasing,
      simulate: e.pointerType !== 'pen',
    };
    present();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !stroke.current) return;
    // Coalesced events give the smoother point stream a pencil needs on a
    // high-refresh display; the fallback is the event itself.
    const raw = typeof e.nativeEvent.getCoalescedEvents === 'function'
      ? e.nativeEvent.getCoalescedEvents()
      : [];
    const samples = raw.length ? raw : [e.nativeEvent];
    const rect = e.currentTarget.getBoundingClientRect();
    for (const sample of samples) {
      stroke.current.points.push([
        sample.clientX - rect.left,
        sample.clientY - rect.top,
        sample.pressure || 0.5,
      ]);
    }
    present();
  };

  // `interpreting` is deliberately not part of this test. The parent coalesces
  // overlapping requests, so a stroke drawn while a plan is in flight still has
  // to register — otherwise the pad the user ends on never gets interpreted.
  const canAutoInterpret = () =>
    !!autoInterpret && !interpretDisabled && !!(onAutoInterpret ?? onInterpret);

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const finished = stroke.current;
    stroke.current = null;
    if (finished) {
      commit({ kind: 'stroke', stroke: finished });
      // Fold it into the buffer so the next stroke blits instead of replaying.
      const ctx = baseRef.current?.getContext('2d');
      if (ctx) paintStroke(ctx, finished);
      present();
    }
    if (canAutoInterpret() && dirty.current) (onAutoInterpret ?? onInterpret)?.();
  };

  // Cmd/Ctrl+Z undoes, Cmd+Shift+Z or Ctrl+Y redoes — but never while the user
  // is typing in the event field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      if (key === 'y' || e.shiftKey) redo();
      else undo();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative overflow-hidden rounded-2xl">
        <canvas
          ref={canvasRef}
          className={cn(
            'block h-[28rem] w-full touch-none transition-opacity duration-300 xl:h-[36rem]',
            showStart ? 'cursor-default opacity-40' : 'cursor-crosshair',
          )}
          onPointerDown={showStart ? undefined : down}
          onPointerMove={showStart ? undefined : move}
          onPointerUp={showStart ? undefined : up}
          onPointerLeave={showStart ? undefined : up}
        />
        {!hasInk && !showStart && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-[#a8a49a]">
            draw something
          </div>
        )}
        {showStart && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#f4f1ea]/35 px-6">
            {startExtras}
            <Button
              type="button"
              size="icon"
              variant="default"
              aria-label="start"
              title={startTitle ?? 'start'}
              disabled={startDisabled}
              className="size-20 shadow-lg [&_svg]:size-8"
              onClick={onStart}
            >
              <Play className="translate-x-0.5" />
            </Button>
          </div>
        )}
        {onInterpret && !showStart && (
          <Button
            type="button"
            size="icon"
            variant="default"
            aria-label="interpret drawing"
            title="interpret drawing"
            disabled={interpretDisabled || interpreting}
            className="absolute right-3 bottom-3 size-10 shadow-md"
            onClick={onInterpret}
          >
            {interpreting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Equalizer animated={playing} getLevels={getLevels} />
            )}
          </Button>
        )}
      </div>

      {!showStart && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex flex-wrap gap-0.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`colour ${c}`}
                aria-pressed={!erasing && color === c}
                title={c}
                onClick={() => {
                  setColor(c);
                  setErasing(false);
                }}
                className={cn(TOOL_CELL, !erasing && color === c ? TOOL_ON : TOOL_OFF)}
              >
                <span className="size-5 rounded-full" style={{ backgroundColor: c }} />
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-muted-foreground">
            <span
              className="grid size-5 shrink-0 place-items-center"
              aria-hidden="true"
              title={`brush ${brushSize}px`}
            >
              <span
                className="rounded-full bg-current"
                style={{
                  width: Math.max(3, (brushSize / SIZE_MAX) * SIZE_DOT_MAX),
                  height: Math.max(3, (brushSize / SIZE_MAX) * SIZE_DOT_MAX),
                  opacity: brushOpacity,
                }}
              />
            </span>
            <Slider
              className="w-24"
              value={[brushSize]}
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={1}
              aria-label="brush size"
              title={`brush ${brushSize}px`}
              onValueChange={([v]) => setBrushSize(v)}
            />
          </div>

          <div className="flex items-center gap-2 text-muted-foreground">
            <span
              className="grid size-5 shrink-0 place-items-center"
              aria-hidden="true"
              title={`opacity ${Math.round(brushOpacity * 100)}%`}
            >
              <Droplet className="size-4" style={{ opacity: 0.35 + brushOpacity * 0.65 }} />
            </span>
            <Slider
              className="w-24"
              value={[brushOpacity * 100]}
              min={OPACITY_MIN * 100}
              max={100}
              step={1}
              aria-label="brush opacity"
              title={`opacity ${Math.round(brushOpacity * 100)}%`}
              onValueChange={([v]) => setBrushOpacity(v / 100)}
            />
          </div>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="eraser"
              aria-pressed={erasing}
              title="eraser"
              onClick={() => setErasing((on) => !on)}
              className={cn(TOOL_CELL, erasing ? TOOL_ON : TOOL_OFF)}
            >
              <Eraser className="size-4" />
            </button>
          </div>

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="undo"
              title={`undo (${MOD}Z)`}
              disabled={!depth.undo}
              onClick={undo}
              className={cn(TOOL_CELL, TOOL_OFF, 'disabled:pointer-events-none disabled:opacity-35')}
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label="redo"
              title={`redo (${MOD}⇧Z)`}
              disabled={!depth.redo}
              onClick={redo}
              className={cn(TOOL_CELL, TOOL_OFF, 'disabled:pointer-events-none disabled:opacity-35')}
            >
              <Redo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label="clear drawing"
              title="clear"
              disabled={!hasInk}
              onClick={clearFromToolbar}
              className={cn(
                TOOL_CELL,
                TOOL_OFF,
                'hover:text-destructive disabled:pointer-events-none disabled:opacity-35',
              )}
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
