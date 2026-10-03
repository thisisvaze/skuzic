/**
 * The pen's own sound, made locally so it answers in milliseconds while the
 * Lyria bed answers in seconds, and designed to be lived with for a session.
 *
 * Two layers. The paper: a quiet, unpitched friction texture under every
 * stroke, felt more than heard, whose grain speeds up with the pen. The piano:
 * soft notes from a real grand (public/sounds, built by
 * scripts/make-pen-sounds.py), played sparingly and voice-led into a slow
 * melody in F major pentatonic, which is also D minor pentatonic. Leaving out
 * B♭ and E drops both half steps from the key, so the line stays consonant over
 * whatever chord the bed happens to be on.
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

export type PenTool = 'pencil' | 'marker' | 'eraser';

/** Pen speed, in CSS px per second, that drives the paper to full level. */
const FULL_SPEED = 1400;

/**
 * The calibration knob for the whole layer. The bed plays in its own
 * AudioContext at whatever level the model mastered it, so this can only be
 * balanced against it by ear.
 */
const LEVEL = 0.6;
/** Paper sits far under the notes: it should be felt, not followed. */
const PAPER = 0.13;
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
  pencil: { rate: 1, lowpass: 7500, buffer: 'rough' },
  marker: { rate: 0.85, lowpass: 3200, buffer: 'smooth' },
  eraser: { rate: 0.55, lowpass: 1600, buffer: 'smooth' },
};

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
  private meter: () => number = () => 0;

  private tool: PenTool = 'pencil';
  private opacity = 1;
  private size = { width: 1, height: 1 };
  private start?: { x: number; y: number; t: number };
  private last?: { x: number; y: number; t: number };
  private travel = 0;
  private speed = 0;
  private lastSteer = -Infinity;

  private attention = 1;
  private lastActive = -Infinity;
  private attentionAt = -Infinity;
  private melody: number | null = null;
  private lastNote = -Infinity;
  /** Notes left in the current phrase, and when the breath after it ends. */
  private phrase = { left: 0, breathUntil: -Infinity };
  private lastStroke = { end: -Infinity, ms: Infinity };
  private voices: { source: AudioBufferSourceNode | OscillatorNode; amp: GainNode }[] = [];

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

  /** The bed's current level, 0..1, so the pen can make room when the band is loud. */
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
    this.size = { width: width || 1, height: height || 1 };
    this.start = this.last = { x, y, t };
    this.travel = 0;
    this.speed = 0;
    this.tool = tool;
    this.opacity = opacity;
    const restful = t - this.lastActive;
    this.settle(t);
    this.startPaper(x);

    if (tool === 'eraser') return;
    // Hatching: a quick stroke right after another quick stroke is texture, not melody.
    const hatching = this.lastStroke.ms < 180 && t - this.lastStroke.end < 250;
    const fresh = restful > PHRASE_MS;
    if (fresh) this.phrase = { left: phrase(this.attention, Math.random).notes, breathUntil: -Infinity };
    if (hatching || !mayPlay(t, this.lastNote, this.attention)) return;
    if (this.phrase.left <= 0) {
      if (t < this.phrase.breathUntil) return; // the pen is breathing
      this.phrase.left = phrase(this.attention, Math.random).notes;
    }
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
    if (!start || !last) return;

    const ms = last.t - start.t;
    this.lastStroke = { end: t, ms };
    this.lastActive = t;
    // A long, deliberate stroke sometimes lands on a note where it ends.
    if (
      this.tool !== 'eraser' &&
      this.phrase.left > 0 &&
      ms > 900 &&
      this.travel > 180 &&
      mayPlay(t, this.lastNote, this.attention) &&
      Math.random() < 0.55 * this.attention
    ) {
      this.sing(this.aim(last.y), 0.4, t, 0.75);
    }
  }

  /** The eyes heard a new scene: a soft three-note answer, rising for bright scenes. */
  cue(bright = true): void {
    if (this.ctx.state === 'closed') return;
    this.attention = Math.min(1, this.attention + 0.25);
    const from = this.melody ?? 4;
    const base = bright ? Math.min(from, TOP - 4) : Math.max(from, 4);
    const now = this.ctx.currentTime;
    [0, 2, 4].forEach((step, i) => {
      const index = bright ? base + step : base - step;
      this.play(NOTES[index], 0.42 + 0.06 * i, now + 0.02 + i * 0.14, this.panAt(this.size.width / 2));
    });
    this.melody = bright ? base + 4 : base - 4;
    this.lastNote = performance.now();
    // Leave the answer some air before the pen's own next phrase.
    this.phrase = { left: 0, breathUntil: this.lastNote + 1500 };
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

    const root = PIANO_ROOTS.reduce((a, b) => (Math.abs(b - midi) < Math.abs(a - midi) ? b : a));
    const sample = this.piano.get(root);
    let source: AudioBufferSourceNode | OscillatorNode;
    if (sample) {
      const cents = (Math.random() - 0.5) * 8;
      source = new AudioBufferSourceNode(ctx, {
        buffer: sample.buffer,
        playbackRate: 2 ** ((midi - root + cents / 100) / 12),
      });
      source.connect(tone);
      source.start(when, sample.onset);
    } else {
      // Until the piano arrives: a soft sine bell with a quick fade.
      source = new OscillatorNode(ctx, { frequency: 440 * 2 ** ((midi - 69) / 12) });
      const bell = new GainNode(ctx, { gain: 0 });
      bell.gain.setValueAtTime(0, when);
      bell.gain.linearRampToValueAtTime(0.5, when + 0.006);
      bell.gain.setTargetAtTime(0, when + 0.006, 0.35);
      source.connect(bell).connect(tone);
      source.start(when);
      source.stop(when + 2.5);
    }

    // Eight voices is plenty for a pen; the oldest bows out quickly when a ninth arrives.
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
