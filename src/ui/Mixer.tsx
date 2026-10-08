import { useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Scale } from '@google/genai';
import NumberFlow, { type Format } from '@number-flow/react';
import { ArrowUp, ChevronDown, Drum, Guitar, Lock, LockOpen, X } from 'lucide-react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { EngineCapabilities } from '../audio/engine';
import { CALM, type Action, type ConfigLocks, type MixConfig, type Track } from '../core/types';
import type { Vibe } from '../vision/eyes';
import { ActionLog, type LogEntry } from './ActionLog';
import { TrackRack } from './TrackRack';
import { VibePicker } from './VibePicker';
import { MIXER_EASE, MixerReveal } from './mixer-motion';
import './mixer.css';

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
  /** Connection progress or an error; ordinary playback needs no status text. */
  status: ReactNode;
  /** The neutral audio meter beside the vibe name, only while audible. */
  activity: ReactNode;
  /** Play/pause lives with the selected vibe. */
  player: ReactNode;
  tracks: Track[];
  /** While an A/B choice is on the table the mix shown is a candidate, not yours to edit. */
  readOnly: boolean;
  dispatch: (action: Action) => void;
  config: MixConfig;
  configLocks: ConfigLocks;
  capabilities: EngineCapabilities;
  vibe: Vibe;
  vibes: Vibe[];
  onPickVibe: (vibe: Vibe) => void;
  canAsk: boolean;
  thinking: boolean;
  /** Why the last ask got no answer, if it didn't. */
  askError?: string | null;
  onAsk: (text: string) => void;
  log: LogEntry[];
}

/** Apple's quiet ease-out: quick to start, long to settle. */
const SETTLE = 'ease-[cubic-bezier(0.22,1,0.36,1)]';

/** A line that fades and folds in and out, keeping its last words while it goes. */
function FadeLine({ text, className }: { text: string | null | undefined; className?: string }) {
  const last = useRef(text);
  if (text) last.current = text;
  return (
    <div
      aria-hidden={!text}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none',
        SETTLE,
        text ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <p role={text ? 'alert' : undefined} className={cn('overflow-hidden', className)}>
        {last.current}
      </p>
    </div>
  );
}

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <h3 className="mb-2.5 flex items-baseline gap-2 px-1 text-[12px] font-medium text-muted-foreground">
      {children}
      {aside && <span className="ml-auto font-normal tabular-nums">{aside}</span>}
    </h3>
  );
}

/** A knob on its own card, with its two ends named so moving it says what it does. */
function Range({
  label,
  low,
  high,
  value,
  format,
  suffix,
  min = 0,
  max = 1,
  step = 0.01,
  hint,
  onChange,
  lockControl,
  disabled,
}: {
  label: string;
  low: string;
  high: string;
  value: number;
  /** How the readout writes the value; it rolls from one to the next. */
  format: Format;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  hint: string;
  onChange: (v: number) => void;
  lockControl: ReactNode;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card p-4" title={hint}>
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="font-medium">{label}</span>
        <div className="flex items-center gap-1">
          <NumberFlow
            value={value}
            format={format}
            suffix={suffix}
            className="text-[12px] text-muted-foreground tabular-nums"
          />
          {lockControl}
        </div>
      </div>
      <Slider
        disabled={disabled}
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

function ControlLock({ label, locked, onChange }: { label: string; locked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      aria-label={`${locked ? 'Unlock' : 'Lock'} ${label}`}
      aria-pressed={locked}
      title={
        locked
          ? `${label} is locked. You can still adjust it manually.`
          : `Keep ${label.toLowerCase()} fixed as the music changes`
      }
      onClick={onChange}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40',
        locked ? 'bg-secondary text-foreground' : 'text-muted-foreground/60 hover:text-foreground',
      )}
    >
      {locked ? <Lock className="size-3.5" aria-hidden="true" /> : <LockOpen className="size-3.5" aria-hidden="true" />}
    </button>
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
        'flex h-11 w-full min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-[13px] outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:shrink-0',
        on
          ? 'bg-primary text-primary-foreground'
          : 'bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** Every knob past the sounds, folded under one heading: the drawing and Gemini set them as it goes. */
function Advanced({
  config,
  configLocks,
  readOnly,
  capabilities: caps,
  dispatch,
}: {
  config: MixConfig;
  configLocks: ConfigLocks;
  readOnly: boolean;
  capabilities: EngineCapabilities;
  dispatch: (action: Action) => void;
}) {
  const set = (patch: Partial<MixConfig>) => dispatch({ type: 'SET_CONFIG', config: patch, source: 'user' });
  const lock = (field: keyof MixConfig, label: string) => (
    <ControlLock
      label={label}
      locked={configLocks[field] === true}
      onChange={() => dispatch({ type: 'SET_CONFIG_LOCK', field, locked: !configLocks[field] })}
    />
  );
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-1 rounded-lg px-1 py-1 text-[12px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Advanced
        <ChevronDown
          className={cn(
            'size-3.5 transition-transform duration-300 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <MixerReveal id={id} className="pt-1.5">
            <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-2">
              <p className="px-1 pb-1 text-[12px] text-muted-foreground">Lock a control to keep it as you draw.</p>
              {!caps.density && (
                <p className="px-1 text-[12px] leading-snug text-muted-foreground">
                  Magenta has fewer knobs than Lyria: no energy, brightness, tempo or key.
                </p>
              )}
              {caps.density && (
                <Range
                  label="Energy"
                  lockControl={lock('density', 'Energy')}
                  disabled={readOnly}
                  low="Still"
                  high="Flowing"
                  value={config.density}
                  format={{ style: 'percent' }}
                  hint="How many notes and beats the music plays"
                  onChange={(density) => set({ density })}
                />
              )}
              {caps.brightness && (
                <Range
                  label="Brightness"
                  lockControl={lock('brightness', 'Brightness')}
                  disabled={readOnly}
                  low="Mellow"
                  high="Bright"
                  value={config.brightness}
                  format={{ style: 'percent' }}
                  hint="Warm and muffled, or crisp and sparkly"
                  onChange={(brightness) => set({ brightness })}
                />
              )}
              {(caps.muteDrums || caps.muteBass || caps.scale) && (
                <div role="group" aria-label="Rhythm and key" className="grid auto-cols-fr grid-flow-col gap-2">
                  {caps.muteDrums && (
                    <div className="flex min-w-0 flex-col items-center gap-1">
                      <Chip on={!config.muteDrums} onChange={(on) => set({ muteDrums: !on })} icon={<Drum />}>
                        Drums
                      </Chip>
                      {lock('muteDrums', 'Drums')}
                    </div>
                  )}
                  {caps.muteBass && (
                    <div className="flex min-w-0 flex-col items-center gap-1">
                      <Chip on={!config.muteBass} onChange={(on) => set({ muteBass: !on })} icon={<Guitar />}>
                        Bass
                      </Chip>
                      {lock('muteBass', 'Bass')}
                    </div>
                  )}
                  {caps.scale && (
                    <div className="flex min-w-0 flex-col items-center gap-1">
                      <Select value={config.scale} onValueChange={(v) => set({ scale: v as Scale })}>
                        <SelectTrigger
                          aria-label="Key"
                          title={`Key: ${SCALE_LABELS[config.scale] ?? config.scale}`}
                          className="h-11 min-w-0 gap-1 rounded-xl bg-card px-2 text-[13px] transition-colors hover:bg-secondary [&>span:first-child]:truncate"
                        >
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
                      {lock('scale', 'Key')}
                    </div>
                  )}
                </div>
              )}
              {caps.bpm && (
                <Range
                  label="Tempo"
                  lockControl={lock('bpm', 'Tempo')}
                  disabled={readOnly}
                  low="Slow"
                  high="Fast"
                  value={config.bpm}
                  min={CALM.bpm[0]}
                  max={CALM.bpm[1]}
                  step={1}
                  format={{ maximumFractionDigits: 0 }}
                  suffix=" bpm"
                  hint="Beats per minute. Changing it restarts the music for a moment."
                  onChange={(bpm) => set({ bpm })}
                />
              )}
              {caps.guidance && (
                <Range
                  label="Follow the words"
                  lockControl={lock('guidance', 'Follow the words')}
                  disabled={readOnly}
                  low="Loose"
                  high="Strict"
                  value={config.guidance}
                  min={CALM.guidance[0]}
                  max={CALM.guidance[1]}
                  step={0.1}
                  format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                  hint="Loose wanders and surprises; strict sticks closely to each sound's words"
                  onChange={(guidance) => set({ guidance })}
                />
              )}
            </fieldset>
          </MixerReveal>
        )}
      </AnimatePresence>
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
  status,
  activity,
  player,
  tracks,
  readOnly,
  dispatch,
  config,
  configLocks,
  capabilities,
  vibe,
  vibes,
  onPickVibe,
  canAsk,
  thinking,
  askError,
  onAsk,
  log,
}: Props) {
  const [tab, setTab] = useState<'mix' | 'history'>('mix');
  const [choosingVibe, setChoosingVibe] = useState(false);
  const [ask, setAsk] = useState('');
  const reduceMotion = useReducedMotion();

  return (
    <div className="mixer-shell" data-open={open} inert={!open} aria-hidden={!open}>
      <aside aria-label="mixer" className="mixer-panel">
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
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.24, ease: MIXER_EASE }}
          >
            {tab === 'mix' ? (
              <div className="flex flex-col gap-6">
                {/* The selected music and its transport share one card. */}
                <section aria-label="Vibe" className="rounded-3xl bg-card p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[12px] font-medium text-muted-foreground">Vibe</p>
                    <button
                      type="button"
                      aria-expanded={choosingVibe}
                      onClick={() => setChoosingVibe((open) => !open)}
                      className="shrink-0 rounded-full bg-secondary px-3 py-1.5 text-[12px] font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      {choosingVibe ? 'Done' : 'Change vibe'}
                    </button>
                  </div>
                  <div className="mt-2 flex min-h-8 items-center gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <p className="truncate text-[1.0625rem] leading-snug font-semibold">{vibe.name}</p>
                      <span className="shrink-0">{activity}</span>
                    </div>
                    {player}
                  </div>
                  <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{vibe.blurb}</p>
                  <div
                    role="status"
                    className={cn('flex items-center gap-2 text-[12px] text-muted-foreground', status && 'mt-3')}
                  >
                    {status}
                  </div>
                  <AnimatePresence initial={false}>
                    {choosingVibe && (
                      <MixerReveal className="pt-3">
                        <VibePicker
                          vibes={vibes}
                          current={vibe.id}
                          onPick={(v) => {
                            onPickVibe(v);
                            setChoosingVibe(false);
                          }}
                        />
                      </MixerReveal>
                    )}
                  </AnimatePresence>
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

                <Advanced
                  config={config}
                  configLocks={configLocks}
                  readOnly={readOnly}
                  capabilities={capabilities}
                  dispatch={dispatch}
                />
              </div>
            ) : (
              <ActionLog entries={log} />
            )}
          </motion.div>
        </div>

        {tab === 'mix' && (
          <form
            className="border-t border-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (thinking || !canAsk || !ask.trim()) return;
              onAsk(ask.trim());
              setAsk('');
            }}
          >
            <FadeLine
              text={thinking ? null : askError}
              className="px-4 pb-2 text-[12px] leading-snug text-destructive"
            />
            <div
              aria-busy={thinking}
              className="relative flex h-11 items-center gap-2 rounded-full bg-input pr-1 pl-4 focus-within:ring-2 focus-within:ring-ring/40"
            >
              <input
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                disabled={thinking}
                placeholder={thinking ? '' : 'Ask for a change: “make it more chill”'}
                aria-label="Ask for a change"
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-default"
              />
              {/* While Gemini works the box rests, and its words shimmer in where the hint was. */}
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute inset-y-0 left-4 flex items-center text-[13px] transition-opacity duration-300 motion-reduce:transition-none',
                  SETTLE,
                  thinking ? 'opacity-100' : 'opacity-0',
                )}
              >
                <span className={thinking ? 'shimmer' : undefined}>Rewriting the mix…</span>
              </span>
              <button
                type="submit"
                aria-label="Send to Gemini"
                title="Gemini rewrites the mix"
                disabled={thinking || !canAsk || !ask.trim()}
                className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-30"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </form>
        )}
      </aside>
    </div>
  );
}
