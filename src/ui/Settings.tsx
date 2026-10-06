import { useEffect, useRef, type ReactNode } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { Backend } from '../core/types';
import { PLANNER_CONFIG_LIST, type PlannerConfigId } from '../llm/configs';
import { PLANNER_MODELS, type PlannerModel } from '../llm/planner';

export type Theme = 'system' | 'light' | 'dark';

const BRIDGE_HELP = 'https://github.com/thisisvaze/skuzic/blob/main/server/README.md';

const ENGINES: { id: Backend; name: string; blurb: string }[] = [
  {
    id: 'lyria',
    name: 'Lyria RealTime',
    blurb: "Google's music model, in the cloud. Every knob works. Uses your Gemini key.",
  },
  {
    id: 'magenta',
    name: 'Magenta RT',
    blurb: 'An open model that runs on your own Mac. Needs the local bridge running.',
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
  backend: Backend;
  onBackendChange: (backend: Backend) => void;
  apiKey: string;
  /** Opens the key dialog, to connect a first key or swap it. */
  onConnectKey: () => void;
  onRemoveKey: () => void;
  plannerConfig: PlannerConfigId;
  onPlannerConfigChange: (config: PlannerConfigId) => void;
  plannerModel: PlannerModel;
  onPlannerModelChange: (model: PlannerModel) => void;
  abTest: boolean;
  onAbTestChange: (on: boolean) => void;
  /** Preference pairs saved so far — see src/lib/dataset.ts. */
  datasetCount: number;
  onExportDataset: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  connected: boolean;
  onDisconnect: () => void;
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** One of a few, as tiles. Radio semantics, so arrow keys and screen readers know the shape. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  columns,
}: {
  label: string;
  value: T;
  options: { id: T; title: ReactNode; detail?: string }[];
  onChange: (id: T) => void;
  columns?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid gap-2', columns && 'sm:grid-cols-2')}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.id)}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-2xl px-4 py-3 text-left outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-ring/60',
              on ? 'bg-popover ring-2 ring-brand-3' : 'bg-card ring-1 ring-border hover:ring-foreground/25',
            )}
          >
            <span className="text-[14px] font-medium">{o.title}</span>
            {o.detail && (
              <span className="text-[12px] leading-snug text-muted-foreground">{o.detail}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A small either/or, as a pill. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: ReactNode }[];
  onChange: (id: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-full bg-secondary p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex h-8 items-center justify-center gap-1.5 rounded-full text-[13px] outline-none transition-colors',
            'focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5',
            o.id === value ? 'bg-popover text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Everything you set once: the engine, the key, how Reimagine thinks, the
 * experiments. A native modal, so focus, Escape and the backdrop come free.
 */
export function Settings({
  open,
  onClose,
  backend,
  onBackendChange,
  apiKey,
  onConnectKey,
  onRemoveKey,
  plannerConfig,
  onPlannerConfigChange,
  plannerModel,
  onPlannerModelChange,
  abTest,
  onAbTestChange,
  datasetCount,
  onExportDataset,
  theme,
  onThemeChange,
  connected,
  onDisconnect,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Settings"
      onClose={onClose}
      // The dialog box is fully covered by its content, so a click that lands
      // on the dialog element itself came through the backdrop.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto max-h-[min(46rem,calc(100dvh-1.5rem))] w-[min(36rem,calc(100vw-1.5rem))] overflow-hidden rounded-[1.75rem] bg-popover p-0 text-popover-foreground shadow-2xl ring-1 ring-border"
    >
      <div className="flex max-h-[inherit] flex-col">
        <header className="flex items-center gap-3 px-6 pt-5 pb-3">
          {/* Takes the opening focus, so the close button doesn't greet you with a ring. */}
          <h2 tabIndex={-1} autoFocus className="font-display text-xl font-semibold tracking-[-0.02em] outline-none">
            Settings
          </h2>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="scrollbar-thin flex flex-col gap-8 overflow-y-auto px-6 pt-2 pb-6">
          <Group title="Music engine" hint="Which model plays the band. Switching reconnects.">
            <Choice
              label="Music engine"
              value={backend}
              columns
              options={ENGINES.map((e) => ({ id: e.id, title: e.name, detail: e.blurb }))}
              onChange={onBackendChange}
            />
            {backend === 'magenta' && (
              <a
                href={BRIDGE_HELP}
                target="_blank"
                rel="noreferrer"
                className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                How to run the Magenta bridge
              </a>
            )}
          </Group>

          <Group
            title="Gemini API key"
            hint="Lyria and Reimagine both use it. It's saved only in this browser and only ever sent to Google."
          >
            {apiKey ? (
              <div className="flex items-center gap-2 rounded-2xl bg-card py-2 pr-2 pl-4">
                <span className="min-w-0 flex-1 text-[14px]">
                  Connected{' '}
                  <span className="text-muted-foreground">· key ending in {apiKey.slice(-4)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={onConnectKey}>
                  Change
                </Button>
                <Button size="sm" variant="destructive" onClick={onRemoveKey}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button className="self-start" onClick={onConnectKey}>
                Connect your Gemini key
              </Button>
            )}
          </Group>

          <Group
            title="Reimagine"
            hint="What Gemini does when you tap Reimagine or ask the band for a change."
          >
            <Choice
              label="Reimagine approach"
              value={plannerConfig}
              options={PLANNER_CONFIG_LIST.map((c) => ({ id: c.id, title: c.label, detail: c.description }))}
              onChange={onPlannerConfigChange}
            />
            <div className="flex items-center justify-between gap-4 pt-1">
              <span className="text-[13px] text-muted-foreground">
                {PLANNER_MODELS.find((m) => m.id === plannerModel)?.detail}
              </span>
              <div className="w-48">
                <Segmented
                  label="Gemini model"
                  value={plannerModel}
                  options={PLANNER_MODELS.map((m) => ({ id: m.id, label: m.label }))}
                  onChange={onPlannerModelChange}
                />
              </div>
            </div>
          </Group>

          <Group title="Experiments">
            <div className="flex items-start gap-4 rounded-2xl bg-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">Compare two versions</p>
                <p className="text-[12px] leading-snug text-muted-foreground">
                  Reimagine makes two mixes and you keep the one you like. Your picks are saved in
                  this browser to help tune skuzic.
                </p>
              </div>
              <Switch on={abTest} onChange={onAbTestChange} label="Compare two versions" />
            </div>
            {datasetCount > 0 && (
              <div className="flex items-center justify-between px-1 text-[13px] text-muted-foreground">
                <span>
                  {datasetCount} pick{datasetCount === 1 ? '' : 's'} saved
                </span>
                <Button size="sm" variant="ghost" onClick={onExportDataset}>
                  Export
                </Button>
              </div>
            )}
          </Group>

          <Group title="Appearance">
            <Segmented
              label="Theme"
              value={theme}
              options={[
                { id: 'system', label: 'System', icon: <Monitor /> },
                { id: 'light', label: 'Light', icon: <Sun /> },
                { id: 'dark', label: 'Dark', icon: <Moon /> },
              ]}
              onChange={onThemeChange}
            />
          </Group>

          {connected && (
            <Button variant="ghost" className="self-start" onClick={onDisconnect}>
              Stop the band
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
