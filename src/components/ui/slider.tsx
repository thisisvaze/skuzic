import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';

import { cn } from '@/lib/utils';

/**
 * A well whose fill ends in a grip line; size it with a height class. Colours
 * come from three CSS vars (themed in styles.css) so a caller can tint one
 * slider without a variant explosion: --slider-track, --slider-range, --slider-thumb.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  'aria-label': ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const [dragging, setDragging] = React.useState(false);
  const pct = Math.min(1, Math.max(0, ((value ?? defaultValue ?? [min])[0] - min) / (max - min || 1)));

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        'relative flex h-10 w-full cursor-ew-resize touch-none items-center rounded-md select-none',
        'has-focus-visible:ring-2 has-focus-visible:ring-ring/60 data-disabled:cursor-default data-disabled:opacity-40',
        className,
      )}
      {...props}
      onPointerDownCapture={(event) => {
        if (!props.disabled) setDragging(true);
        props.onPointerDownCapture?.(event);
      }}
      onPointerUpCapture={(event) => {
        setDragging(false);
        props.onPointerUpCapture?.(event);
      }}
      onPointerCancel={(event) => {
        setDragging(false);
        props.onPointerCancel?.(event);
      }}
      onLostPointerCapture={(event) => {
        setDragging(false);
        props.onLostPointerCapture?.(event);
      }}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-full grow rounded-md border bg-[var(--slider-track)]"
      >
        {/* Drawn here instead of by Radix's Range so it never gets narrower than
            its grip: the knob still reads as a knob at zero. */}
        <span
          data-slot="slider-range"
          className={cn(
            'absolute inset-y-0.5 left-0.5 rounded-[10px] border bg-[var(--slider-range)] shadow-xs',
            'after:absolute after:inset-y-[22%] after:right-1.5 after:w-[3px] after:rounded-full after:bg-[var(--slider-thumb)]',
            // Follow the hand immediately; ease changes coming from the drawing or keyboard.
            !dragging &&
              'transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          )}
          style={{ width: `calc(1rem + (100% - 1rem - 4px) * ${pct})` }}
        />
      </SliderPrimitive.Track>
      {/* What the keyboard and screen readers hold; the grip is what you see. */}
      <SliderPrimitive.Thumb data-slot="slider-thumb" aria-label={ariaLabel} className="block outline-none" />
    </SliderPrimitive.Root>
  );
}

export { Slider };
