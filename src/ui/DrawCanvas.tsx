import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AudioLines, Droplet, Eraser, Play, Redo2, Trash2, Undo2 } from 'lucide-react';
import getStroke from 'perfect-freehand';
import { TouchEngine, prefetchPenSounds } from '@/audio/touch';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { KEYS, load, save } from '@/lib/persist';

/** Longest edge sent to the planner. Above ~640px the extra detail is wasted. */
const EXPORT_MAX_EDGE = 640;
const EXPORT_QUALITY = 0.8;

const PAPER = '#fcfbf8';

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

/** From this nib size up, the paper sounds like a marker rather than a pencil. */
const MARKER_SIZE = 14;

/** Bounded so a long session can't grow the history without limit. */
const MAX_HISTORY = 200;

/**
 * Every tool — colour, eraser, history — sits in the same square cell, so the
 * selected-state overlay is one consistent shape across the whole rail rather
 * than a ring on swatches and a pill on icons.
 */
const TOOL_CELL =
  'grid size-9 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60';
const TOOL_ON = 'bg-accent text-foreground';
const TOOL_OFF = 'text-muted-foreground hover:bg-secondary hover:text-foreground';

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
  /** The music changed scene: the pen answers right away, before the band follows. */
  cue: (bright?: boolean) => void;
}

interface Props {
  /**
   * Fired when the pad changes on its own (stroke finished, undo, redo) while
   * auto-interpret is on. The parent reads the page with SigLIP and collapses a
   * burst of strokes into one read.
   */
  onAutoInterpret?: () => void;
  /** Fired when the page is wiped from the toolbar, whether or not the music follows the drawing. */
  onClear?: () => void;
  /** Shown along the bottom of the blank page, under the hint. Only its own controls take clicks. */
  emptyState?: ReactNode;
  interpretDisabled?: boolean;
  /** The sheet only glows while audio is actually running. */
  playing?: boolean;
  /** Live spectrum the glow follows. */
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
    onAutoInterpret,
    onClear,
    emptyState,
    interpretDisabled,
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

  /** The pen's own sound. Built on the first stroke, inside that gesture, so the browser lets it play. */
  const touch = useRef<TouchEngine | null>(null);
  // The piano downloads while the page settles, so the first stroke can already sing.
  useEffect(() => {
    prefetchPenSounds().catch(() => {});
  }, []);
  // Read through a ref: the engine outlives renders and should always hear the current band.
  const levelsRef = useRef(getLevels);
  levelsRef.current = getLevels;
  const [paperSound, setPaperSound] = useState(() => load(KEYS.paperSound, true));
  useEffect(() => {
    save(KEYS.paperSound, paperSound);
    // Switching off mid-stroke lets that stroke ring out instead of carrying on.
    if (!paperSound) touch.current?.up();
  }, [paperSound]);
  // Nulled as well as closed: StrictMode remounts, and a closed context can't be reused.
  useEffect(
    () => () => {
      touch.current?.close();
      touch.current = null;
    },
    [],
  );

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
    if (hadInk) touch.current?.clear();
    clearPad();
    if (hadInk) onClear?.();
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
    cue: (bright) => touch.current?.cue(bright),
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
    if (paperSound) {
      if (!touch.current) {
        touch.current = new TouchEngine();
        touch.current.listen(() => {
          const bands = levelsRef.current?.(4);
          return bands?.length ? bands.reduce((a, b) => a + b, 0) / bands.length : 0;
        });
      }
      const { width, height } = e.currentTarget.getBoundingClientRect();
      const tool = erasing ? 'eraser' : brushSize >= MARKER_SIZE ? 'marker' : 'pencil';
      touch.current.down(x, y, pressure, e.timeStamp, width, height, tool, brushOpacity);
    }
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
      const x = sample.clientX - rect.left;
      const y = sample.clientY - rect.top;
      const pressure = sample.pressure || 0.5;
      stroke.current.points.push([x, y, pressure]);
      // Every coalesced sample, with its own timestamp: speed comes from these.
      touch.current?.move(x, y, pressure, sample.timeStamp);
    }
    present();
  };

  // A read in flight is deliberately not part of this test. The parent coalesces
  // overlapping reads, so a stroke drawn mid-read still has to register —
  // otherwise the page the user ends on never gets read.
  const canAutoInterpret = () =>
    !!autoInterpret && !interpretDisabled && !!onAutoInterpret;

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    touch.current?.up();
    const finished = stroke.current;
    stroke.current = null;
    if (finished) {
      commit({ kind: 'stroke', stroke: finished });
      // Fold it into the buffer so the next stroke blits instead of replaying.
      const ctx = baseRef.current?.getContext('2d');
      if (ctx) paintStroke(ctx, finished);
      present();
    }
    if (canAutoInterpret() && dirty.current) onAutoInterpret?.();
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

  // The sheet breathes with the music: a halo in the current ink behind the
  // paper, its strength following the live level. Opacity only, so the
  // compositor does the work and the drawing itself is never tinted.
  const glowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const glow = glowRef.current;
    if (!glow) return;
    if (!playing || !getLevels || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      glow.style.opacity = '0';
      return;
    }
    let level = 0;
    let raf = 0;
    const tick = () => {
      const bands = getLevels(4);
      if (bands) {
        const target = bands.reduce((a, b) => a + b, 0) / bands.length;
        level += (target - level) * (target > level ? 0.25 : 0.04);
        // A soft aura, not a wash: past this it tints the whole desk.
        glow.style.opacity = String(Math.min(0.3, level * 0.6));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, getLevels]);

  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3">
      <div className="relative min-h-0 w-full flex-1">
        <div
          ref={glowRef}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-2 rounded-[2.25rem] opacity-0 blur-2xl transition-[background-color] duration-700"
          style={{ backgroundColor: `color-mix(in oklch, ${erasing ? COLORS[1] : color} 60%, white)` }}
        />
        {/* Dimmed a touch in dark mode so the sheet doesn't glare. A CSS filter
            changes only what's shown; the pixels the eyes read stay as drawn. */}
        <div className="relative h-full overflow-hidden rounded-[1.75rem] bg-paper shadow-[0_1px_2px_rgb(0_0_0/0.05),0_24px_60px_-30px_rgb(0_0_0/0.35)] ring-1 ring-black/[0.06] dark:brightness-[0.96]">
          <canvas
            ref={canvasRef}
            className={cn(
              'block h-full w-full touch-none transition-opacity duration-300',
              showStart ? 'cursor-default opacity-40' : 'cursor-crosshair',
            )}
            onPointerDown={showStart ? undefined : down}
            onPointerMove={showStart ? undefined : move}
            onPointerUp={showStart ? undefined : up}
            onPointerLeave={showStart ? undefined : up}
          />
          {/* Kept off the middle of the page, which is where people start drawing. */}
          {!hasInk && !showStart && emptyState && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3 sm:p-4">
              {emptyState}
            </div>
          )}
          {!hasInk && !showStart && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center">
              <div>
                <p className="font-display text-3xl font-semibold tracking-tight text-pencil/25 sm:text-4xl">
                  Draw anything
                </p>
                <p className="mt-2 text-sm text-pencil/40">The paper is listening</p>
              </div>
            </div>
          )}
          {showStart && (
            <div className="on-paper absolute inset-0 flex flex-col items-center justify-center gap-4 bg-paper/60 px-6 text-center">
              <Button
                type="button"
                size="icon"
                aria-label="Start the band"
                title={startTitle ?? 'Start the band'}
                disabled={startDisabled}
                className="size-20 bg-brand text-white shadow-[0_14px_40px_-10px_rgb(124_58_237/0.6)] transition-transform hover:scale-105 [&_svg]:size-8 [&_svg]:fill-current"
                onClick={onStart}
              >
                <Play className="translate-x-0.5" />
              </Button>
              {startTitle && <p className="max-w-xs text-[15px] font-medium text-pencil/70">{startTitle}</p>}
              {startExtras}
            </div>
          )}
        </div>
      </div>

      {!showStart && (
        <div className="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-[1.6rem] bg-glass px-2 py-1.5 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.25)] ring-1 ring-border backdrop-blur-xl">
          <div className="flex flex-wrap justify-center" role="group" aria-label="ink">
            {COLORS.map((c) => {
              const on = !erasing && color === c;
              return (
                <button
                  key={c}
                  type="button"
                  aria-label={`Ink ${c}`}
                  aria-pressed={on}
                  title={c}
                  onClick={() => {
                    setColor(c);
                    setErasing(false);
                  }}
                  className="group grid size-7 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:size-8"
                >
                  <span
                    className={cn(
                      // The inset ring keeps the darkest inks visible on the dark dock.
                      'size-4 rounded-full ring-1 ring-black/10 ring-inset transition-transform duration-200 sm:size-[18px] dark:ring-white/25',
                      on ? 'scale-110' : 'group-hover:scale-110',
                    )}
                    style={{
                      backgroundColor: c,
                      boxShadow: on ? '0 0 0 2px var(--glass), 0 0 0 3.5px var(--foreground)' : undefined,
                    }}
                  />
                </button>
              );
            })}
          </div>

          <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />

          <div className="flex items-center gap-2 px-1 text-muted-foreground">
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
              className="w-20"
              value={[brushSize]}
              min={SIZE_MIN}
              max={SIZE_MAX}
              step={1}
              aria-label="Brush size"
              title={`Brush ${brushSize}px`}
              onValueChange={([v]) => setBrushSize(v)}
            />
          </div>

          <div className="hidden items-center gap-2 px-1 text-muted-foreground sm:flex">
            <span
              className="grid size-5 shrink-0 place-items-center"
              aria-hidden="true"
              title={`opacity ${Math.round(brushOpacity * 100)}%`}
            >
              <Droplet className="size-4" style={{ opacity: 0.35 + brushOpacity * 0.65 }} />
            </span>
            <Slider
              className="w-16"
              value={[brushOpacity * 100]}
              min={OPACITY_MIN * 100}
              max={100}
              step={1}
              aria-label="Brush opacity"
              title={`Opacity ${Math.round(brushOpacity * 100)}%`}
              onValueChange={([v]) => setBrushOpacity(v / 100)}
            />
          </div>

          <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />

          <div className="flex items-center">
            <button
              type="button"
              aria-label="Eraser"
              aria-pressed={erasing}
              title="Eraser"
              onClick={() => setErasing((on) => !on)}
              className={cn(TOOL_CELL, erasing ? TOOL_ON : TOOL_OFF)}
            >
              <Eraser className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Pen sound"
              aria-pressed={paperSound}
              title={paperSound ? 'Pen sound: on' : 'Pen sound: off'}
              onClick={() => setPaperSound((on) => !on)}
              className={cn(TOOL_CELL, paperSound ? TOOL_ON : TOOL_OFF)}
            >
              <AudioLines className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Undo"
              title={`Undo (${MOD}Z)`}
              disabled={!depth.undo}
              onClick={undo}
              className={cn(TOOL_CELL, TOOL_OFF, 'disabled:pointer-events-none disabled:opacity-35')}
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Redo"
              title={`Redo (${MOD}⇧Z)`}
              disabled={!depth.redo}
              onClick={redo}
              className={cn(TOOL_CELL, TOOL_OFF, 'disabled:pointer-events-none disabled:opacity-35')}
            >
              <Redo2 className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Clear the page"
              title="Clear the page"
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
