import { useEffect, useRef } from 'react';

/** Resting pose when silent — still an equalizer glyph, just not moving. */
const EQ_REST = [0.45, 0.8, 0.6, 0.35];
const EQ_FLOOR = 0.16;
/** Meters look wrong with symmetric smoothing: level should jump and then sag,
 *  so attack is near-instant and release is slow. */
const EQ_ATTACK = 0.55;
const EQ_RELEASE = 0.12;

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
        if (el) el.style.transform = `scaleY(${EQ_FLOOR + v * (1 - EQ_FLOOR)})`;
      });

    if (!animated || !getLevels) {
      apply(EQ_REST);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      apply(EQ_REST);
      return;
    }

    const smoothed = [...EQ_REST];
    let raf = 0;

    const tick = () => {
      const levels = getLevels(EQ_REST.length);
      if (levels) {
        for (let i = 0; i < smoothed.length; i++) {
          const target = levels[i] ?? 0;
          const k = target > smoothed[i] ? EQ_ATTACK : EQ_RELEASE;
          smoothed[i] += (target - smoothed[i]) * k;
        }
        apply(smoothed);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animated, getLevels]);

  return (
    <span className="flex h-4 items-center gap-[2.5px]" aria-hidden="true">
      {EQ_REST.map((rest, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-full w-[2.5px] origin-center rounded-full bg-current"
          style={{ transform: `scaleY(${EQ_FLOOR + rest * (1 - EQ_FLOOR)})` }}
        />
      ))}
    </span>
  );
}
