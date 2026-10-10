import type { ReactNode } from 'react';
import { Tooltip, TooltipTrigger } from 'react-aria-components';

/** Shared hover/focus hint for drawing controls, with a quiet keyboard cue. */
export function ShortcutTooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={350} closeDelay={80}>
      {children}
      <Tooltip
        placement="right"
        offset={12}
        className="z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg ring-1 ring-border data-[entering]:animate-in data-[entering]:fade-in-0 data-[exiting]:animate-out data-[exiting]:fade-out-0 motion-reduce:animate-none"
      >
        <span>{label}</span>
        {shortcut && (
          <kbd className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </Tooltip>
    </TooltipTrigger>
  );
}
