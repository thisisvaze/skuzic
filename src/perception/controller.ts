/**
 * Perception, put together. Three sources stay distinct and are combined only
 * at the end: the live gesture (from every input, at once), the visible
 * artwork (pixels and strokes, measured in a worker a few times a second while
 * drawing and at every pen-up), and the model's interpretation (SigLIP probes,
 * slower and optional). Each has one job in flight at most, pending work
 * collapses onto the newest page, and nothing read before a clear, undo, redo
 * or erasure lands afterwards.
 *
 * The whole page and a region around the latest change are read alike; the
 * region is plain geometry around where the page changed, so a new colour on
 * an old form is read with that form around it.
 */

import { loadEyes } from '../vision/eyes';
import { GestureReader, type GestureFeatures, type PageInput } from './gesture';
import { targetsOf, type Inputs, type Targets, type Term } from './mapping';
import type { Change, ImageMeasures, Line, Pixels, Rect, StrokeMeasures } from './measure';
import type { MeasureReply, MeasureRequest } from './measure.worker';
import { scoreProbes, type ProbeScore, type ProbeVectors } from './probes';
import { Glide, Lane, quantileOf, type Reading, type Readings } from './state';

/** What perception needs from the page. DrawCanvas's handle is one. */
export interface Page {
  snapshot(maxEdge: number): ImageData | null;
  square(box: Rect | null, edge: number): ImageData | null;
  marks(live?: boolean): Line[];
  size(): { width: number; height: number };
  changed(): Rect | null;
  isEmpty(): boolean;
}

/** The long edge of the page as measured, in px: enough to tell a soft edge from a crisp one. */
const ANALYSIS_EDGE = 512;
/** SigLIP's input size. */
const MODEL_EDGE = 224;
/** The region around a change: the change with a ring of this share of the page's shorter side around it, and never smaller than REGION_MIN of that side. */
const REGION_RING = 0.12;
const REGION_MIN = 0.35;
/** How fast readings of the whole page and of the region settle on a new value (ms). */
const WHOLE_TAU = 1500;
const LOCAL_TAU = 800;
/** Ink shares below which there is too little on the page to describe. */
const MARKS = 0.003;
const MODEL_MARKS = 0.004;
/** The model is an interpretation: it never speaks with full support. */
const MODEL_SUPPORT = 0.8;
/** Measured edge length (analysis px) that fully supports softness and texture. */
const EDGE_EVIDENCE = 400;
/** Embeddings kept by page content, so undo, redo and re-reads of an unchanged region cost nothing. */
const CACHE = 64;
/** A measuring worker silent this long (ms) is replaced. */
const WORKER_PATIENCE = 8000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface ModelReading {
  whole: Record<string, ProbeScore>;
  region: Record<string, ProbeScore> | null;
  device: string;
  cached: number;
}

export interface Snapshot {
  version: number;
  drawing: boolean;
  whole: Readings;
  local: Readings;
  model: Readings;
  inputs: Inputs;
  targets: Targets;
  why: Record<string, Term[]>;
  change: (Change & { version: number }) | null;
  gesture: GestureFeatures;
  region: Rect | null;
  views: { ink?: Pixels; region?: ImageData };
  timing: {
    capture: [p50: number, p95: number];
    measure: [p50: number, p95: number];
    model: [p50: number, p95: number];
  };
  device: string | null;
  modelError: string | null;
  measureError: string | null;
}

/**
 * FNV-1a over every 7th byte of the pixels: same pixels, same key, at a
 * seventh of the cost on the main thread. ponytail: two pages differing only
 * in skipped bytes would share an embedding; hash every byte if that shows up.
 */
function keyOf({ data }: ImageData): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 7) h = Math.imul(h ^ data[i], 0x01000193);
  return (h >>> 0).toString(36) + data.length;
}

export class Perception {
  private version = 0;
  private drawing = false;
  private erasing = false;
  /** The next readings start fresh rather than gliding from a cleared page. */
  private fresh = true;
  private gesture = new GestureReader();
  private readings: { whole: Readings; local: Readings; model: Readings } = { whole: {}, local: {}, model: {} };
  private glides = new Map<string, Glide>();
  private change: Snapshot['change'] = null;
  private region: Rect | null = null;
  private views: Snapshot['views'] = {};
  private captures: number[] = [];
  private device: string | null = null;
  private modelError: string | null = null;
  private measureError: string | null = null;

  /** Started on the first read and replaced if it fails or goes quiet, so a crash costs one reading. */
  private worker: Worker | null = null;
  private replies = new Map<number, { resolve: (r: MeasureReply) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  /** Stroke ids the worker already holds. */
  private sent = new Set<number>();
  private measureLane: Lane<MeasureRequest, MeasureReply>;
  private modelLane: Lane<{ whole: ImageData; region: ImageData | null }, ModelReading>;
  private probes: Promise<ProbeVectors> | null = null;
  private embeddings = new Map<string, Float32Array>();

  /** Whether the model reads at all, and whether the lab wants views. */
  model = true;
  view = false;

  constructor(private page: Page) {
    this.measureLane = new Lane(
      () => this.captureMeasure(),
      (request) => this.measure(request),
      (reply, version) => {
        this.measureError = null;
        this.applyMeasure(reply, version);
      },
      (error) => {
        this.measureError = error.message;
      },
      // At most about four a second, fewer if a read takes longer.
      (median) => Math.min(1000, Math.max(250, 4 * median)),
    );
    this.modelLane = new Lane(
      () => this.captureModel(),
      (input) => this.readModel(input),
      (reading, version) => this.applyModel(reading, version),
      (error) => {
        // The music carries on from the measurements alone.
        this.modelError = error.message;
        for (const r of Object.values(this.readings.model)) r.support = 0;
      },
      (median) => Math.min(3000, Math.max(400, 2.5 * median)),
    );
  }

  /** Every input on the page, as DrawCanvas reports it. */
  input(e: PageInput): void {
    const size = this.page.size();
    switch (e.type) {
      case 'down':
        this.drawing = true;
        this.erasing = e.tool.erasing;
        this.gesture.down(e.x, e.y, e.p, e.t, e.tool, size);
        break;
      case 'move':
        for (const [x, y, p, t] of e.points) this.gesture.move(x, y, p, t);
        break;
      case 'up':
        this.drawing = false;
        this.gesture.up(e.t);
        break;
    }
    this.version++;
    // Taking ink away (erasing, undo, redo or a clear) makes every reading
    // still in flight describe a page that is gone.
    const removes = e.type === 'undo' || e.type === 'redo' || e.type === 'clear' || (e.type === 'up' && this.erasing);
    if (removes) {
      this.measureLane.invalidate(this.version);
      this.modelLane.invalidate(this.version);
    }
    if (e.type === 'clear') {
      this.fresh = true;
      this.readings.local = {};
      this.readings.model = {};
      this.region = null;
      for (const key of [...this.glides.keys()]) if (key.startsWith('local.') || key.includes('model.')) this.glides.delete(key);
    }
    const urgent = e.type !== 'down' && e.type !== 'move';
    this.measureLane.request(urgent);
    if (this.model) this.modelLane.request(urgent);
  }

  /** The inputs to the music as of `t` (performance.now()), each glided and with its support. */
  inputsAt(t: number): Inputs {
    const inputs: Inputs = {};
    const add = (prefix: string, readings: Readings) => {
      for (const [k, r] of Object.entries(readings)) {
        const glide = this.glides.get(prefix + k);
        inputs[prefix + k] = { value: glide ? glide.at(t) : r.value, support: r.support };
      }
    };
    add('', this.readings.whole);
    add('local.', this.readings.local);
    add('', this.readings.model);
    const g = this.gesture.features(t);
    for (const k of ['energy', 'speed', 'jolt', 'turning', 'pressure'] as const) inputs[`gesture.${k}`] = { value: g[k], support: 1 };
    return inputs;
  }

  targetsAt(t: number): { targets: Targets; why: Record<string, Term[]>; inputs: Inputs } {
    const inputs = this.inputsAt(t);
    return { ...targetsOf(inputs), inputs };
  }

  gestureAt(t: number): GestureFeatures {
    return this.gesture.features(t);
  }

  /** Whether every reading has caught up with the page as it is now; a model that failed counts as caught up. */
  settled(): boolean {
    const done = (lane: { inFlight: boolean; pending: boolean; tried: number }) => !lane.inFlight && !lane.pending && lane.tried >= this.version;
    return done(this.measureLane) && (!this.model || this.page.isEmpty() || done(this.modelLane));
  }

  snapshot(t = performance.now()): Snapshot {
    const { targets, why, inputs } = this.targetsAt(t);
    const range = (values: readonly number[]): [number, number] => [quantileOf(values, 0.5), quantileOf(values, 0.95)];
    return {
      version: this.version,
      drawing: this.drawing,
      ...this.readings,
      inputs,
      targets,
      why,
      change: this.change,
      gesture: this.gesture.features(t),
      region: this.region,
      views: this.views,
      timing: {
        capture: range(this.captures),
        measure: range(this.measureLane.durations),
        model: range(this.modelLane.durations),
      },
      device: this.device,
      modelError: this.modelError,
      measureError: this.measureError,
    };
  }

  /** Stops the workers and timers; reading again starts them afresh (StrictMode does exactly that). */
  dispose(): void {
    this.measureLane.dispose();
    this.modelLane.dispose();
    this.retire(new Error('Perception stopped'));
  }

  private measure(request: MeasureRequest): Promise<MeasureReply> {
    if (!this.worker) {
      const worker = new Worker(new URL('./measure.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<MeasureReply & { error?: string }>) => {
        const pending = this.replies.get(data.id);
        this.replies.delete(data.id);
        if (data.error) pending?.reject(new Error(data.error));
        else pending?.resolve(data);
      };
      worker.onerror = (e) => this.retire(new Error(e.message || 'The measuring worker failed'));
      this.worker = worker;
    }
    const worker = this.worker;
    return new Promise<MeasureReply>((resolve, reject) => {
      const timer = setTimeout(() => this.retire(new Error('The measuring worker stopped answering')), WORKER_PATIENCE);
      this.replies.set(request.id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage(request, { transfer: [request.pixels.data.buffer] });
    });
  }

  /** Lets the measuring worker go; the next read starts a new one, sent every stroke again. */
  private retire(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.sent.clear();
    for (const r of this.replies.values()) r.reject(error);
    this.replies.clear();
  }

  /** The region read around the latest change: the change and a ring of the page around it, so it always has context. */
  private regionAround(changed: Rect | null): Rect | null {
    if (!changed) return null;
    const page = this.page.size();
    const short = Math.min(page.width, page.height);
    const ring = REGION_RING * short;
    const side = Math.min(
      Math.max(page.width, page.height),
      Math.max(changed.width + 2 * ring, changed.height + 2 * ring, REGION_MIN * short),
    );
    const cx = changed.x + changed.width / 2;
    const cy = changed.y + changed.height / 2;
    const fit = (c: number, extent: number) => (side >= extent ? (extent - side) / 2 : Math.min(extent - side, Math.max(0, c - side / 2)));
    return { x: fit(cx, page.width), y: fit(cy, page.height), width: side, height: side };
  }

  private captureMeasure(): { version: number; input: MeasureRequest } | null {
    const started = performance.now();
    const pixels = this.page.snapshot(ANALYSIS_EDGE);
    if (!pixels) return null;
    const marks = this.page.marks(this.drawing);
    const live = this.drawing ? (marks.pop() ?? null) : null;
    const lines = marks.filter((m) => !this.sent.has(m.id));
    this.sent = new Set(marks.map((m) => m.id));
    this.region = this.regionAround(this.page.changed());
    this.captures.push(performance.now() - started);
    if (this.captures.length > 40) this.captures.shift();
    return {
      version: this.version,
      input: {
        id: this.nextId++,
        pixels: { data: pixels.data, width: pixels.width, height: pixels.height },
        page: this.page.size(),
        lines,
        keep: [...this.sent],
        live,
        region: this.region,
        view: this.view,
      },
    };
  }

  private applyMeasure(reply: MeasureReply, version: number): void {
    const t = performance.now();
    const whole = this.observed(reply.whole, reply.strokes, version, t);
    const local = reply.region && reply.regionStrokes ? this.observed(reply.region, reply.regionStrokes, version, t) : {};
    this.settle('', whole, WHOLE_TAU, t);
    this.settle('local.', local, LOCAL_TAU, t);
    this.readings.whole = whole;
    this.readings.local = local;
    this.change = { ...reply.change, version };
    if (reply.view) this.views.ink = reply.view;
    this.fresh = false;
  }

  /** Readings from a set of measures, with their support: no marks, nothing to say about them. */
  private observed(m: ImageMeasures, s: StrokeMeasures, version: number, at: number): Readings {
    const marks = clamp01(m.ink / MARKS);
    const edges = marks * clamp01(m.edges / EDGE_EVIDENCE);
    const lines = clamp01(s.length / 0.3);
    const r = (value: number, source: 'image' | 'strokes', support: number): Reading => ({
      value,
      source,
      kind: 'observed',
      support,
      version,
      at,
    });
    return {
      ink: r(m.ink, 'image', 1),
      lightness: r(m.lightness, 'image', marks),
      contrast: r(m.contrast, 'image', marks),
      // An empty page is truly empty: its density and openness are known.
      density: r(m.density, 'image', 1),
      openness: r(m.openness, 'image', 1),
      weight: r(m.weight, 'image', marks),
      texture: r(m.texture, 'image', edges),
      softness: r(m.softness, 'image', edges),
      chroma: r(m.chroma, 'image', marks),
      // -1 cool .. 1 warm, held as 0..1 like everything else.
      warmth: r(0.5 + m.warmth / 2, 'image', marks * clamp01(m.chroma / 0.2)),
      tint: r(0.5 + m.tint / 2, 'image', marks * clamp01(m.chroma / 0.2)),
      x: r(m.x, 'image', marks),
      y: r(m.y, 'image', marks),
      spread: r(m.spread, 'image', marks),
      concentration: r(m.concentration, 'image', marks),
      balance: r(m.balance, 'image', marks),
      curvature: r(s.curvature, 'strokes', lines),
      // Corners against curves needs some turning to judge.
      angularity: r(s.angularity, 'strokes', lines * clamp01(s.turning / Math.PI)),
    };
  }

  /** Glide each reading's value toward its new one; a fresh page jumps there. */
  private settle(prefix: string, readings: Readings, tau: number, t: number): void {
    for (const [k, r] of Object.entries(readings)) {
      const key = prefix + k;
      const glide = this.glides.get(key);
      if (!glide) this.glides.set(key, new Glide(r.value, tau));
      else if (this.fresh) glide.reset(r.value, t);
      else glide.set(r.value, t);
    }
  }

  private captureModel(): { version: number; input: { whole: ImageData; region: ImageData | null } } | null {
    if (!this.model || this.page.isEmpty()) return null;
    const whole = this.page.square(null, MODEL_EDGE);
    if (!whole) return null;
    const region = this.regionAround(this.page.changed());
    return { version: this.version, input: { whole, region: region && this.page.square(region, MODEL_EDGE) } };
  }

  private async readModel({ whole, region }: { whole: ImageData; region: ImageData | null }): Promise<ModelReading> {
    this.probes ??= import('./probe-vectors.json').then((m) => m.default as ProbeVectors);
    const [eyes, probes] = await Promise.all([loadEyes(), this.probes]);
    this.device = eyes.device;
    let cached = 0;
    const read = async (image: ImageData) => {
      const key = keyOf(image);
      const hit = this.embeddings.get(key);
      if (hit) {
        cached++;
        return hit;
      }
      const v = await eyes.read(image);
      this.embeddings.set(key, v);
      if (this.embeddings.size > CACHE) this.embeddings.delete(this.embeddings.keys().next().value!);
      return v;
    };
    if (this.view && region) this.views.region = region;
    const w = await read(whole);
    const r = region ? await read(region) : null;
    return { whole: scoreProbes(w, probes), region: r && scoreProbes(r, probes), device: eyes.device, cached };
  }

  private applyModel(reading: ModelReading, version: number): void {
    const t = performance.now();
    this.modelError = null;
    const support = (ink: number | undefined) => MODEL_SUPPORT * clamp01((ink ?? 0) / MODEL_MARKS);
    const of = (scores: Record<string, ProbeScore>, prefix: string, ink: number | undefined): Readings =>
      Object.fromEntries(
        Object.entries(scores).map(([id, s]) => [
          `${prefix}model.${id}`,
          { value: s.value, raw: s.raw, source: 'model', kind: 'interpreted', support: support(ink), version, at: t } satisfies Reading,
        ]),
      );
    const model = {
      ...of(reading.whole, '', this.readings.whole.ink?.value),
      ...(reading.region ? of(reading.region, 'local.', this.readings.local.ink?.value) : {}),
    };
    this.settle('', model, WHOLE_TAU, t);
    this.readings.model = model;
  }
}
