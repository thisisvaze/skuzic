/**
 * The pen's own sound, made locally so it answers in milliseconds while the
 * Lyria bed answers in seconds, and designed to be lived with for a session.
 *
 * Two layers. The paper: a quiet, unpitched friction texture under every
 * stroke, felt more than heard, whose grain speeds up with the pen. The notes:
 * voice-led into a slow melody in F major pentatonic, which is also D minor
 * pentatonic. Leaving out B♭ and E drops both half steps from the key, so the
 * line stays consonant over whatever chord the bed happens to be on.
 *
 * Each brush has its own voice, and neither is an instrument the bed plays, so
 * the pen never competes with the music:
 * - Pencil plucks: a soft synthesized wooden note, gone in about half a second.
 *   A sharp corner can pluck too, so a zigzag plays and a long smooth line
 *   stays quiet, and every touchdown ticks, so even a dot is heard.
 * - Watercolor swells: no attacks, just a soft two-note chord that rises with
 *   how much paint is flowing and lingers after the brush lifts.
 * - Piano, the earlier voice, kept in Settings to compare: soft notes from a
 *   real grand (public/sounds, built by scripts/make-pen-sounds.py) for every brush.
 *
 * What keeps it pleasant for twenty minutes:
 * - Phrases: a few notes, then a breath, the last one landing on F, A or C so
 *   it sounds finished. A constant stream of notes is what grates.
 * - Attention: notes are clearest when you start and after a pause, and back
 *   off as you settle into drawing, the way a good accompanist does. Settled,
 *   phrases get shorter and breaths longer.
 * - Space: notes keep their distance, hatching gets texture only, and a loud
 *   band ducks the pen.
 * - Variety: the melody moves by steps, and no two notes share a velocity,
 *   timing, detune or pan.
 *
 * It runs in its own AudioContext, so it plays while the bed is paused,
 * buffering, or not there at all.
 *
 * ponytail: the key is fixed to INITIAL_CONFIG.scale (F major / D minor). If the
 * scale picker stays in the Engine menu, transpose NOTES from state.config.scale.
 */

import { KEYS, load } from '../lib/persist';

/** Semitones above F: F G A C D. */
const PENTATONIC = [0, 2, 4, 7, 9];

/** The melody's range as MIDI notes, F4 to F6. */
export const NOTES = Array.from(
  { length: 11 },
  (_, i) => 65 + 12 * Math.floor(i / 5) + PENTATONIC[i % 5],
);
const TOP = NOTES.length - 1;

/** Soft Kawai samples; every note above sits at most a semitone from one. */
const PIANO_ROOTS = [66, 68, 72, 75, 78, 81, 84, 87];
const SOUNDS = `${import.meta.env.BASE_URL}sounds/`;

export type PenTool = 'pencil' | 'marker' | 'watercolor' | 'eraser';
/** A voice for each brush, or the piano for all of them. */
export type PenVoice = 'brushes' | 'piano';

/** The voice picked in Settings, read on every stroke so a change is heard on the next one. */
export const penVoice = (): PenVoice => load<PenVoice>(KEYS.penVoice, 'brushes');

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Pen speed, in CSS px per second, that drives the paper to full level. */
const FULL_SPEED = 1400;

/**
 * The calibration knob for the whole layer. The bed plays in its own
 * AudioContext at whatever level the model mastered it, so this can only be
 * balanced against it by ear.
 */
const LEVEL = 0.6;
/**
 * Paper sits far under the notes: it should be felt, not followed. At 0.13 it
 * was a rasp people noticed over a session; this is about 8 dB under that.
 */
const PAPER = 0.05;
const REVERB = 0.32;

/** A pen that stops moving goes quiet this long after, like a real one. */
const STILL_MS = 60;

/** Attention: where it settles after long drawing, and how fast it goes and comes back. */
const SETTLED = 0.45;
const SETTLE_MS = 90_000;
const RETURN_MS = 10_000;
/** Counts as still drawing if the pen was busy this recently. */
const BUSY_MS = 1500;

/** The shortest gap between notes at full attention; it widens as attention settles. */
const NOTE_GAP_MS = 380;
/** After this long without drawing, the next stroke always starts a fresh phrase. */
const PHRASE_MS = 2000;
/** F, A and C: the notes a phrase comes home to. */
const HOME = [5, 9, 0];

const PAPER_TONE: Record<PenTool, { rate: number; lowpass: number; buffer: 'rough' | 'smooth' }> = {
  // Kept dark: the top octave of paper noise is hiss, and hiss is what tires.
  pencil: { rate: 1, lowpass: 4200, buffer: 'rough' },
  marker: { rate: 0.85, lowpass: 2400, buffer: 'smooth' },
  watercolor: { rate: 0.85, lowpass: 2400, buffer: 'smooth' },
  eraser: { rate: 0.55, lowpass: 1300, buffer: 'smooth' },
};

/**
 * The pencil's pluck: a sine and two overtones, each as ratio to the note,
 * level, and decay relative to the note's. Two octaves up is a marimba bar's
 * woody partial; 6.27 is a kalimba tine's glint, gone almost at once.
 */
const PLUCK = [
  { ratio: 1, level: 1, decay: 1 },
  { ratio: 4, level: 0.16, decay: 0.2 },
  { ratio: 6.27, level: 0.05, decay: 0.08 },
];
/** The pluck's decay time constant at A4, in seconds; higher notes ring shorter. */
const PLUCK_DECAY = 0.2;
/** Matches a soft piano note's A-weighted loudness at the same velocity, measured on the samples. */
const PLUCK_LEVEL = 0.3;
/** The touchdown tick, kept well under the notes. */
const TICK = 0.1;

/** The watercolor chord at full flow, about 2 dB under a typical pencil note. */
const SWELL = 0.08;
/** How slowly a lifted brush's chord fades (a time constant, in seconds), like paint still spreading. */
const SWELL_RELEASE = 0.6;
/** The chord steps along the scale at most this often as the brush travels up or down. */
const SWELL_STEP_MS = 600;

/** Pen travel, in CSS px, over which a direction is measured, so a shaky hand isn't a corner. */
const SEGMENT = 12;
/** A turn sharper than this, in radians (about 70°), is a corner. */
const CORNER = 1.2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Pressure shapes the level but never mutes it, since a mouse reports a flat 0.5. */
const weight = (pressure: number) => 0.4 + 0.6 * clamp01(pressure);

/** Paper level 0..1 from speed (px/s) and pressure. A still pen is silent. */
export function frictionLevel(speed: number, pressure: number): number {
  return clamp01(speed / FULL_SPEED) ** 0.7 * weight(pressure);
}

/**
 * The next melody note: one or two steps from the last, leaning toward `aim`
 * (where on the page the pen is, 0..TOP). Height steers the line instead of
 * picking pitches, so strokes build a tune rather than random notes.
 */
export function nextNote(
  prev: number | null,
  aim: number,
  rand: () => number,
  /** The last note of a phrase: land on F, A or C, a step or less from where it was heading. */
  resolve = false,
): number {
  let next: number;
  if (prev === null) {
    next = Math.round(Math.min(TOP, Math.max(0, aim)));
  } else {
    const lean = aim - prev > 0.75 ? 1 : aim - prev < -0.75 ? -1 : 0;
    // Steps by preference: mostly a neighbour, sometimes a skip, now and then a repeat.
    const steps = lean ? [lean, lean, lean, 2 * lean, 0, -lean] : [1, -1, 1, -1, 2, -2, 0];
    next = prev + steps[Math.floor(rand() * steps.length)];
    next = Math.min(TOP, Math.max(0, next === prev && rand() < 0.5 ? prev + (lean || 1) : next));
  }
  if (!resolve || HOME.includes(NOTES[next] % 12)) return next;
  // Every note in this scale has F, A or C within one step, so this always finds one.
  return [next + 1, next - 1].find((i) => i >= 0 && i <= TOP && HOME.includes(NOTES[i] % 12)) ?? next;
}

/** A phrase's length in notes, and the breath after it: both follow attention. */
export function phrase(attention: number, rand: () => number): { notes: number; breathMs: number } {
  return { notes: 2 + Math.round(3 * attention + rand()), breathMs: 3000 + 6000 * (1 - attention) };
}

/** Attention after `dt` ms: settling toward SETTLED while drawing, back toward 1 at rest. */
export function attend(prev: number, dt: number, drawing: boolean): number {
  return drawing
    ? SETTLED + (prev - SETTLED) * Math.exp(-dt / SETTLE_MS)
    : 1 + (prev - 1) * Math.exp(-dt / RETURN_MS);
}

/** Whether a note may sound now, given the last one and how much attention is left. */
export function mayPlay(now: number, last: number, attention: number): boolean {
  return now - last >= NOTE_GAP_MS / attention;
}

/** Where the pen's current stretch began, the direction of the last one, and how far that one turned. */
export interface Bend {
  x: number;
  y: number;
  dx: number;
  dy: number;
  turned: number;
}

/** A bend that starts at pen down, with no direction yet. */
export const bendAt = (x: number, y: number): Bend => ({ x, y, dx: 0, dy: 0, turned: 0 });

/** The bend once the pen reaches (x, y), and whether that was a corner; null until it has travelled a SEGMENT. */
export function bendTo(b: Bend, x: number, y: number): { bend: Bend; corner: boolean } | null {
  const dx = x - b.x;
  const dy = y - b.y;
  if (Math.hypot(dx, dy) < SEGMENT) return null;
  // Signed, so a wiggle cancels out instead of adding up.
  const turned = b.dx || b.dy ? Math.atan2(b.dx * dy - b.dy * dx, b.dx * dx + b.dy * dy) : 0;
  // A corner usually falls inside a stretch, which splits its turn across two.
  const corner = Math.max(Math.abs(turned), Math.abs(turned + b.turned)) > CORNER;
  return { bend: { x, y, dx, dy, turned: corner ? 0 : turned }, corner };
}

/** The melody note and the scale note two steps below it (above, at the bottom): a third or a fourth. */
const chord = (i: number) => [NOTES[i], NOTES[i >= 2 ? i - 2 : i + 2]];

/** A warm room about two seconds long: decaying noise, low-passed so the tail isn't hissy. */
function room(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.round(ctx.sampleRate * 2.2);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let warm = 0;
    for (let i = 0; i < length; i++) {
      warm += (Math.random() * 2 - 1 - warm) * 0.35;
      data[i] = warm * Math.exp(-i / ctx.sampleRate / 0.3);
    }
  }
  return buffer;
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

interface Sample {
  buffer: AudioBuffer;
  /** Seconds of leading silence to skip; MP3 decoders pad the start. */
  onset: number;
}

let pianoBytes: Promise<Map<number, ArrayBuffer>> | null = null;

/** Starts downloading the piano before anyone draws, so the first stroke can sing. */
export function prefetchPenSounds(): Promise<Map<number, ArrayBuffer>> {
  pianoBytes ??= Promise.all(
    PIANO_ROOTS.map(async (midi): Promise<[number, ArrayBuffer]> => {
      const res = await fetch(`${SOUNDS}piano-${midi}.mp3`);
      if (!res.ok) throw new Error(`piano-${midi}.mp3: ${res.status}`);
      return [midi, await res.arrayBuffer()];
    }),
  ).then((entries) => new Map(entries));
  pianoBytes.catch(() => {
    pianoBytes = null;
  });
  return pianoBytes;
}

export class TouchEngine {
  private ctx = new AudioContext();
  /** Settles once the piano is decoded; notes before then use a soft synthesized bell. */
  readonly ready: Promise<void>;
  private piano = new Map<number, Sample>();
  private notes: GainNode;
  private paperBuffers: Record<'rough' | 'smooth', AudioBuffer>;
  private paperLowpass: BiquadFilterNode;
  private paperLevel: GainNode;
  private paperPan: StereoPannerNode;
  private stroke?: { source: AudioBufferSourceNode; fade: GainNode };
  /** The watercolor chord while the brush is down; `part` 0 is the melody note, 1 the one under it. */
  private swell?: {
    oscs: { osc: OscillatorNode; part: number }[];
    amp: GainNode;
    tone: BiquadFilterNode;
    steppedAt: number;
  };
  private meter: () => number = () => 0;

  private voice: PenVoice = 'brushes';
  private tool: PenTool = 'pencil';
  private opacity = 1;
  private size = { width: 1, height: 1 };
  private start?: { x: number; y: number; t: number };
  private last?: { x: number; y: number; t: number };
  private travel = 0;
  private speed = 0;
  private bend?: Bend;
  private lastSteer = -Infinity;

  private attention = 1;
  private lastActive = -Infinity;
  private attentionAt = -Infinity;
  private melody: number | null = null;
  private lastNote = -Infinity;
  /** Notes left in the current phrase, and when the breath after it ends. */
  private phrase = { left: 0, breathUntil: -Infinity };
  private lastStroke = { end: -Infinity, ms: Infinity };
  private voices: { source: AudioScheduledSourceNode; amp: GainNode }[] = [];

  constructor() {
    const ctx = this.ctx;

    // A burst of notes must never clip. A tanh curve is all but transparent at
    // playing level and tops out at -2.4 dBFS. A DynamicsCompressor would hold
    // the line too, but its 6 ms lookahead delays every pen-down by that much.
    const out = new GainNode(ctx, { gain: LEVEL });
    const curve = Float32Array.from({ length: 1025 }, (_, i) => Math.tanh(i / 512 - 1));
    out.connect(new WaveShaperNode(ctx, { curve })).connect(ctx.destination);

    // Notes bloom in a small warm room; the paper stays dry and close.
    this.notes = new GainNode(ctx);
    this.notes.connect(out);
    this.notes
      .connect(new ConvolverNode(ctx, { buffer: room(ctx) }))
      .connect(new GainNode(ctx, { gain: REVERB }))
      .connect(out);

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

    this.ready = prefetchPenSounds()
      .then((bytes) =>
        Promise.all(
          [...bytes].map(async ([midi, data]) => {
            // A copy, because decoding detaches the buffer and the bytes are shared.
            const buffer = await ctx.decodeAudioData(data.slice(0));
            const samples = buffer.getChannelData(0);
            let first = 0;
            while (first < samples.length && Math.abs(samples[first]) < 0.003) first++;
            this.piano.set(midi, { buffer, onset: Math.max(0, first / ctx.sampleRate - 0.001) });
          }),
        ),
      )
      .then(
        () => undefined,
        () => undefined,
      );
  }

  /** The bed's current level, 0..1, so the pen can make room when the music is loud. */
  listen(meter: () => number): void {
    this.meter = meter;
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
  ): void {
    // Normally already running, since it was built inside a gesture, but the
    // OS can suspend a context across sleep and only a gesture may resume it.
    this.ctx.resume().catch(() => {});
    // A stroke whose up never came (a cancelled pointer) lets its chord go now.
    this.releaseSwell();
    this.voice = penVoice();
    this.size = { width: width || 1, height: height || 1 };
    this.start = this.last = { x, y, t };
    this.travel = 0;
    this.speed = 0;
    this.bend = bendAt(x, y);
    this.tool = tool;
    this.opacity = opacity;
    const restful = t - this.lastActive;
    this.settle(t);
    this.startPaper(x);

    if (tool === 'eraser') return;
    if (this.voice !== 'piano') {
      if (tool === 'watercolor') return this.startSwell(x, y, pressure, t);
      this.tick(pressure);
    }
    // Hatching: a quick stroke right after another quick stroke is texture, not melody.
    const hatching = this.lastStroke.ms < 180 && t - this.lastStroke.end < 250;
    const fresh = restful > PHRASE_MS;
    if (fresh) this.phrase = { left: phrase(this.attention, Math.random).notes, breathUntil: -Infinity };
    if (hatching || !this.roomForNote(t)) return;
    if (!fresh && Math.random() > 0.35 + 0.65 * this.attention) return;
    this.sing(this.aim(y), pressure, t, fresh ? 1 : 0.9);
  }

  move(x: number, y: number, pressure: number, t: number): void {
    const last = this.last;
    // A stroke this engine didn't start: sound switched off mid-stroke.
    if (!last) return;
    const dt = t - last.t;
    // Coalesced samples can share a timestamp; their distance counts in the next.
    if (dt <= 0) return;
    const step = Math.hypot(x - last.x, y - last.y);
    // A 240 Hz pen reports jittery per-sample speeds, so smooth over ~40 ms.
    this.speed += ((step / dt) * 1000 - this.speed) * (1 - Math.exp(-dt / 40));
    this.travel += step;
    this.last = { x, y, t };
    this.lastActive = t;
    if (this.voice !== 'piano' && (this.tool === 'pencil' || this.tool === 'marker')) this.corner(x, y, pressure, t);

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
    if (this.swell) this.steerSwell(y, pressure, t, now);
  }

  up(t = performance.now()): void {
    const start = this.start;
    const last = this.last;
    this.start = this.last = undefined;
    const now = this.ctx.currentTime;
    // Let the paper whisper out rather than cut.
    this.paperLevel.gain.cancelScheduledValues(now);
    this.paperLevel.gain.setTargetAtTime(0, now, 0.04);
    if (this.stroke) {
      this.stroke.source.stop(now + 0.3);
      this.stroke = undefined;
    }
    this.releaseSwell();
    if (!start || !last) return;

    const ms = last.t - start.t;
    this.lastStroke = { end: t, ms };
    this.lastActive = t;
    // A long, deliberate stroke sometimes lands on a note where it ends.
    if (
      this.tool !== 'eraser' &&
      (this.voice === 'piano' || this.tool !== 'watercolor') &&
      this.phrase.left > 0 &&
      ms > 900 &&
      this.travel > 180 &&
      mayPlay(t, this.lastNote, this.attention) &&
      Math.random() < 0.55 * this.attention
    ) {
      this.sing(this.aim(last.y), 0.4, t, 0.75);
    }
  }

  /** The page was cleared: a soft swish, and the next stroke starts a fresh phrase. */
  clear(): void {
    if (this.ctx.state === 'closed') return;
    this.melody = null;
    this.phrase = { left: 0, breathUntil: -Infinity };
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

  close(): void {
    if (this.ctx.state !== 'closed') void this.ctx.close();
  }

  /** Height on the page (0 top) as a place in the melody's range. */
  private aim(y: number): number {
    return (1 - clamp01(y / this.size.height)) * TOP;
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

  /** Whether a note fits now: spaced from the last and not in a breath. Starts the next phrase after a breath. */
  private roomForNote(t: number): boolean {
    if (!mayPlay(t, this.lastNote, this.attention)) return false;
    if (this.phrase.left > 0) return true;
    if (t < this.phrase.breathUntil) return false; // the pen is breathing
    this.phrase.left = phrase(this.attention, Math.random).notes;
    return true;
  }

  /** A sharp change of direction plucks, inside the same phrases as everything else. */
  private corner(x: number, y: number, pressure: number, t: number): void {
    const next = this.bend && bendTo(this.bend, x, y);
    if (!next) return;
    this.bend = next.bend;
    if (next.corner && this.roomForNote(t) && Math.random() < 0.35 + 0.65 * this.attention) {
      this.sing(this.aim(y), pressure, t, 0.8);
    }
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

  /** Watercolor: a soft chord blooms where the brush lands, then follows the paint. */
  private startSwell(x: number, y: number, pressure: number, t: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.melody = nextNote(this.melody, this.aim(y), Math.random);
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 700, Q: 0.7 });
    const amp = new GainNode(ctx, { gain: 0 });
    tone.connect(amp).connect(new StereoPannerNode(ctx, { pan: this.panAt(x) })).connect(this.notes);
    // Two slightly detuned triangles a note beat slowly, like colour that isn't quite even.
    const oscs = chord(this.melody).flatMap((midi, part) => {
      const level = new GainNode(ctx, { gain: part ? 0.35 : 0.5 });
      level.connect(tone);
      return [-6, 6].map((detune) => {
        const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: hz(midi), detune });
        osc.connect(level);
        osc.start(now);
        return { osc, part };
      });
    });
    amp.gain.setTargetAtTime(SWELL * 0.4 * weight(pressure) * (0.5 + 0.5 * this.opacity), now, 0.03);
    amp.gain.setTargetAtTime(0, now + 0.15, SWELL_RELEASE);
    this.swell = { oscs, amp, tone, steppedAt: t };
  }

  /** Paint flow (speed and pressure) swells the chord and opens it up; a still brush lets it fade. */
  private steerSwell(y: number, pressure: number, t: number, now: number): void {
    const swell = this.swell!;
    const flow = frictionLevel(this.speed, pressure);
    const level = swell.amp.gain;
    level.cancelScheduledValues(now);
    level.setTargetAtTime(
      SWELL *
        (0.25 + 0.75 * flow) *
        (0.5 + 0.5 * this.opacity) *
        (0.7 + 0.3 * this.attention) *
        (1 - 0.35 * this.meter()),
      now,
      0.15,
    );
    level.setTargetAtTime(0, now + 0.12, SWELL_RELEASE);
    swell.tone.frequency.setTargetAtTime(600 + 2600 * flow, now, 0.1);
    // Up or down the page, the chord walks the scale a step at a time.
    const aim = this.aim(y);
    if (this.melody !== null && Math.abs(aim - this.melody) >= 1.5 && t - swell.steppedAt > SWELL_STEP_MS) {
      this.melody = nextNote(this.melody, aim, Math.random);
      swell.steppedAt = t;
      const notes = chord(this.melody);
      for (const { osc, part } of swell.oscs) osc.frequency.setTargetAtTime(hz(notes[part]), now, 0.06);
    }
  }

  /** The lifted brush's chord fades like paint still spreading, then stops. */
  private releaseSwell(): void {
    const swell = this.swell;
    if (!swell) return;
    this.swell = undefined;
    const now = this.ctx.currentTime;
    swell.amp.gain.cancelScheduledValues(now);
    swell.amp.gain.setTargetAtTime(0, now, SWELL_RELEASE);
    for (const { osc } of swell.oscs) osc.stop(now + SWELL_RELEASE * 7);
    this.keep(swell.oscs[0].osc, swell.amp);
  }

  /** One melody note, sometimes with a softer third below it, rolled like a hand. */
  private sing(aim: number, pressure: number, t: number, accent: number): void {
    this.phrase.left--;
    const last = this.phrase.left <= 0;
    this.melody = nextNote(this.melody, aim, Math.random, last);
    if (last) this.phrase.breathUntil = t + phrase(this.attention, Math.random).breathMs;
    this.lastNote = t;
    const velocity =
      (0.45 + 0.35 * clamp01(pressure)) *
      (0.6 + 0.4 * this.attention) *
      (1 - 0.35 * this.meter()) *
      accent *
      (0.9 + Math.random() * 0.2);
    const now = this.ctx.currentTime;
    // A few milliseconds of human looseness; never early, so it stays responsive.
    const when = now + Math.random() * 0.012;
    const pan = this.panAt(this.last?.x ?? this.size.width / 2);
    this.play(NOTES[this.melody], velocity, when, pan);
    if (this.melody >= 2 && this.attention > 0.6 && Math.random() < 0.18) {
      this.play(NOTES[this.melody - 2], velocity * 0.55, when + 0.025 + Math.random() * 0.02, pan);
    }
  }

  private play(midi: number, velocity: number, when: number, pan: number): void {
    const ctx = this.ctx;
    // Softer notes are darker, the way felt and a light touch sound.
    const tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1500 + 3500 * velocity, Q: 0.4 });
    const amp = new GainNode(ctx, { gain: velocity });
    tone.connect(amp).connect(new StereoPannerNode(ctx, { pan })).connect(this.notes);
    const cents = (Math.random() - 0.5) * 8;
    if (this.voice !== 'piano') return this.keep(this.pluck(midi, cents, when, tone), amp);

    const root = PIANO_ROOTS.reduce((a, b) => (Math.abs(b - midi) < Math.abs(a - midi) ? b : a));
    const sample = this.piano.get(root);
    let source: AudioBufferSourceNode | OscillatorNode;
    if (sample) {
      source = new AudioBufferSourceNode(ctx, {
        buffer: sample.buffer,
        playbackRate: 2 ** ((midi - root + cents / 100) / 12),
      });
      source.connect(tone);
      source.start(when, sample.onset);
    } else {
      // Until the piano arrives: a soft sine bell with a quick fade.
      source = new OscillatorNode(ctx, { frequency: hz(midi) });
      const bell = new GainNode(ctx, { gain: 0 });
      bell.gain.setValueAtTime(0, when);
      bell.gain.linearRampToValueAtTime(0.5, when + 0.006);
      bell.gain.setTargetAtTime(0, when + 0.006, 0.35);
      source.connect(bell).connect(tone);
      source.start(when);
      source.stop(when + 2.5);
    }
    this.keep(source, amp);
  }

  /** The pencil's soft wooden pluck, built from PLUCK; returns the fundamental, which rings longest. */
  private pluck(midi: number, cents: number, when: number, out: AudioNode): OscillatorNode {
    const ctx = this.ctx;
    const f = hz(midi);
    const decay = PLUCK_DECAY * Math.sqrt(440 / f);
    const [fundamental] = PLUCK.filter((p) => p.ratio * f < 12_000).map((p) => {
      const osc = new OscillatorNode(ctx, { frequency: f * p.ratio, detune: cents });
      const env = new GainNode(ctx, { gain: 0 });
      // Two milliseconds of attack: a soft mallet, not a click.
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(PLUCK_LEVEL * p.level, when + 0.002);
      env.gain.setTargetAtTime(0, when + 0.002, decay * p.decay);
      osc.connect(env).connect(out);
      osc.start(when);
      osc.stop(when + 0.002 + 7 * decay * p.decay);
      return osc;
    });
    return fundamental;
  }

  /** Eight voices is plenty for a pen; the oldest bows out quickly when a ninth arrives. */
  private keep(source: AudioScheduledSourceNode, amp: GainNode): void {
    const ctx = this.ctx;
    this.voices.push({ source, amp });
    source.onended = () => {
      this.voices = this.voices.filter((v) => v.source !== source);
    };
    if (this.voices.length > 8) {
      const oldest = this.voices.shift()!;
      oldest.amp.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      oldest.source.stop(ctx.currentTime + 0.2);
    }
  }
}
