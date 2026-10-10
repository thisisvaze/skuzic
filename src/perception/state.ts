/**
 * Perception over time: every reading carries where it came from, how much
 * evidence stands behind it and which version of the page it describes, and
 * readings of an older page never land on a newer one.
 */

export type Source = 'image' | 'strokes' | 'gesture' | 'model';

export interface Reading {
  value: number;
  source: Source;
  /** An observation (coverage) or an interpretation (restless). */
  kind: 'observed' | 'interpreted';
  /** 0..1: how much evidence stands behind the value. 0 means use the neutral value. */
  support: number;
  /** The page version it was read from. */
  version: number;
  /** performance.now() when it was read. */
  at: number;
  /** A model probe's uncalibrated score. */
  raw?: number;
}

export type Readings = Record<string, Reading>;

/** A reading's value with its weak evidence pulled toward `neutral`. */
export const supported = (r: Reading | undefined, neutral = 0.5) =>
  r ? neutral + (r.value - neutral) * Math.min(1, Math.max(0, r.support)) : neutral;

/**
 * A value that glides to each new target with time constant `tau` (ms),
 * computed when asked rather than ticked, so it costs nothing at rest.
 */
export class Glide {
  private from: number;
  private to: number;
  private t0 = 0;

  constructor(
    value: number,
    private tau: number,
  ) {
    this.from = this.to = value;
  }

  at(t: number): number {
    return this.to + (this.from - this.to) * Math.exp(-Math.max(0, t - this.t0) / this.tau);
  }

  set(target: number, t: number): void {
    this.from = this.at(t);
    this.to = target;
    this.t0 = t;
  }

  /** Jump there now: a cleared page has nothing to glide from. */
  reset(value: number, t: number): void {
    this.from = this.to = value;
    this.t0 = t;
  }

  get target(): number {
    return this.to;
  }
}

/**
 * One kind of perception job (measuring, or the model): at most one in
 * flight, and requests that arrive meanwhile collapse into one more run that
 * captures the page as it is when it starts. A result lands only if it is
 * newer than the last one that landed and no clear, undo, redo or erasure
 * happened after its page was captured.
 */
export class Lane<In, Out> {
  private busy = false;
  private wanted = false;
  private urgent = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private applied = -1;
  private finished = -1;
  private floor = 0;
  private lastStart = -Infinity;
  /** Recent run times in ms, newest last. */
  readonly durations: number[] = [];

  constructor(
    private capture: () => { version: number; input: In } | null,
    private run: (input: In) => Promise<Out>,
    private apply: (out: Out, version: number) => void,
    private fail: (error: Error) => void = () => {},
    /** The least time between starts, from how long runs take: `gap(median ms)`. */
    private gap: (median: number) => number = () => 0,
    private now: () => number = () => performance.now(),
  ) {}

  /** Read the page soon. Urgent requests (a finished stroke) skip the spacing; a run in flight still finishes first. */
  request(urgent = false): void {
    this.wanted = true;
    this.urgent ||= urgent;
    void this.pump();
  }

  /** Nothing captured before `version` may land any more. */
  invalidate(version: number): void {
    this.floor = Math.max(this.floor, version);
  }

  /** Median of recent run times, or 0 before the first. */
  get median(): number {
    return quantileOf(this.durations, 0.5);
  }

  get inFlight(): boolean {
    return this.busy;
  }

  /** The newest version whose result landed. */
  get landed(): number {
    return this.applied;
  }

  /** The newest version a run finished for, whether it landed, was dropped or failed. */
  get tried(): number {
    return this.finished;
  }

  /** Whether a run is waiting to start. */
  get pending(): boolean {
    return this.wanted || this.timer !== undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.wanted = false;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const wait = this.urgent ? 0 : this.lastStart + this.gap(this.median) - this.now();
    if (wait > 0) {
      if (this.timer === undefined) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.pump();
        }, wait);
      }
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.wanted) return;
    this.wanted = false;
    this.urgent = false;
    const job = this.capture();
    if (!job) return;
    this.busy = true;
    this.lastStart = this.now();
    try {
      const out = await this.run(job.input);
      this.durations.push(this.now() - this.lastStart);
      if (this.durations.length > 40) this.durations.shift();
      if (job.version > this.applied && job.version >= this.floor) {
        this.applied = job.version;
        this.apply(out, job.version);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.busy = false;
      this.finished = Math.max(this.finished, job.version);
    }
    if (this.wanted) void this.pump();
  }
}

/** p-th quantile (0..1) of a list of numbers, or 0 when it is empty. */
export function quantileOf(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
