/**
 * The audible prototype: one small sound palette played straight from the
 * musical targets, so the mapping can be heard and tuned without waiting
 * seconds for a streamed model. Soft FM keys carry a melody, a pad and a bass
 * join as the page fills, all in F major at 90 bpm, Lyria's own key and tempo.
 *
 * Two speeds, as the drawing has two: the hand's gesture swells and brightens
 * the sound the moment it moves (no notes are triggered by the pen), while
 * what the page looks like reshapes the music over notes and bars. The clock
 * never restarts on its own; a cleared page fades the music out, and the next
 * mark brings it back on the next beat. Note choices come from the bar and
 * step they fall on, so a replay that restarts the clock plays the same notes.
 */

import type { GestureFeatures } from './gesture';
import type { Targets } from './mapping';

export const BPM = 90;
const STEP = 60 / BPM / 2;
const STEPS = 8;
/** Bars of a phrase; the music breathes at the end of each. */
const PHRASE = 2;
const LOOKAHEAD = 0.15;
const TICK_MS = 25;

/** F major: the chords, a bar each, with the note each adds under tension. */
const CHORDS = [
  { tones: [65, 69, 72], add: 67 },
  { tones: [62, 65, 69], add: 72 },
  { tones: [58, 62, 65], add: 69 },
  { tones: [60, 64, 67], add: 62 },
];
const SCALE = [0, 2, 4, 5, 7, 9, 10].map((pc) => (pc + 5) % 12);
const inScale = (midi: number) => SCALE.includes(((midi % 12) + 12) % 12);
/** Every F-major note in the playable range, low to high. */
const NOTES = Array.from({ length: 61 }, (_, i) => 36 + i).filter(inScale);

/** Never more onsets than this in a bar, and never more notes sounding than VOICES. */
const MAX_ONSETS = 6;
const VOICES = 10;
const LEVEL = 0.5;
/** The page's presence fades in over about a second and out over about three. */
const PRESENCE_IN = 0.35;
const PRESENCE_OUT = 1;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** A stable number in [0, 1) for (a, b), so the same bar always plays the same choices. */
function chance(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** k onsets spread as evenly as they go over n steps, turned by `rotate`. */
export function euclid(k: number, n: number, rotate = 0): boolean[] {
  return Array.from({ length: n }, (_, i) => (((i + rotate) * k) % n) < k);
}

/** The bar's onsets for these targets: fuller and livelier is busier, punctuated is off the beat, smooth breathes at the phrase's end. */
export function rhythmOf(targets: Targets, bar: number): boolean[] {
  const busy = 0.65 * targets.fullness + 0.35 * targets.energy;
  const k = Math.max(1, Math.min(MAX_ONSETS, Math.round(1 + 5 * busy)));
  const rotate = targets.phrasing > 0.55 ? (bar % 2 ? 3 : 1) : 0;
  const steps = euclid(k, STEPS, rotate);
  if (bar % PHRASE === PHRASE - 1 && targets.phrasing < 0.6) steps[6] = steps[7] = false;
  return steps;
}

function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Darkened noise under an exponential tail: a soft room, not a metallic one.
      low += ((chance(ch, i) * 2 - 1) - low) * 0.35;
      data[i] = low * Math.exp(-5 * t) * (1 - t);
    }
  }
  return buffer;
}

export class PerceptionVoice {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  /** ms from an input event to the sound changing on the audio clock, newest last. */
  readonly latencies: number[] = [];
  /** Onsets scheduled, newest last, as audio-clock seconds: for the long-session check. */
  readonly onsets: number[] = [];
  /** Output level in dBFS every quarter second, newest last: for the long-session check. */
  readonly levels: number[] = [];
  private meter: AnalyserNode;
  private wave = new Float32Array(2048);
  private lastLevel = 0;

  private melodyBus: GainNode;
  private melodyTone: BiquadFilterNode;
  private padBus: GainNode;
  private padTone: BiquadFilterNode;
  private bassBus: GainNode;
  private wet: GainNode;
  private presence: GainNode;
  private expression: GainNode;
  private timer: ReturnType<typeof setInterval> | undefined;
  private origin: number;
  private nextStep = 0;
  private last = 69;
  private sounding: { stop: (at: number) => void; end: number }[] = [];
  private present = false;
  private lastTargets: Targets | null = null;
  private brightness = 0.5;

  constructor(
    private targetsAt: (t: number) => Targets,
    private gestureAt: (t: number) => GestureFeatures,
  ) {
    const ctx = this.ctx;
    const out = new GainNode(ctx, { gain: LEVEL });
    out.connect(ctx.destination);
    this.meter = new AnalyserNode(ctx, { fftSize: 2048 });
    out.connect(this.meter);
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -14, knee: 8, ratio: 4, attack: 0.008, release: 0.3 });
    this.expression = new GainNode(ctx, { gain: 1 });
    this.presence = new GainNode(ctx, { gain: 0 });
    limiter.connect(this.presence).connect(this.expression).connect(out);

    const sum = new GainNode(ctx);
    const room = new ConvolverNode(ctx, { buffer: impulse(ctx, 2.6) });
    this.wet = new GainNode(ctx, { gain: 0.25 });
    sum.connect(limiter);
    sum.connect(room).connect(this.wet).connect(limiter);

    this.melodyTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3000, Q: 0.4 });
    this.melodyBus = new GainNode(ctx, { gain: 1 });
    this.melodyBus.connect(this.melodyTone).connect(sum);
    this.padTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1400, Q: 0.3 });
    this.padBus = new GainNode(ctx, { gain: 0 });
    this.padBus.connect(this.padTone).connect(sum);
    this.bassBus = new GainNode(ctx, { gain: 0 });
    this.bassBus.connect(sum);

    this.origin = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Call inside a gesture: browsers start audio only after one. */
  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Back to bar one, as a replay starts, so the same drawing plays the same notes. */
  restart(): void {
    this.origin = this.ctx.currentTime + 0.1;
    this.nextStep = 0;
    this.last = 69;
  }

  /**
   * The hand moved: lean the sound now, on the audio clock, without waiting
   * for the next note. `eventTime` is the input's timestamp, for the latency
   * record.
   */
  express(eventTime: number): void {
    const now = this.ctx.currentTime;
    const g = this.gestureAt(performance.now());
    this.applyExpression(g, now);
    if (eventTime > 0) {
      this.latencies.push(performance.now() - eventTime);
      if (this.latencies.length > 200) this.latencies.shift();
    }
  }

  close(): void {
    clearInterval(this.timer);
    void this.ctx.close();
  }

  private applyExpression(g: GestureFeatures, now: number): void {
    // A livelier hand swells the music up to about 3 dB and opens its top end
    // by up to an octave; both settle back as the energy decays.
    this.expression.gain.setTargetAtTime(1 + 0.4 * g.energy, now, 0.06);
    const cutoff = lerp(900, 5400, this.brightness) * (1 + 0.9 * g.speed);
    this.melodyTone.frequency.setTargetAtTime(Math.min(12000, cutoff), now, 0.06);
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const t = performance.now();
    const targets = this.targetsAt(t);
    this.lastTargets = targets;
    this.brightness = 0.55 * targets.register + 0.45 * targets.articulation;

    // Presence: in on the next beat, out slowly, so a cleared page lets the music go.
    const present = targets.presence > 0.5;
    if (present !== this.present) {
      this.present = present;
      const at = present ? this.origin + Math.ceil((now - this.origin) / (2 * STEP)) * 2 * STEP : now;
      this.presence.gain.setTargetAtTime(present ? 1 : 0, Math.max(now, at), present ? PRESENCE_IN : PRESENCE_OUT);
    }
    this.applyExpression(this.gestureAt(t), now);
    this.padTone.frequency.setTargetAtTime(lerp(700, 2600, this.brightness), now, 0.3);
    this.wet.gain.setTargetAtTime(lerp(0.12, 0.55, targets.space), now, 0.5);

    // Catch up after a stall rather than playing every missed note at once.
    const behind = Math.floor((now - this.origin) / STEP);
    if (this.nextStep < behind) this.nextStep = behind;
    while (this.origin + this.nextStep * STEP < now + LOOKAHEAD) {
      const step = this.nextStep++;
      const when = Math.max(now, this.origin + step * STEP);
      if (this.present || targets.presence > 0) this.playStep(step, when, targets);
    }
    this.sounding = this.sounding.filter((n) => n.end > now);

    if (now - this.lastLevel >= 0.25) {
      this.lastLevel = now;
      this.meter.getFloatTimeDomainData(this.wave);
      let sum = 0;
      for (const v of this.wave) sum += v * v;
      this.levels.push(10 * Math.log10(sum / this.wave.length + 1e-12));
      if (this.levels.length > 4000) this.levels.shift();
    }
  }

  private playStep(step: number, when: number, targets: Targets): void {
    const bar = Math.floor(step / STEPS);
    const inBar = step % STEPS;
    const chord = CHORDS[bar % CHORDS.length];

    if (inBar === 0) {
      // Layers come in and go out with the page's fullness, over a bar.
      this.padBus.gain.setTargetAtTime(0.11 * smooth(0.3, 0.65, targets.fullness), when, 0.9);
      this.bassBus.gain.setTargetAtTime(0.16 * smooth(0.5, 0.8, targets.fullness), when, 0.9);
      this.pad(chord.tones.concat(targets.tension > 0.35 ? [chord.add] : []), when, STEPS * STEP, targets);
      this.bass(chord.tones[0], when, STEPS * STEP);
    }

    const rhythm = rhythmOf(targets, bar);
    if (!rhythm[inBar]) return;
    let gap = 1;
    while (inBar + gap < STEPS && !rhythm[inBar + gap]) gap++;
    const legato = lerp(1.15, 0.35, targets.phrasing);
    const strong = inBar % 4 === 0;
    const midi = this.pick(chord.tones, chord.add, strong, step, targets);
    const velocity = Math.min(0.55, 0.22 + 0.18 * targets.energy + (strong ? 0.06 : 0) + (targets.phrasing > 0.55 && !strong ? 0.05 : 0));
    this.key(midi, when, gap * STEP * legato, velocity, targets);
    this.onsets.push(when);
    if (this.onsets.length > 2000) this.onsets.shift();
  }

  /** The next melody note: chord tones on strong beats, steps or leaps between, kept near the register. */
  private pick(tones: number[], add: number, strong: boolean, step: number, targets: Targets): number {
    const center = Math.round(lerp(57, 79, targets.register));
    const r = chance(step, 7);
    let midi: number;
    if (strong) {
      const pool = targets.tension > 0.5 && r < 0.3 ? [...tones, add] : tones;
      // Each chord tone in every octave near the centre; the closest to the last note.
      const options = pool.flatMap((n) => [n - 24, n - 12, n, n + 12, n + 24]).filter((n) => Math.abs(n - center) <= 9);
      midi = options.reduce((a, b) => (Math.abs(b - this.last) < Math.abs(a - this.last) ? b : a), options[0] ?? center);
    } else {
      const leap = targets.phrasing > 0.5 && r < 0.25 + 0.4 * (targets.phrasing - 0.5);
      const size = leap ? 3 + Math.floor(chance(step, 11) * 3) : 1 + (r < 0.3 ? 1 : 0);
      // Head back toward the centre when far from it; otherwise rise early in the phrase and fall late.
      const phraseStep = step % (STEPS * PHRASE);
      const up = Math.abs(this.last - center) > 6 ? this.last < center : (phraseStep < STEPS) !== chance(step, 13) < 0.3;
      const i = NOTES.findIndex((n) => n >= this.last);
      midi = NOTES[Math.min(NOTES.length - 1, Math.max(0, (i < 0 ? NOTES.length - 1 : i) + (up ? size : -size)))];
      midi = Math.min(center + 9, Math.max(center - 9, midi));
      if (!inScale(midi)) midi -= 1;
    }
    this.last = midi;
    return midi;
  }

  /** A soft FM key: a sine carrier and a tine an octave up, brighter at the attack the more articulated the page. */
  private key(midi: number, when: number, length: number, velocity: number, targets: Targets): void {
    const ctx = this.ctx;
    this.makeRoom(when);
    const f = hz(midi);
    const carrier = new OscillatorNode(ctx, { frequency: f });
    const tine = new OscillatorNode(ctx, { frequency: 2 * f });
    const depth = new GainNode(ctx, { gain: 0 });
    const index = lerp(0.6, 2.6, targets.articulation) * 2 * f;
    depth.gain.setValueAtTime(index, when);
    depth.gain.setTargetAtTime(index * 0.12, when + 0.004, lerp(0.35, 0.07, targets.articulation));
    tine.connect(depth).connect(carrier.frequency);

    const amp = new GainNode(ctx, { gain: 0 });
    const attack = lerp(0.05, 0.004, targets.articulation);
    const ring = lerp(1.8, 0.45, targets.phrasing);
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(velocity, when + attack);
    amp.gain.setTargetAtTime(0, when + attack, ring);
    amp.gain.setTargetAtTime(0, when + Math.max(attack, length), 0.12);
    const pan = new StereoPannerNode(ctx, { pan: Math.max(-0.7, Math.min(0.7, targets.pan + (chance(midi, when * 8) - 0.5) * 0.2)) });
    carrier.connect(amp).connect(pan).connect(this.melodyBus);
    const end = when + Math.max(attack, length) + 0.8;
    carrier.start(when);
    tine.start(when);
    carrier.stop(end);
    tine.stop(end);
    this.sounding.push({ end, stop: (at) => amp.gain.setTargetAtTime(0, at, 0.03) });
  }

  /** A warm chord held for the bar, fading into the next. */
  private pad(tones: number[], when: number, length: number, targets: Targets): void {
    const ctx = this.ctx;
    const center = Math.round(lerp(55, 67, targets.register));
    for (const tone of tones) {
      let midi = tone;
      while (midi > center + 6) midi -= 12;
      while (midi < center - 6) midi += 12;
      const amp = new GainNode(ctx, { gain: 0 });
      amp.gain.setValueAtTime(0, when);
      amp.gain.setTargetAtTime(0.5 / tones.length, when, 0.35);
      amp.gain.setTargetAtTime(0, when + length, 0.5);
      amp.connect(this.padBus);
      for (const cents of [-6, 6]) {
        const osc = new OscillatorNode(ctx, { type: 'triangle', frequency: hz(midi), detune: cents });
        osc.connect(amp);
        osc.start(when);
        osc.stop(when + length + 2.5);
      }
    }
  }

  private bass(root: number, when: number, length: number): void {
    const ctx = this.ctx;
    let midi = root;
    while (midi > 48) midi -= 12;
    const amp = new GainNode(ctx, { gain: 0 });
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(1, when + 0.02);
    amp.gain.setTargetAtTime(0.45, when + 0.02, 0.5);
    amp.gain.setTargetAtTime(0, when + length * 0.9, 0.2);
    amp.connect(this.bassBus);
    const osc = new OscillatorNode(ctx, { frequency: hz(midi) });
    osc.connect(amp);
    osc.start(when);
    osc.stop(when + length + 1);
  }

  /** Keep the sounding notes bounded: the oldest bows out first. */
  private makeRoom(at: number): void {
    while (this.sounding.length >= VOICES) this.sounding.shift()!.stop(at);
  }

  get targets(): Targets | null {
    return this.lastTargets;
  }
}
