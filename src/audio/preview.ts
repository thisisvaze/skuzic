/**
 * A short loop of a vibe, heard the moment it's tapped: the band takes a few
 * seconds to connect and start, and that is too long to wait to hear what a
 * vibe is. Loops are rendered by scripts/make-vibe-previews.py.
 *
 * Every pass is its own source, scheduled up front, with its tail crossfaded
 * into the next pass; a buffer that simply looped would click at the seam,
 * since an MP3 doesn't start or end on the exact sample it was cut at.
 */

const LOOPS = `${import.meta.env.BASE_URL}sounds/vibes/`;
/** The loop files carry this much past the loop point, for the crossfade. Matches the script. */
const TAIL = 1;
/** Enough passes to get the idea; after that the page goes quiet again. */
const PASSES = 2;
const FADE_IN = 0.5;
const FADE_OUT = 3;

interface Pass {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class VibePreview {
  private ctx = new AudioContext();
  private out = new GainNode(this.ctx);
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private passes: Pass[] = [];
  private seq = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  /** Told whenever a preview starts or goes quiet, so the page can say so. */
  constructor(private onChange: (vibe: string | null) => void) {
    this.out.connect(this.ctx.destination);
  }

  private load(id: string): Promise<AudioBuffer> {
    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = fetch(`${LOOPS}${id}.mp3`)
        .then((r) => {
          if (!r.ok) throw new Error(`no preview for ${id}`);
          return r.arrayBuffer();
        })
        .then((data) => this.ctx.decodeAudioData(data));
      // A failed fetch shouldn't stick: the next tap tries again.
      buffer.catch(() => this.buffers.delete(id));
      this.buffers.set(id, buffer);
    }
    return buffer;
  }

  setVolume(volume: number): void {
    this.out.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.05);
  }

  async play(id: string): Promise<void> {
    const seq = ++this.seq;
    void this.ctx.resume();
    let buffer: AudioBuffer;
    try {
      buffer = await this.load(id);
    } catch {
      return; // no loop for this vibe yet; the band will still start on the first mark
    }
    // Tapped something else while this one loaded.
    if (seq !== this.seq) return;

    this.stop(0.6);
    const length = buffer.duration - TAIL;
    const t0 = this.ctx.currentTime + 0.05;
    for (let k = 0; k < PASSES; k++) {
      const start = t0 + k * length;
      const end = start + length + TAIL;
      const source = new AudioBufferSourceNode(this.ctx, { buffer });
      const gain = new GainNode(this.ctx, { gain: 0 });
      source.connect(gain).connect(this.out);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(1, start + (k === 0 ? FADE_IN : TAIL));
      if (k < PASSES - 1) {
        // The tail overlaps the next pass's head: one fades out as the other fades in.
        gain.gain.setValueAtTime(1, start + length);
        gain.gain.linearRampToValueAtTime(0, end);
      } else {
        gain.gain.setValueAtTime(1, end - FADE_OUT);
        gain.gain.linearRampToValueAtTime(0.3, end - FADE_OUT * 0.4);
        gain.gain.linearRampToValueAtTime(0, end);
      }
      source.start(start);
      source.stop(end);
      this.passes.push({ source, gain });
    }
    this.onChange(id);
    this.endTimer = setTimeout(() => this.finish(), (t0 + PASSES * length + TAIL - this.ctx.currentTime) * 1000);
  }

  /** Wind down whatever is playing over `fade` seconds. */
  stop(fade = FADE_OUT): void {
    if (!this.passes.length) return;
    const now = this.ctx.currentTime;
    for (const { source, gain } of this.passes) {
      const from = gain.gain.value;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(from, now);
      gain.gain.linearRampToValueAtTime(from * 0.3, now + fade * 0.6);
      gain.gain.linearRampToValueAtTime(0, now + fade);
      try {
        source.stop(now + fade);
      } catch {
        // Already stopped.
      }
    }
    this.finish();
  }

  private finish(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    this.passes = [];
    this.onChange(null);
  }

  get playing(): boolean {
    return this.passes.length > 0;
  }

  close(): void {
    this.stop(0.1);
    void this.ctx.close();
  }
}
