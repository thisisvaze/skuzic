/**
 * The pen's side of the sound, made locally so it answers in milliseconds
 * while the Lyria bed answers in seconds.
 *
 * The pen is not an instrument: it plays no notes of its own. It leads the
 * music, the way a dancer leads a partner. Two things happen as you draw:
 *
 * - The paper: a quiet, unpitched friction texture under every stroke, felt
 *   more than heard, whose grain speeds up with the pen. A pencil ticks where
 *   it lands, so even a dot is heard.
 * - The lead: how you move nudges the music's own sound, a little louder,
 *   brighter or wider (see leadOf), and it settles back to the music as the
 *   model made it once you stop. Nothing is added to the music, so there is
 *   nothing new to tire of, and nothing is random: the same movement always
 *   leads the same way.
 *
 * Both are clearest when you start and after a pause, and back off as you
 * settle into drawing, the way a good accompanist does.
 *
 * The paper runs in its own AudioContext, so it plays while the bed is paused,
 * buffering, or not there at all.
 */

import type { Lead } from './engine';

export type PenTool = 'pencil' | 'marker' | 'watercolor' | 'eraser';

/** Pen speed, in CSS px per second, that drives the paper to full level. */
const FULL_SPEED = 1400;

/**
 * The calibration knob for the paper. The bed plays in its own AudioContext at
 * whatever level the model mastered it, so this can only be balanced against
 * it by ear.
 */
const LEVEL = 0.6;
/**
 * Paper sits far under the music: it should be felt, not followed. At 0.13 it
 * was a rasp people noticed over a session; this is about 8 dB under that.
 */
const PAPER = 0.05;

/** A pen that stops moving goes quiet this long after, like a real one. */
const STILL_MS = 60;

/** Attention: where it settles after long drawing, and how fast it goes and comes back. */
const SETTLED = 0.45;
const SETTLE_MS = 90_000;
const RETURN_MS = 10_000;
/** Counts as still drawing if the pen was busy this recently. */
const BUSY_MS = 1500;

const PAPER_TONE: Record<PenTool, { rate: number; lowpass: number; buffer: 'rough' | 'smooth' }> = {
  // Kept dark: the top octave of paper noise is hiss, and hiss is what tires.
  pencil: { rate: 1, lowpass: 4200, buffer: 'rough' },
  marker: { rate: 0.85, lowpass: 2400, buffer: 'smooth' },
  watercolor: { rate: 0.85, lowpass: 2400, buffer: 'smooth' },
  eraser: { rate: 0.55, lowpass: 1300, buffer: 'smooth' },
};

/** The touchdown tick's peak: a few milliseconds long, so it reads as part of the paper. */
const TICK = 0.1;

/** How long the lead takes to follow the hand: the dance, not each stroke or a corner's pause. */
const DANCE_MS = 400;
/** How long a big gesture keeps the music wide once the hand draws smaller. */
const REACH_MS = 1500;
/** A gesture reaching this share of the page's diagonal from where it began leads the music fully wide. */
const REACH_FULL = 0.4;
/** Where pace and reach start after a rest: inside the flat middle of their curves in leadOf, so a first stroke leads from neutral. */
const NEUTRAL = { pace: 0.42, reach: 0.375 };
/** A stylus leaning this many degrees from upright starts to shade, and fully shades at the second. */
const SLANT = [45, 70];
/** The lead goes out at most this often; the music's own glide smooths between. */
const LEAD_MS = 50;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 0 at `from`, 1 at `to`, flat beyond either; `to` may be below `from`. */
const ramp = (v: number, from: number, to: number) => clamp01((v - from) / (to - from));

/** Pressure shapes the level but never mutes it, since a mouse reports a flat 0.5. */
const weight = (pressure: number) => 0.4 + 0.6 * clamp01(pressure);

/** Paper level 0..1 from speed (px/s) and pressure. A still pen is silent. */
export function frictionLevel(speed: number, pressure: number): number {
  return clamp01(speed / FULL_SPEED) ** 0.7 * weight(pressure);
}

/** Attention after `dt` ms: settling toward SETTLED while drawing, back toward 1 at rest. */
export function attend(prev: number, dt: number, drawing: boolean): number {
  return drawing
    ? SETTLED + (prev - SETTLED) * Math.exp(-dt / SETTLE_MS)
    : 1 + (prev - 1) * Math.exp(-dt / RETURN_MS);
}

/** How far a stylus leans over to shade, 0..1, from a PointerEvent's tilt in degrees. Mice and fingers report 0. */
export function slantOf(tiltX: number, tiltY: number): number {
  const tan = (deg: number) => Math.tan((Math.min(89, Math.abs(deg)) * Math.PI) / 180);
  const fromUpright = (Math.atan(Math.hypot(tan(tiltX), tan(tiltY))) * 180) / Math.PI;
  return ramp(fromUpright, SLANT[0], SLANT[1]);
}

/**
 * How the hand leads the music, as offsets from the untouched mix. Every input
 * is 0..1: `pace` from speed, `pressure` as the pen reports it, `reach` from
 * how big the gesture is, `slant` from a stylus leaning over to shade, and
 * `depth` from attention. Ordinary drawing sits in the flat middle of every
 * curve, so it only leans in a touch; a clear change in how you move is what
 * gets heard.
 */
export function leadOf(pace: number, pressure: number, reach: number, slant: number, depth: number): Lead {
  // Quick drawing opens the top end; slow drawing and shading warm it.
  const tone = 0.5 - 2 * ramp(pace, 0.3, 0.15) + 1.5 * ramp(pace, 0.55, 1) - 2 * slant;
  // Small marks draw it close; big sweeps open it wide.
  const width = 1 - 0.12 * ramp(reach, 0.25, 0) + 0.2 * ramp(reach, 0.5, 1);
  return {
    // Drawing at all leans in half a dB; pressing harder swells up to a dB more. A mouse's flat 0.5 never does.
    lift: depth * (0.5 + ramp(pressure, 0.5, 0.9)),
    tone: depth * Math.max(-2.5, tone),
    width: 1 + depth * (width - 1),
  };
}

/**
 * Friction noise roughened by a slowly varying envelope: the grain a nib drags
 * across paper tooth. Played faster, the grain gets denser and brighter, which
 * is what a quicker stroke sounds like.
 */
function paper(ctx: BaseAudioContext, roughness: number): AudioBuffer {
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const k = 1 - Math.exp((-2 * Math.PI * 140) / ctx.sampleRate);
  let tooth = 0;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    tooth += (Math.abs(Math.random() * 2 - 1) - tooth) * k;
    data[i] = tooth;
    sum += tooth;
  }
  const mean = sum / length;
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - roughness + (roughness * data[i]) / mean);
  }
  return buffer;
}

export class TouchEngine {
  private ctx = new AudioContext();
  private out: GainNode;
  private paperBuffers: Record<'rough' | 'smooth', AudioBuffer>;
  private paperLowpass: BiquadFilterNode;
  private paperLevel: GainNode;
  private paperPan: StereoPannerNode;
  private stroke?: { source: AudioBufferSourceNode; fade: GainNode };
  private meter: () => number = () => 0;
  private lead: (lead: Lead) => void = () => {};

  private tool: PenTool = 'pencil';
  private opacity = 1;
  private size = { width: 1, height: 1 };
  private last?: { x: number; y: number; t: number };
  private speed = 0;
  private lastSteer = -Infinity;

  /** The dance: the same hand read over a few hundred ms (see leadOf), and where the stroke began. */
  private pace = NEUTRAL.pace;
  private pressure = 0.5;
  private reach = NEUTRAL.reach;
  private slant = 0;
  private from = { x: 0, y: 0 };
  private lastLead = -Infinity;

  private attention = 1;
  private lastActive = -Infinity;
  private attentionAt = -Infinity;

  constructor() {
    const ctx = this.ctx;
    const out = (this.out = new GainNode(ctx, { gain: LEVEL }));
    out.connect(ctx.destination);

    this.paperBuffers = { rough: paper(ctx, 0.85), smooth: paper(ctx, 0.35) };
    this.paperLevel = new GainNode(ctx, { gain: 0 });
    this.paperLowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7500, Q: 0.5 });
    this.paperPan = new StereoPannerNode(ctx);
    this.paperLowpass
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 700, Q: 0.6 }))
      .connect(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 3200, Q: 0.9, gain: 5 }))
      .connect(this.paperLevel)
      .connect(this.paperPan)
      .connect(out);
  }

  /** The bed's current level, 0..1, so the pen can make room when the music is loud. */
  listen(meter: () => number): void {
    this.meter = meter;
  }

  /** Where the hand's lead goes: the music, which settles back by itself once the calls stop. */
  direct(lead: (lead: Lead) => void): void {
    this.lead = lead;
  }

  /** Pen down, in CSS px from the canvas's top-left, with `t` an event timestamp. */
  down(
    x: number,
    y: number,
    pressure: number,
    t: number,
    width: number,
    height: number,
    tool: PenTool = 'pencil',
    opacity = 1,
    slant = 0,
  ): void {
    // Normally already running, since it was built inside a gesture, but the
    // OS can suspend a context across sleep and only a gesture may resume it.
    this.ctx.resume().catch(() => {});
    this.size = { width: width || 1, height: height || 1 };
    this.last = { x, y, t };
    this.from = { x, y };
    this.speed = 0;
    this.tool = tool;
    this.opacity = opacity;
    // After a rest the hand leads from neutral, not from where the last dance ended.
    if (t - this.lastActive > BUSY_MS) {
      this.pace = NEUTRAL.pace;
      this.reach = NEUTRAL.reach;
    } else {
      this.reach *= Math.exp(-(t - this.lastActive) / REACH_MS);
    }
    this.pressure = pressure;
    this.slant = slant;
    this.settle(t);
    this.startPaper(x);
    if (tool === 'pencil' || tool === 'marker') this.tick(pressure);
  }

  move(x: number, y: number, pressure: number, t: number, slant = 0): void {
    const last = this.last;
    // No stroke under way: a stray move after the pen lifted.
    if (!last) return;
    const dt = t - last.t;
    // Coalesced samples can share a timestamp; their distance counts in the next.
    if (dt <= 0) return;
    const step = Math.hypot(x - last.x, y - last.y);
    // A 240 Hz pen reports jittery per-sample speeds, so smooth over ~40 ms.
    this.speed += ((step / dt) * 1000 - this.speed) * (1 - Math.exp(-dt / 40));
    this.last = { x, y, t };
    this.lastActive = t;

    const follow = 1 - Math.exp(-dt / DANCE_MS);
    this.pace += (clamp01(this.speed / FULL_SPEED) ** 0.7 - this.pace) * follow;
    this.pressure += (pressure - this.pressure) * follow;
    this.slant += (slant - this.slant) * follow;
    const far = Math.hypot(x - this.from.x, y - this.from.y) / Math.hypot(this.size.width, this.size.height);
    this.reach = Math.max(this.reach * Math.exp(-dt / REACH_MS), clamp01(far / REACH_FULL));

    // Pointer events can outpace what the ear needs, and every automation
    // event is work for the audio thread.
    if (t - this.lastSteer < 15) return;
    this.lastSteer = t;

    const now = this.ctx.currentTime;
    const level = this.paperLevel.gain;
    const speed = clamp01(this.speed / FULL_SPEED);
    // Re-arm the fade on every steer: if no movement follows, the pen falls quiet.
    level.cancelScheduledValues(now);
    level.setTargetAtTime(
      PAPER *
        frictionLevel(this.speed, pressure) *
        (0.5 + 0.5 * this.opacity) *
        (0.7 + 0.3 * this.attention) *
        (1 - 0.3 * this.meter()),
      now,
      0.015,
    );
    level.setTargetAtTime(0, now + STILL_MS / 1000, 0.06);
    this.stroke?.source.playbackRate.setTargetAtTime(
      PAPER_TONE[this.tool].rate * (0.7 + 0.6 * speed),
      now,
      0.05,
    );
    this.paperPan.pan.setTargetAtTime(this.panAt(x), now, 0.05);

    // Erasing takes marks away; it doesn't lead.
    if (this.tool !== 'eraser' && t - this.lastLead >= LEAD_MS) {
      this.lastLead = t;
      this.lead(leadOf(this.pace, this.pressure, this.reach, this.slant, 0.5 + 0.5 * this.attention));
    }
  }

  up(): void {
    this.last = undefined;
    const now = this.ctx.currentTime;
    // Let the paper whisper out rather than cut.
    this.paperLevel.gain.cancelScheduledValues(now);
    this.paperLevel.gain.setTargetAtTime(0, now, 0.04);
    if (this.stroke) {
      this.stroke.source.stop(now + 0.3);
      this.stroke = undefined;
    }
  }

  /** The page was cleared: a soft swish. */
  clear(): void {
    if (this.ctx.state === 'closed') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const source = new AudioBufferSourceNode(ctx, { buffer: this.paperBuffers.smooth, playbackRate: 1.4 });
    const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 5200, Q: 0.8 });
    band.frequency.setValueAtTime(5200, now);
    band.frequency.exponentialRampToValueAtTime(700, now + 0.45);
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(0.12, now + 0.08);
    amp.gain.setTargetAtTime(0, now + 0.12, 0.12);
    source.connect(band).connect(amp).connect(this.paperPan);
    source.start(now, Math.random() * 3);
    source.stop(now + 0.9);
  }

  /** Off silences the paper, tick and swish; the hand still leads the music. */
  mute(off: boolean): void {
    this.out.gain.value = off ? 0 : LEVEL;
  }

  close(): void {
    if (this.ctx.state !== 'closed') void this.ctx.close();
  }

  /** Wide, but never hard left or right. */
  private panAt(x: number): number {
    return (clamp01(x / this.size.width) - 0.5) * 1.1;
  }

  private settle(t: number): void {
    if (this.attentionAt > -Infinity) {
      this.attention = attend(this.attention, t - this.attentionAt, t - this.lastActive < BUSY_MS);
    }
    this.attentionAt = t;
    this.lastActive = t;
  }

  private startPaper(x: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.stroke?.source.stop(now + 0.05);
    const tone = PAPER_TONE[this.tool];
    const buffer = this.paperBuffers[tone.buffer];
    const source = new AudioBufferSourceNode(ctx, { buffer, loop: true, playbackRate: tone.rate * 0.7 });
    const fade = new GainNode(ctx, { gain: 0 });
    fade.gain.setValueAtTime(0, now);
    fade.gain.linearRampToValueAtTime(1, now + 0.008);
    source.connect(fade).connect(this.paperLowpass);
    // A different stretch of paper every stroke, so no two strokes rasp alike.
    source.start(now, Math.random() * buffer.duration);
    this.paperLowpass.frequency.setValueAtTime(tone.lowpass, now);
    this.paperPan.pan.setValueAtTime(this.panAt(x), now);
    this.stroke = { source, fade };
  }

  /** Graphite meeting paper: a few milliseconds of grain, panned with the paper. */
  private tick(pressure: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const source = new AudioBufferSourceNode(ctx, { buffer: this.paperBuffers.rough });
    const amp = new GainNode(ctx, { gain: TICK * weight(pressure) * (0.6 + 0.4 * this.attention) });
    amp.gain.setTargetAtTime(0, now + 0.001, 0.004);
    source
      .connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2800, Q: 1.2 }))
      .connect(amp)
      .connect(this.paperPan);
    source.start(now, Math.random() * 3);
    source.stop(now + 0.04);
  }
}
