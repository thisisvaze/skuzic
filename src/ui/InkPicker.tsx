import { useEffect, useRef, useState } from 'react';
import {
  Button,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  ColorSwatchPickerItem,
  ColorThumb,
  Dialog,
  DialogTrigger,
  Input,
  Popover,
  SliderTrack,
  parseColor,
  type Color,
} from 'react-aria-components';
import { cn } from '@/lib/utils';
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip';

/** The thumb's white ring, readable over any colour. */
const THUMB =
  'rounded-full border-[3px] border-white shadow-[0_0_0_1px_rgb(0_0_0/0.12),0_2px_6px_rgb(0_0_0/0.25)] transition-[width,height] duration-150 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-ring';

/**
 * The ink colour: a swatch in the rail that opens HeroUI's colour picker
 * layout (presets, a saturation and brightness area, a hue slider, a hex
 * field), built on React Aria's ColorPicker, which HeroUI's is made from.
 * HeroUI's own stylesheet isn't used: its theme redefines --accent, --border,
 * --radius and Tailwind's rounded-* scale, which would restyle the studio.
 *
 * The colour is kept as HSB inside, so dragging through grey or black doesn't
 * lose the hue the way a hex round trip would.
 */
export function InkPicker({
  value,
  presets,
  onChange,
  isOpen,
  onOpenChange,
}: {
  /** #rrggbb */
  value: string;
  presets: string[];
  onChange: (hex: string) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [color, setColor] = useState<Color>(() => parseColor(value).toFormat('hsb'));
  const popover = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Non-modal so the paper stays drawable, which also means pressing outside
  // doesn't close it. Any press outside does here (a stroke, another tool, the
  // mixer), without stopping that press from doing its own thing.
  useEffect(() => {
    if (!isOpen) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) onOpenChange?.(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [isOpen, onOpenChange]);
  useEffect(() => {
    if (color.toString('hex').toLowerCase() !== value.toLowerCase()) setColor(parseColor(value).toFormat('hsb'));
    // Only an outside change of ink should reset the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <ColorPicker
      value={color}
      onChange={(next) => {
        setColor(next);
        onChange(next.toString('hex').toLowerCase());
      }}
    >
      <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <ShortcutTooltip label="Ink colour" shortcut="C">
          <Button
            ref={trigger}
            aria-label="Ink colour"
            aria-keyshortcuts="C"
            aria-description="Choose an ink colour. Shortcut: C."
            className="grid size-9 place-items-center rounded-full outline-none transition-colors hover:bg-secondary data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring/60"
          >
            <ColorSwatch className="size-[22px] rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)]" />
          </Button>
        </ShortcutTooltip>
        <Popover
          ref={popover}
          // A drawing palette must not put an input-blocking underlay over the canvas.
          isNonModal
          // Focus leaving for its own swatch isn't leaving: the swatch's press toggles it shut,
          // where closing on the blur first would have it reopen on the same press.
          shouldCloseOnInteractOutside={(element) => !trigger.current?.contains(element)}
          placement="right"
          offset={12}
          className={cn(
            'z-50 w-64 rounded-3xl bg-popover p-3 text-popover-foreground shadow-[0_18px_50px_-12px_rgb(0_0_0/0.35)] ring-1 ring-border outline-none',
            'data-[entering]:animate-in data-[entering]:fade-in-0 data-[entering]:zoom-in-95 data-[exiting]:animate-out data-[exiting]:fade-out-0 data-[exiting]:zoom-out-95',
          )}
        >
          <Dialog aria-label="Ink colour" className="flex flex-col gap-3 outline-none">
            <ColorSwatchPicker className="grid grid-cols-6 gap-1.5">
              {presets.map((preset) => (
                <ColorSwatchPickerItem
                  key={preset}
                  color={preset}
                  className="group grid aspect-square place-items-center rounded-full outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring/60"
                >
                  <ColorSwatch className="size-7 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] transition-transform group-hover:scale-110 group-data-[selected]:shadow-[0_0_0_2px_var(--popover),0_0_0_3.5px_var(--foreground)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)] dark:group-data-[selected]:shadow-[0_0_0_2px_var(--popover),0_0_0_3.5px_var(--foreground)]" />
                </ColorSwatchPickerItem>
              ))}
            </ColorSwatchPicker>

            <ColorArea
              colorSpace="hsb"
              xChannel="saturation"
              yChannel="brightness"
              className="aspect-square w-full rounded-2xl shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
            >
              <ColorThumb className={cn(THUMB, 'size-5 data-[dragging]:size-6')} />
            </ColorArea>

            <ColorSlider colorSpace="hsb" channel="hue" aria-label="Hue">
              <SliderTrack className="h-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]">
                <ColorThumb className={cn(THUMB, 'top-1/2 size-6')} />
              </SliderTrack>
            </ColorSlider>

            <div className="flex items-center gap-2">
              <ColorSwatch className="size-7 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)] dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.25)]" />
              <ColorField aria-label="Hex colour" className="min-w-0 flex-1">
                <Input className="h-9 w-full rounded-full bg-input px-3.5 font-mono text-[13px] uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
              </ColorField>
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </ColorPicker>
  );
}
