import { Keyboard } from 'lucide-react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip';

export function DrawingShortcuts({
  isOpen,
  onOpenChange,
  modifier,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  modifier: string;
}) {
  const rows = [
    ['Pencil', 'P'],
    ['Watercolor', 'B'],
    ['Eraser', 'E'],
    ['Choose colour', 'C'],
    ['Smaller / larger brush', '[ / ]'],
    ['Opacity 10–90% / 100%', '1–9 / 0'],
    ['Less / more opacity', 'Shift + [ / ]'],
    ['Undo', `${modifier}Z`],
    ['Redo', modifier === '⌘' ? '⌘⇧Z' : 'Ctrl+Shift+Z / Ctrl+Y'],
    ['Show shortcuts', '?'],
  ];

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <ShortcutTooltip label="Drawing shortcuts" shortcut="?">
        <Button
          aria-label="Drawing shortcuts (?)"
          aria-keyshortcuts="Shift+?"
          className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring/60"
        >
          <Keyboard className="size-4" />
        </Button>
      </ShortcutTooltip>
      <Popover
        isNonModal
        placement="right bottom"
        offset={12}
        className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-3xl bg-popover p-4 text-popover-foreground shadow-xl ring-1 ring-border outline-none data-[entering]:animate-in data-[entering]:fade-in-0 data-[exiting]:animate-out data-[exiting]:fade-out-0 motion-reduce:animate-none"
      >
        <Dialog aria-label="Drawing shortcuts" className="outline-none">
          <h2 className="mb-3 text-sm font-medium">Drawing shortcuts</h2>
          <dl className="space-y-2.5 text-xs">
            {rows.map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="shrink-0">
                  <kbd className="font-sans text-[11px]">{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
            Shortcuts pause while you type. Esc closes this guide.
          </p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
