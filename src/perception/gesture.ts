/**
 * The live gesture: how the hand moves right now, from pointer samples. These
 * drive the immediate, local side of the music, so they are smoothed against
 * pointer jitter, bounded, and fade once the pen lifts. Pure: times are event
 * timestamps in ms, positions page (CSS) px.
 */

/** How a stroke is laid: everything about it but its points. */
export interface StrokeTool {
  medium: 'pencil' | 'watercolor';
  color: string;
  /** Nib size in page px; an eraser's is already widened. */
  size: number;
  /** Opacity the stroke is laid at. */
  alpha: number;
  erasing: boolean;
  /** Width from speed rather than reported pressure (mouse and finger). */
  simulate: boolean;
}

/**
 * Everything the hand does to the page, as it happens: what perception reads
 * live and what the lab records and replays. Times are event timestamps (ms,
 * performance.now()'s clock), positions page px.
 */
export type PageInput =
  | { type: 'down'; t: number; x: number; y: number; p: number; tool: StrokeTool }
  | { type: 'move'; t: number; points: [x: number, y: number, p: number, t: number][] }
  | { type: 'up' | 'undo' | 'redo' | 'clear'; t: number };

export interface GestureFeatures {
  down: boolean;
  /** Pace, 0..1: about two thirds at half the page's diagonal a second. */
  speed: number;
  /** Continuous bending of the path, 0..1. */
  turning: number;
  /** Sharp changes of direction, 0..1: spikes at a corner, gone a moment later. */
  jolt: number;
  /** Stylus pressure, smoothed; a mouse reports a flat 0.5. */
  pressure: number;
  /** The hand's overall liveliness, 0..1, bounded; decays after the pen lifts. */
  energy: number;
  /** Where the pen is, 0..1 across and down the page. */
  x: number;
  y: number;
  tool: StrokeTool | null;
  /** ms since the last movement. */
  idle: number;
}

const SPEED_TAU = 80;
/** Page diagonals per second where speed reaches about two thirds. */
const SPEED_SCALE = 0.5;
/** The heading is re-read every this share of the diagonal, so jitter can't turn it. */
const HEADING_STEP = 0.006;
/** Bending decays with this time constant (ms), and reaches two thirds at this many radians held. */
const TURN_TAU = 300;
const TURN_SCALE = 1.5;
/** A turn this sharp (radians) within one heading step is a corner; a corner's jolt fades with JOLT_TAU. */
const CORNER = 0.7;
const JOLT_TAU = 250;
const PRESSURE_TAU = 120;
/** After the pen lifts, the hand's energy fades with this time constant (ms). */
const RELEASE_TAU = 1200;
/** Energy never goes past this, so even frantic drawing stays pleasant. */
const ENERGY_CAP = 0.85;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toward = (from: number, to: number, dt: number, tau: number) => to + (from - to) * Math.exp(-dt / tau);

export class GestureReader {
  private page = { width: 1, height: 1 };
  private isDown = false;
  private tool: StrokeTool | null = null;
  private last?: { x: number; y: number; t: number };
  private anchor?: { x: number; y: number; heading: number | null };
  private speed = 0;
  private bend = 0;
  private jolt = 0;
  private pressure = 0.5;
  private energy = 0;
  private at = 0;
  private x = 0.5;
  private y = 0.5;
  private moved = -Infinity;

  down(x: number, y: number, pressure: number, t: number, tool: StrokeTool, page: { width: number; height: number }): void {
    this.decay(t);
    this.page = { width: page.width || 1, height: page.height || 1 };
    this.isDown = true;
    this.tool = tool;
    this.last = { x, y, t };
    this.anchor = { x, y, heading: null };
    this.speed = 0;
    this.pressure = pressure;
    this.place(x, y);
    this.moved = t;
  }

  move(x: number, y: number, pressure: number, t: number): void {
    const last = this.last;
    if (!this.isDown || !last) return;
    const dt = t - last.t;
    if (dt <= 0) return;
    this.decay(t);
    const diag = Math.hypot(this.page.width, this.page.height);
    const step = Math.hypot(x - last.x, y - last.y);
    this.speed = toward(this.speed, step / diag / (dt / 1000), dt, SPEED_TAU);
    this.pressure = toward(this.pressure, pressure, dt, PRESSURE_TAU);
    this.last = { x, y, t };
    this.place(x, y);
    this.moved = t;

    const anchor = this.anchor!;
    if (Math.hypot(x - anchor.x, y - anchor.y) >= HEADING_STEP * diag) {
      const heading = Math.atan2(y - anchor.y, x - anchor.x);
      if (anchor.heading !== null) {
        let turn = Math.abs(heading - anchor.heading);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        this.bend += turn;
        if (turn >= CORNER) this.jolt = 1;
      }
      this.anchor = { x, y, heading };
    }
    this.energy = Math.max(this.energy, this.liveliness());
  }

  up(t: number): void {
    this.decay(t);
    this.isDown = false;
    this.last = undefined;
    this.anchor = undefined;
  }

  features(t: number): GestureFeatures {
    this.decay(t);
    return {
      down: this.isDown,
      speed: this.speedNow(),
      turning: clamp01(1 - Math.exp(-this.bend / TURN_SCALE)),
      jolt: this.jolt,
      pressure: this.pressure,
      energy: this.energy,
      x: this.x,
      y: this.y,
      tool: this.tool,
      idle: Math.max(0, t - this.moved),
    };
  }

  private speedNow(): number {
    return clamp01(1 - Math.exp(-this.speed / SPEED_SCALE));
  }

  private liveliness(): number {
    const turning = 1 - Math.exp(-this.bend / TURN_SCALE);
    return Math.min(ENERGY_CAP, 0.6 * this.speedNow() + 0.25 * this.jolt + 0.15 * turning);
  }

  /** Bring every decaying value up to time `t`. */
  private decay(t: number): void {
    const dt = Math.max(0, t - this.at);
    this.at = Math.max(this.at, t);
    if (!dt) return;
    this.bend *= Math.exp(-dt / TURN_TAU);
    this.jolt *= Math.exp(-dt / JOLT_TAU);
    // A pen held still is not drawing quickly, even if no move says so.
    if (!this.isDown || (this.last && t - this.last.t > 2 * SPEED_TAU)) this.speed *= Math.exp(-dt / SPEED_TAU);
    this.energy = this.isDown ? Math.max(this.liveliness(), this.energy * Math.exp(-dt / RELEASE_TAU)) : this.energy * Math.exp(-dt / RELEASE_TAU);
  }

  private place(x: number, y: number): void {
    this.x = clamp01(x / this.page.width);
    this.y = clamp01(y / this.page.height);
  }
}
