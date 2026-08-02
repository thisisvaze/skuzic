/**
 * The model emits audio faster than real time in bursts. This buffers those
 * chunks and plays them back gapless on the Web Audio clock.
 */

const DEFAULT_SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** Pause duck. Long enough not to click, short enough to feel immediate. */
const MUTE_FADE = 0.2;

/**
 * A context reset drops every queued buffer, so there is an unavoidable gap
 * while the model regenerates. Ducking either side of it turns a click plus
 * abrupt re-entry into a deliberate-sounding swell.
 */
const RESET_DUCK = 0.15;

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
  // Explicit ArrayBuffer: getByteFrequencyData rejects a possibly-shared buffer.
  private spectrum?: Uint8Array<ArrayBuffer>;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();

  /**
   * Audio held before playback starts, absorbing jitter in the stream. This is
   * pure added latency on every steer, so keep it just above the worst
   * inter-chunk gap rather than "comfortably large".
   */
  private readonly leadIn = 0.4;

  /** The user's level, tracked separately so a mute can't overwrite it. */
  private volume: number;
  private muted = false;
  private muteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by reset(); the next chunk to land fades in instead of cutting in. */
  private fadeInNext = false;

  constructor(volume = 0.8) {
    this.ctx = new AudioContext({ sampleRate: DEFAULT_SAMPLE_RATE });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;

    // Sources -> analyser -> gain -> out. Tapping ahead of the gain keeps the
    // meter reading the music rather than the volume slider, so turning down
    // doesn't flatten the bars.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);

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
   * The context is constructed on page load, which is outside a user gesture,
   * so the browser hands it back suspended and refuses this resume. That is
   * recoverable — the next resume from a real gesture succeeds — but only if
   * the rejection does not take connect() down with it.
   */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'suspended') return;
    try {
      await this.ctx.resume();
    } catch {
      // Blocked by the autoplay policy. play() resumes again on a gesture.
    }
  }

  /** Lyria path: base64 chunks with the rate carried in the MIME type. */
  enqueue(base64: string, mimeType?: string): void {
    this.enqueueBytes(base64ToBytes(base64), sampleRateFrom(mimeType));
  }

  /** Magenta bridge path: raw interleaved int16 over a binary WebSocket frame. */
  enqueueBytes(bytes: Uint8Array, rate: number = DEFAULT_SAMPLE_RATE): void {
    // Chunks still in flight when pause was pressed. Queueing them would play
    // them silently now and leave a stale tail to resume with.
    if (this.muted) return;

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
    if (this.nextTime < this.ctx.currentTime + 0.05) {
      this.nextTime = this.ctx.currentTime + this.leadIn;
    }

    // First chunk back after a reset: swell in exactly where the audio starts,
    // rather than arriving at full level mid-gap.
    if (this.fadeInNext) {
      this.fadeInNext = false;
      if (!this.muted) {
        const at = this.nextTime;
        this.gain.gain.cancelScheduledValues(at);
        this.gain.gain.setValueAtTime(0, at);
        this.gain.gain.linearRampToValueAtTime(this.volume, at + RESET_DUCK);
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    source.start(this.nextTime);
    this.nextTime += buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  /**
   * Duck out, drop the queue, then hand back so the caller can reset the model
   * while nothing is audible. The next chunk fades back in.
   *
   * `onSilent` fires at the bottom of the duck — that is the moment to tell the
   * model to restart, so its gap lands inside our silence rather than beside it.
   */
  reset(onSilent: () => void): void {
    const now = this.ctx.currentTime;
    if (!this.muted) {
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      this.gain.gain.linearRampToValueAtTime(0, now + RESET_DUCK);
    }

    setTimeout(
      () => {
        this.flush();
        this.fadeInNext = true;
        onSilent();
      },
      this.muted ? 0 : RESET_DUCK * 1000,
    );
  }

  setVolume(v: number): void {
    this.volume = v;
    // While muted the level is remembered but not applied, so dragging the
    // volume slider during a pause can't undo the mute.
    if (!this.muted) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
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
    const now = this.holdGain();
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
