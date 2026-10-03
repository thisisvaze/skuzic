import { useState, type ReactNode } from 'react';
import { Scale } from '@google/genai';
import { ArrowUp, ChevronDown, Drum, Guitar, X } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { EngineCapabilities } from '../audio/engine';
import type { Action, MixConfig, Track } from '../core/types';
import { ActionLog, type LogEntry } from './ActionLog';
import { TrackRack } from './TrackRack';

const SCALE_LABELS: Record<string, string> = {
  [Scale.SCALE_UNSPECIFIED]: 'Any key',
  [Scale.C_MAJOR_A_MINOR]: 'C / Am',
  [Scale.D_FLAT_MAJOR_B_FLAT_MINOR]: 'D♭ / B♭m',
  [Scale.D_MAJOR_B_MINOR]: 'D / Bm',
  [Scale.E_FLAT_MAJOR_C_MINOR]: 'E♭ / Cm',
  [Scale.E_MAJOR_D_FLAT_MINOR]: 'E / D♭m',
  [Scale.F_MAJOR_D_MINOR]: 'F / Dm',
  [Scale.G_FLAT_MAJOR_E_FLAT_MINOR]: 'G♭ / E♭m',
  [Scale.G_MAJOR_E_MINOR]: 'G / Em',
  [Scale.A_FLAT_MAJOR_F_MINOR]: 'A♭ / Fm',
  [Scale.A_MAJOR_G_FLAT_MINOR]: 'A / G♭m',
  [Scale.B_FLAT_MAJOR_G_MINOR]: 'B♭ / Gm',
  [Scale.B_MAJOR_A_FLAT_MINOR]: 'B / A♭m',
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** What the band is playing, or what it's doing instead. */
  title: string;
  tracks: Track[];
  /** While an A/B choice is on the table the mix shown is a candidate, not yours to edit. */
  readOnly: boolean;
  dispatch: (action: Action) => void;
  config: MixConfig;
  capabilities: EngineCapabilities;
  follow: boolean;
  onFollowChange: (on: boolean) => void;
  canAsk: boolean;
  thinking: boolean;
  onAsk: (text: string) => void;
  log: LogEntry[];
}

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <h3 className="mb-2.5 flex items-baseline gap-2 px-1 text-[12px] font-medium text-muted-foreground">
      {children}
      {aside && <span className="ml-auto font-normal tabular-nums">{aside}</span>}
    </h3>
  );
}

/** A knob with its two ends named, so moving it says what it does. */
function Range({
  label,
  low,
  high,
  value,
  display,
  min = 0,
  max = 1,
  step = 0.01,
  hint,
  onChange,
}: {
  label: string;
  low: string;
  high: string;
  value: number;
  display: string;
  min?: number;
  max?: number;
  step?: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2" title={hint}>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="text-[12px] text-muted-foreground tabular-nums">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={([v]) => onChange(v)}
      />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

function Chip({
  on,
  onChange,
  icon,
  children,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cn(
        'flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4',
        on
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-muted-foreground line-through decoration-1 hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function Feel({
  config,
  capabilities: caps,
  dispatch,
}: {
  config: MixConfig;
  capabilities: EngineCapabilities;
  dispatch: (action: Action) => void;
}) {
  const set = (patch: Partial<MixConfig>) => dispatch({ type: 'SET_CONFIG', config: patch });
  const more = caps.bpm || caps.scale || caps.guidance;

  return (
    <section>
      <Heading>Feel</Heading>
      <div className="flex flex-col gap-5 rounded-2xl bg-card p-4">
        {caps.density && (
          <Range
            label="Energy"
            low="Calm"
            high="Busy"
            value={config.density}
            display={`${Math.round(config.density * 100)}%`}
            hint="How many notes and beats the band plays"
            onChange={(density) => set({ density })}
          />
        )}
        {caps.brightness && (
          <Range
            label="Brightness"
            low="Dark"
            high="Bright"
            value={config.brightness}
            display={`${Math.round(config.brightness * 100)}%`}
            hint="Warm and muffled, or crisp and sparkly"
            onChange={(brightness) => set({ brightness })}
          />
        )}
        {!caps.density && (
          <p className="text-[12px] leading-snug text-muted-foreground">
            Magenta has fewer knobs than Lyria: no energy, brightness, tempo or key.
          </p>
        )}
        {(caps.muteDrums || caps.muteBass) && (
          <div className="flex flex-wrap gap-2">
            {caps.muteDrums && (
              <Chip on={!config.muteDrums} onChange={(on) => set({ muteDrums: !on })} icon={<Drum />}>
                Drums
              </Chip>
            )}
            {caps.muteBass && (
              <Chip on={!config.muteBass} onChange={(on) => set({ muteBass: !on })} icon={<Guitar />}>
                Bass
              </Chip>
            )}
          </div>
        )}

        {more && (
          <details className="group -mx-1">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              {caps.bpm ? 'Tempo, key and more' : 'More'}
            </summary>
            <div className="flex flex-col gap-5 px-1 pt-4">
              {caps.bpm && (
                <Range
                  label="Tempo"
                  low="Slow"
                  high="Fast"
                  value={config.bpm}
                  min={60}
                  max={200}
                  step={1}
                  display={`${Math.round(config.bpm)} bpm`}
                  hint="Beats per minute. Changing it restarts the music for a moment."
                  onChange={(bpm) => set({ bpm })}
                />
              )}
              {caps.scale && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="font-medium">Key</span>
                    <Select value={config.scale} onValueChange={(v) => set({ scale: v as Scale })}>
                      <SelectTrigger aria-label="Key" className="h-8 w-32 bg-secondary">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(Scale).map((s) => (
                          <SelectItem key={s} value={s}>
                            {SCALE_LABELS[s] ?? s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    The pen always plays in F, so F / Dm sounds best with it.
                  </p>
                </div>
              )}
              {caps.guidance && (
                <Range
                  label="Follow the words"
                  low="Loose"
                  high="Strict"
                  value={config.guidance}
                  min={0}
                  max={6}
                  step={0.1}
                  display={config.guidance.toFixed(1)}
                  hint="Loose wanders and surprises; strict sticks closely to each sound's words"
                  onChange={(guidance) => set({ guidance })}
                />
              )}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * The band's controls: a column beside the paper on wide screens, a sheet over
 * the bottom of it on phones. One element either way, so state and focus
 * survive a resize.
 */
export function Mixer({
  open,
  onClose,
  title,
  tracks,
  readOnly,
  dispatch,
  config,
  capabilities,
  follow,
  onFollowChange,
  canAsk,
  thinking,
  onAsk,
  log,
}: Props) {
  const [tab, setTab] = useState<'mix' | 'history'>('mix');
  const [ask, setAsk] = useState('');

  return (
    <aside
      aria-label="mixer"
      inert={!open}
      className={cn(
        'z-40 flex flex-col overflow-hidden bg-popover text-popover-foreground',
        'fixed inset-x-2 bottom-2 max-h-[82dvh] rounded-[1.75rem] shadow-2xl ring-1 ring-border transition-transform duration-300 ease-out',
        open ? 'translate-y-0' : 'translate-y-[calc(100%+1rem)]',
        'lg:static lg:inset-auto lg:max-h-none lg:w-[22rem] lg:shrink-0 lg:translate-y-0 lg:shadow-none lg:transition-none',
        !open && 'lg:hidden',
      )}
    >
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <div role="tablist" className="flex rounded-full bg-secondary p-1">
          {(['mix', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'h-7 rounded-full px-3.5 text-[13px] capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
                tab === t ? 'bg-popover text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t === 'mix' ? 'Mixer' : 'History'}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Hide the mixer"
          title="Hide the mixer"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {tab === 'mix' ? (
          <div className="flex flex-col gap-6">
            <section className="rounded-3xl bg-card p-4">
              <p className="text-[12px] font-medium text-muted-foreground">
                {readOnly ? 'Trying out' : 'Now playing'}
              </p>
              <p className="mt-0.5 font-display text-[1.6rem] leading-tight font-semibold tracking-[-0.02em] first-letter:uppercase">
                {title}
              </p>
              <div className="mt-4 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">Follow my drawing</p>
                  <p className="text-[12px] leading-snug text-muted-foreground">
                    {follow
                      ? 'Lifting your pen changes the music to match the page.'
                      : 'The music stays as you set it while you draw.'}
                  </p>
                </div>
                <Switch on={follow} onChange={onFollowChange} label="Follow my drawing" />
              </div>
            </section>

            <section>
              <Heading aside={`${tracks.length} of ${capabilities.maxPrompts}`}>Sounds</Heading>
              <TrackRack
                tracks={tracks}
                dispatch={dispatch}
                maxTracks={capabilities.maxPrompts}
                readOnly={readOnly}
              />
            </section>

            <Feel config={config} capabilities={capabilities} dispatch={dispatch} />
          </div>
        ) : (
          <ActionLog entries={log} />
        )}
      </div>

      {tab === 'mix' && (
        <form
          className="border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAsk || !ask.trim()) return;
            onAsk(ask.trim());
            setAsk('');
          }}
        >
          <div className="flex h-11 items-center gap-2 rounded-full bg-input pr-1 pl-4 focus-within:ring-2 focus-within:ring-ring/40">
            <input
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder={thinking ? 'Rewriting the mix…' : 'Ask for a change: “add a saxophone”'}
              aria-label="Ask the band for a change"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              aria-label="Send to the band"
              title="Gemini rewrites the mix"
              disabled={!canAsk || !ask.trim()}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
