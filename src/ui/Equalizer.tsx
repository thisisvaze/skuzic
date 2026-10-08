import { useEffect, useRef } from 'react';

/** Resting pose when silent — still an equalizer glyph, just not moving. */
const EQ_REST = [0.45, 0.8, 0.6, 0.35];
const EQ_FLOOR = 0.16;
/**
 * Each band is read against its own recent range, so a band that is always
 * loud still dances: its ceiling sinks and its floor rises toward the current
 * level over about this long. A minimum span keeps a steady pad from being
 * stretched into noise; it sits mid-height and sways.
 */
const EQ_RANGE_SECONDS = 1.5;
const EQ_MIN_SPAN = 0.12;
/** Gently follow the spectrum, settling without a visible bounce. */
const EQ_STIFFNESS = 220;
const EQ_DAMPING = 30;

/**
 * Bars follow the actual spectrum. Levels are written straight to the DOM in a
 * rAF loop rather than through state — this runs at display rate, and putting
 * it through React would re-render the whole tree 60 times a second.
 */
export function Equalizer({
  animated,
  getLevels,
}: {
  animated?: boolean;
  getLevels?: (bands: number) => number[] | null;
}) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const apply = (values: number[]) =>
      values.forEach((v, i) => {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleY(${EQ_FLOOR + Math.min(1, Math.max(0, v)) * (1 - EQ_FLOOR)})`;
      });

    if (!animated || !getLevels) {
      apply(EQ_REST);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply(EQ_REST);
      return;
    }

    const pos = [...EQ_REST];
    const vel = EQ_REST.map(() => 0);
    const lo = EQ_REST.map(() => 1);
    const hi = EQ_REST.map(() => 0);
    let last = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      // Real time, so the motion is the same at 60 Hz and 120 Hz; clamped so
      // the first frame back from a hidden tab doesn't fling the springs.
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const levels = getLevels(EQ_REST.length);
      if (levels) {
        const relax = 1 - Math.exp(-dt / EQ_RANGE_SECONDS);
        for (let i = 0; i < pos.length; i++) {
          const v = levels[i] ?? 0;
          hi[i] = v > hi[i] ? v : hi[i] + (v - hi[i]) * relax;
          lo[i] = v < lo[i] ? v : lo[i] + (v - lo[i]) * relax;
          const span = Math.max(EQ_MIN_SPAN, hi[i] - lo[i]);
          const target = Math.min(1, Math.max(0, 0.5 + (v - (hi[i] + lo[i]) / 2) / span));
          vel[i] += (EQ_STIFFNESS * (target - pos[i]) - EQ_DAMPING * vel[i]) * dt;
          pos[i] += vel[i] * dt;
        }
        apply(pos);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animated, getLevels]);

  return (
    <span className="flex h-3.5 items-center gap-[2.5px] text-muted-foreground/70" aria-hidden="true">
      {EQ_REST.map((rest, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full w-0.5 origin-center rounded-full bg-current"
          style={{
            transform: `scaleY(${EQ_FLOOR + rest * (1 - EQ_FLOOR)})`,
          }}
        />
      ))}
    </span>
  );
}
