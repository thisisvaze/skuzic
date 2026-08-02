import type { PromptWeight } from './engine';

/**
 * Replacing a prompt set outright sounds like a jump cut on either backend.
 * This walks current weights toward their targets so changes crossfade.
 *
 * Both backends normalize weights internally, and both reject a weight of
 * exactly zero, so tracks fade to EPSILON and are then dropped entirely.
 */

const RAMP_MS = 1000;
const TICK_MS = 100;
/**
 * Interpolate every tick but send only every Nth frame (plus the settled one).
 * Every send is a full prompt-set replacement the model re-conditions on, and
 * ten of them in a second can stall chunk delivery long enough to underrun the
 * scheduler — heard as the music sticking right after a track is removed.
 * ~300ms steps still read as a crossfade.
 */
const SEND_EVERY_TICKS = 3;
export const EPSILON = 0.005;

export class PromptMixer {
  private current = new Map<string, number>();
  private target = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private tick = 0;

  constructor(
    private readonly send: (prompts: PromptWeight[]) => void,
    private readonly maxPrompts = 8,
  ) {}

  setTarget(prompts: PromptWeight[]): void {
    const merged = new Map<string, number>();
    for (const { text, weight } of prompts) {
      if (!text.trim() || weight <= 0) continue;
      merged.set(text, (merged.get(text) ?? 0) + weight);
    }

    // Backends cap simultaneous prompts; keep the loudest and drop the rest
    // rather than letting the backend truncate arbitrarily.
    const capped = [...merged].sort((a, b) => b[1] - a[1]).slice(0, this.maxPrompts);

    this.target = new Map(capped);
    for (const [key] of capped) {
      if (!this.current.has(key)) this.current.set(key, EPSILON);
    }

    this.start();
  }

  private start(): void {
    if (this.timer) return;
    this.tick = 0;
    const step = TICK_MS / RAMP_MS;

    this.timer = setInterval(() => {
      let settled = true;

      for (const [key, cur] of [...this.current]) {
        const goal = this.target.get(key) ?? 0;
        const diff = goal - cur;

        if (Math.abs(diff) <= step) {
          this.current.set(key, goal);
          if (goal <= EPSILON) this.current.delete(key);
        } else {
          settled = false;
          this.current.set(key, cur + Math.sign(diff) * step);
        }
      }

      // The settled frame carries the exact target weights and must always go
      // out; intermediate frames are expendable.
      const due = settled || this.tick++ % SEND_EVERY_TICKS === 0;

      const prompts = [...this.current]
        .filter(([, w]) => w > EPSILON)
        .map(([text, weight]) => ({ text, weight }));

      // An empty list is invalid on both backends; hold the last mix instead.
      if (prompts.length && due) this.send(prompts);

      if (settled) this.stop();
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  reset(): void {
    this.stop();
    this.current.clear();
    this.target.clear();
  }
}
