import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

/**
 * Colours come from three CSS vars so a caller can tint one slider without a
 * variant explosion: --slider-track, --slider-range, --slider-thumb.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  fat = false,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { fat?: boolean }) {
  const values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [value, defaultValue, min],
  );

  // Radix keeps the thumb inside the track, so its centre sits at
  // `pct% + (0.5 - pct) * thumbSize` — not at a flat `pct%`. Painting the fill
  // as a gradient to that exact point is the only way the boundary stays hidden
  // under the thumb at every position instead of peeking out near the ends.
  const thumb = fat ? 28 : 14;
  const pct = Math.min(1, Math.max(0, (values[0] - min) / (max - min || 1)));
  const stop = `calc(${pct * 100}% + ${(0.5 - pct) * thumb}px)`;

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn('relative grow overflow-hidden rounded-full', fat ? 'h-7' : 'h-1.5')}
        style={{
          background: `linear-gradient(to right, var(--slider-range, var(--foreground)) 0 ${stop}, var(--slider-track, var(--muted)) ${stop} 100%)`,
        }}
      />
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        className={cn(
          'block shrink-0 rounded-full bg-[var(--slider-thumb,var(--foreground))] outline-none',
          'transition-shadow focus-visible:ring-2 focus-visible:ring-ring/60',
          fat ? 'size-7' : 'size-3.5',
        )}
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
