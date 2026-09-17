import { Children } from 'react';
import { Scale } from '@google/genai';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { BACKEND_LABELS, type EngineCapabilities } from '../audio/engine';
import type { Action, Backend, MixConfig } from '../core/types';
import {
  PLANNER_CONFIGS,
  PLANNER_CONFIG_LIST,
  type PlannerConfigId,
} from '../llm/configs';
import { PLANNER_MODELS, type PlannerModel } from '../llm/planner';
import { ApiKeyField } from './ApiKeyField';

interface Props {
  config: MixConfig;
  capabilities: EngineCapabilities;
  dispatch: (action: Action) => void;
  /** Mirrors the header picker — switching here reconnects the same way. */
  backend: Backend;
  onBackendChange: (backend: Backend) => void;
  /** Keep a parent hover menu open while the scale select portal is active. */
  onSelectOpenChange?: (open: boolean) => void;
  autoInterpret: boolean;
  onAutoInterpretChange: (on: boolean) => void;
  abTest: boolean;
  onAbTestChange: (on: boolean) => void;
  /** Preference pairs saved so far — see src/lib/dataset.ts. */
  datasetCount: number;
  onExportDataset: () => void;
  plannerModel: PlannerModel;
  onPlannerModelChange: (model: PlannerModel) => void;
  plannerConfig: PlannerConfigId;
  onPlannerConfigChange: (config: PlannerConfigId) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onApiKeyCommit?: (key: string) => void;
}

const SCALE_LABELS: Record<string, string> = {
  [Scale.SCALE_UNSPECIFIED]: 'auto',
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

/**
 * A titled group. Returns null when every child was gated away by the active
 * backend's capabilities — otherwise Magenta would show an empty "sound"
 * heading, which reads as a bug rather than as a narrower instrument.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  if (!Children.toArray(children).length) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-[11px] tracking-wide text-muted-foreground/50 uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** Label above a control, the shape every non-slider setting uses. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        'flex h-9 items-center justify-between gap-3 rounded-full px-3 text-[13px]',
        'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
        on ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60',
      )}
    >
      {label}
      <span
        aria-hidden="true"
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full transition-colors',
          on ? 'bg-foreground text-background' : 'bg-muted text-transparent',
        )}
      >
        <Check className="size-3" strokeWidth={3.5} />
      </span>
    </button>
  );
}

function Knob({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-between text-[13px] text-muted-foreground">
        {label}
        <span className="text-foreground tabular-nums">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

export function ConfigPanel({
  config,
  capabilities,
  dispatch,
  backend,
  onBackendChange,
  onSelectOpenChange,
  autoInterpret,
  onAutoInterpretChange,
  abTest,
  onAbTestChange,
  datasetCount,
  onExportDataset,
  plannerModel,
  onPlannerModelChange,
  plannerConfig,
  onPlannerConfigChange,
  apiKey,
  onApiKeyChange,
  onApiKeyCommit,
}: Props) {
  const set = (patch: Partial<MixConfig>) => dispatch({ type: 'SET_CONFIG', config: patch });

  // Four groups instead of one column: the panel used to run taller than the
  // window, and a single list gave no hint that the sound knobs and the
  // planner settings are different kinds of thing.
  //
  // Only render what the active backend actually conditions on — a knob that
  // silently does nothing is worse than no knob. Magenta drops most of `sound`,
  // so the groups are independent grid cells rather than fixed columns; the
  // short ones simply take less room. (CSS multicol balanced better on paper
  // but fragmented a toggle across the column break.)
  return (
    <div className="grid grid-cols-1 items-start gap-x-7 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
      <Section title="model">
        <Field label="Gemini API key">
          <ApiKeyField value={apiKey} onChange={onApiKeyChange} onCommit={onApiKeyCommit} />
        </Field>
        <Field label="music model">
          <Select
            value={backend}
            onValueChange={(v) => onBackendChange(v as Backend)}
            onOpenChange={onSelectOpenChange}
          >
            <SelectTrigger aria-label="music model" title="switching reconnects">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(BACKEND_LABELS) as Backend[]).map((b) => (
                <SelectItem key={b} value={b}>
                  {BACKEND_LABELS[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {capabilities.scale && (
          <Field label="scale">
            <Select
              value={config.scale}
              onValueChange={(v) => set({ scale: v as Scale })}
              onOpenChange={onSelectOpenChange}
            >
              <SelectTrigger aria-label="scale">
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
          </Field>
        )}

        {(capabilities.muteBass || capabilities.muteDrums) && (
          <Field label="instruments">
            {capabilities.muteBass && (
              <Toggle label="bass" on={!config.muteBass} onChange={(on) => set({ muteBass: !on })} />
            )}
            {capabilities.muteDrums && (
              <Toggle
                label="drums"
                on={!config.muteDrums}
                onChange={(on) => set({ muteDrums: !on })}
              />
            )}
          </Field>
        )}
      </Section>

      <Section title="sound">
        {capabilities.bpm && (
          <Knob
            label="bpm"
            value={config.bpm}
            min={60}
            max={200}
            step={1}
            format={(n) => String(Math.round(n))}
            onChange={(bpm) => set({ bpm })}
          />
        )}
        {capabilities.density && (
          <Knob
            label="density"
            value={config.density}
            min={0}
            max={1}
            step={0.01}
            onChange={(density) => set({ density })}
          />
        )}
        {capabilities.brightness && (
          <Knob
            label="brightness"
            value={config.brightness}
            min={0}
            max={1}
            step={0.01}
            onChange={(brightness) => set({ brightness })}
          />
        )}
        {capabilities.guidance && (
          <Knob
            label="guidance"
            value={config.guidance}
            min={0}
            max={6}
            step={0.1}
            format={(n) => n.toFixed(1)}
            onChange={(guidance) => set({ guidance })}
          />
        )}
      </Section>

      <Section title="planner">
        <Field label="arranger">
          <Select
            value={plannerConfig}
            onValueChange={(v) => onPlannerConfigChange(v as PlannerConfigId)}
            onOpenChange={onSelectOpenChange}
          >
            <SelectTrigger aria-label="arranger strategy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLANNER_CONFIG_LIST.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[12px] leading-snug text-muted-foreground/70">
            {PLANNER_CONFIGS[plannerConfig].description}
          </p>
        </Field>

        <Field label="model">
          <Select
            value={plannerModel}
            onValueChange={(v) => onPlannerModelChange(v as PlannerModel)}
            onOpenChange={onSelectOpenChange}
          >
            <SelectTrigger aria-label="planner model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLANNER_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* Both of these are planner behaviour — when it runs, and whether it
            runs twice — so they belong to this group rather than a fourth one
            that would push the panel onto a second row. */}
        <div className="flex flex-col gap-1 pt-1">
          <Toggle label="auto interpret" on={autoInterpret} onChange={onAutoInterpretChange} />
          <Toggle label="A/B test" on={abTest} onChange={onAbTestChange} />
          <div className="flex items-center justify-between pl-3 text-[12px] text-muted-foreground/70">
            <span>
              {datasetCount} choice{datasetCount === 1 ? '' : 's'} saved
            </span>
            <Button size="sm" variant="ghost" disabled={!datasetCount} onClick={onExportDataset}>
              export
            </Button>
          </div>
        </div>
      </Section>
    </div>
  );
}
