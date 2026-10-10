/**
 * The model emits audio faster than real time in bursts. This buffers those
 * chunks and plays them back gapless on the Web Audio clock.
 */

import type { Lead } from './engine';

const DEFAULT_SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** Pause duck. Long enough not to click, short enough to feel immediate. */
const MUTE_FADE = 0.2;

/**
 * Audio held before playback starts. Lyria sends 2 s chunks, and the second
 * one lands about 2.5 s after the first, so anything much under a second runs
 * dry right after every start: a stop, a gap and a restart, heard as a
 * stutter. Measured in the browser: 0.4 s underran on every start.
 */
const LEAD_IN = 1.0;
/** Each underrun mid-stream adds this much, up to MAX_LEAD, so a slow connection stops stuttering. */
const LEAD_STEP = 0.5;
const MAX_LEAD = 3;
/** A chunk that restarts the stream after a gap fades in, so its first sample doesn't click. */
const RESTART_FADE = 0.02;

/**
 * Where the music changes (a reset, or a new tempo or key), the old music plays
 * out what is queued and fades into the new chunk, which fades up. About a
 * second is still queued when a chunk lands, so it's a short dip, not a gap.
 */
const SWAP_FADE = 0.5;

/**
 * The hand's lead glides in with this time constant, holds this long after the
 * last call, then settles back with this one (about 3 s all told). Quick to
 * rise and slow to settle, so the music follows the hand without pumping in
 * the gaps between strokes.
 */
const LEAD_ATTACK = 0.25;
const LEAD_HOLD = 0.4;
const LEAD_RELEASE = 0.9;
/** Where the lead's top-end tilt starts, in Hz. */
const LEAD_SHELF_HZ = 3000;

/** Meter range. Above ~8k there is little musical energy to show. */
const METER_MIN_HZ = 40;
const METER_MAX_HZ = 8000;

/** Chunks arrive as `audio/L16;codec=pcm;rate=48000` — trust the header if present. */
function sampleRateFrom(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : DEFAULT_SAMPLE_RATE;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class PcmScheduler {
  private ctx: AudioContext;
  private gain: GainNode;
  private analyser: AnalyserNode;
  /** The hand's lead: a top-end tilt, the side signal for width, and a level, all untouched at rest. */
  private tone: BiquadFilterNode;
  private side: GainNode;
  private lift: GainNode;
  // Explicit ArrayBuffer: getByteFrequencyData rejects a possibly-shared buffer.
  private spectrum?: Uint8Array<ArrayBuffer>;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /**
   * Audio held before playback starts, absorbing jitter in the stream. This is
   * added latency on every steer, so it starts at LEAD_IN and only grows when
   * the stream proves it needs more.
   */
  private leadIn = LEAD_IN;
  /** False until the first chunk after a flush: that one starting cold isn't an underrun. */
  private flowing = false;
  /** During a mute's fade chunks still come in, so the fade has music to fade. */
  private acceptUntil = 0;

  /** The user's level, tracked separately so a mute can't overwrite it. */
  private volume: number;
  private muted = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by reset(); the next chunk to land is where the music changes. */
  private swapNext = false;

  constructor(volume = 0.8) {
    this.ctx = new AudioContext({ sampleRate: DEFAULT_SAMPLE_RATE });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;

    // Sources -> analyser -> lead -> gain -> out. Tapping ahead of the gain
    // keeps the meter reading the music rather than the master volume, so
    // muting an A/B arm doesn't flatten the bars.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;
    // The default -100 to -30 dB window tops out below ordinary music, so
    // every band read as nearly full and the meter sat at its maximum.
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    // Width as mid/side: the side signal (L - R) / 2, scaled by width - 1, is
    // added to the left and taken from the right. At 0 dB, 0 and 1 the lead
    // passes the music through untouched.
    this.tone = new BiquadFilterNode(this.ctx, { type: 'highshelf', frequency: LEAD_SHELF_HZ, gain: 0 });
    this.side = new GainNode(this.ctx, { gain: 0 });
    this.lift = new GainNode(this.ctx);
    const split = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
    const merge = new ChannelMergerNode(this.ctx, { numberOfInputs: 2 });
    this.analyser.connect(this.tone).connect(split);
    split.connect(merge, 0, 0);
    split.connect(merge, 1, 1);
    split.connect(new GainNode(this.ctx, { gain: 0.5 }), 0).connect(this.side);
    split.connect(new GainNode(this.ctx, { gain: -0.5 }), 1).connect(this.side);
    this.side.connect(merge, 0, 0);
    this.side.connect(new GainNode(this.ctx, { gain: -1 })).connect(merge, 0, 1);
    merge.connect(this.lift).connect(this.gain).connect(this.ctx.destination);

    this.volume = volume;
  }

  get bufferedSeconds(): number {
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }

  /**
   * Band energies 0..1, low to high, for a meter.
   *
   * Bands are spaced logarithmically. Musical energy crowds into the bottom
   * couple of kHz, so linear bands would leave everything above the first one
   * pinned near zero. Peak per band rather than mean, which keeps transients
   * visible instead of averaging them away.
   */
  getLevels(bands: number): number[] {
    const bins = this.analyser.frequencyBinCount;
    if (!this.spectrum || this.spectrum.length !== bins) {
      this.spectrum = new Uint8Array(bins);
    }
    this.analyser.getByteFrequencyData(this.spectrum);

    const binHz = this.ctx.sampleRate / 2 / bins;
    const ratio = METER_MAX_HZ / METER_MIN_HZ;
    const out: number[] = [];

    for (let b = 0; b < bands; b++) {
      const lo = METER_MIN_HZ * Math.pow(ratio, b / bands);
      const hi = METER_MIN_HZ * Math.pow(ratio, (b + 1) / bands);
      const first = Math.max(0, Math.floor(lo / binHz));
      const last = Math.min(bins - 1, Math.max(first, Math.ceil(hi / binHz) - 1));

      let peak = 0;
      for (let i = first; i <= last; i++) peak = Math.max(peak, this.spectrum[i]);
      out.push(peak / 255);
    }
    return out;
  }

  /**
   * Fire and forget, never awaited. A context made on page load, before any
   * gesture, comes back suspended, and Chromium neither starts it nor rejects
   * this resume: the promise just waits for a later resume after a gesture.
   * connect() used to await it, so a band started on load hung on "Starting
   * the band…" for good. play() calls this again once the page has been touched.
   */
  resume(): void {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Lyria path: base64 chunks with the rate carried in the MIME type. */
  enqueue(base64: string, mimeType?: string, swap = false): void {
    this.enqueueBytes(base64ToBytes(base64), sampleRateFrom(mimeType), swap);
  }

  /** Magenta bridge path: raw interleaved int16 over a binary WebSocket frame. */
  enqueueBytes(bytes: Uint8Array, rate: number = DEFAULT_SAMPLE_RATE, swap = false): void {
    // Chunks that land once a mute has faded out would play silently and leave
    // a stale tail to resume with. During the fade they keep the music going;
    // dropping them there made a long fade run dry and cut off instead.
    if (this.muted && this.ctx.currentTime >= this.acceptUntil) return;

    // Copy into an aligned buffer: Int16Array requires an even byte offset.
    const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1)));

    const frames = Math.floor(pcm.length / CHANNELS);
    if (frames === 0) return;

    const buffer = this.ctx.createBuffer(CHANNELS, frames, rate);

    for (let ch = 0; ch < CHANNELS; ch++) {
      const out = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) out[i] = pcm[i * CHANNELS + ch] / 32768;
    }

    // Underrun (or first chunk): re-anchor ahead of the clock instead of
    // scheduling in the past, which would drop the chunk silently.
    let restart = false;
    if (this.nextTime < this.ctx.currentTime + 0.05) {
      if (this.flowing) this.leadIn = Math.min(MAX_LEAD, this.leadIn + LEAD_STEP);
      this.nextTime = this.ctx.currentTime + this.leadIn;
      restart = this.flowing;
    }
    this.flowing = true;

    // The chunk where the music changes: fade what is queued out into it, and
    // it in, so the seam is a dip rather than a jump. Added without a cancel,
    // which would wipe an earlier swap's dip that hasn't played yet.
    if (swap || this.swapNext) {
      this.swapNext = false;
      if (!this.muted) {
        const at = this.nextTime;
        this.gain.gain.setValueAtTime(this.volume, Math.max(this.ctx.currentTime, at - SWAP_FADE));
        this.gain.gain.linearRampToValueAtTime(0, at);
        this.gain.gain.linearRampToValueAtTime(this.volume, at + SWAP_FADE);
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    if (restart) {
      const fade = new GainNode(this.ctx, { gain: 0 });
      fade.gain.setValueAtTime(0, this.nextTime);
      fade.gain.linearRampToValueAtTime(1, this.nextTime + RESTART_FADE);
      source.connect(fade).connect(this.analyser);
    } else {
      source.connect(this.analyser);
    }
    source.start(this.nextTime);
    this.nextTime += buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /**
   * Tell the model to restart now and swap on the next chunk. Dropping the
   * queue instead left a 2-3 s silence that read as the music cutting off.
   * ponytail: a chunk already in flight is still old music and takes the
   * swap; callers that can tell the new chunk apart pass `swap` instead.
   */
  reset(onReset: () => void): void {
    onReset();
    this.swapNext = true;
    if (this.muted) this.flush();
  }

  setVolume(v: number): void {
    this.volume = v;
    // While muted the level is remembered but not applied, so setting the
    // volume during a pause can't undo the mute.
    if (!this.muted) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Lean the music with the hand: glide to `lead` now, and back to untouched unless another call follows. */
  lead({ lift, tone, width }: Lead): void {
    const now = this.ctx.currentTime;
    const glide = (param: AudioParam, to: number, rest: number) => {
      param.cancelScheduledValues(now);
      param.setTargetAtTime(to, now, LEAD_ATTACK);
      param.setTargetAtTime(rest, now + LEAD_HOLD, LEAD_RELEASE);
    };
    glide(this.lift.gain, 10 ** (lift / 20), 1);
    glide(this.tone.gain, tone, 0);
    glide(this.side.gain, width - 1, 0);
  }

  /** Cancel any in-flight ramp and hold wherever the gain currently sits. */
  private holdGain(): number {
    const now = this.ctx.currentTime;
    const current = this.gain.gain.value;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(current, now);
    return now;
  }

  /**
   * Duck to silence, then drop what is still queued. Both halves matter: a bare
   * flush clicks, and a bare fade would leave the stale tail to resume on the
   * next play.
   */
  mute(seconds = MUTE_FADE): void {
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muted = true;
    this.acceptUntil = this.ctx.currentTime + seconds;
    const now = this.holdGain();
    const from = this.gain.gain.value;
    // A straight line sounds like it gives up at the end; easing the level
    // down in steps sounds like the music winding down.
    this.gain.gain.linearRampToValueAtTime(from * 0.45, now + seconds * 0.4);
    this.gain.gain.linearRampToValueAtTime(from * 0.12, now + seconds * 0.75);
    this.gain.gain.linearRampToValueAtTime(0, now + seconds);
    this.muteTimer = setTimeout(() => {
      this.muteTimer = null;
      this.flush();
    }, seconds * 1000);
  }

  /** Fade back to the user's level. Safe to call when not muted. */
  unmute(seconds = MUTE_FADE): void {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    this.muted = false;
    const now = this.holdGain();
    this.gain.gain.linearRampToValueAtTime(this.volume, now + seconds);
  }

  /** Drop everything queued — used on stop, so old audio doesn't outlive it. */
  flush(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.flowing = false;
  }

  async close(): Promise<void> {
    if (this.muteTimer) {
      clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
    this.flush();
    // Closing an already-closed context throws InvalidStateError, and teardown
    // legitimately runs twice (explicit stop, then unmount).
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }
}
